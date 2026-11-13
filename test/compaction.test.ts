import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionHook } from "../src/compaction.js";
import defaultExtension from "../src/pi-compact.js";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT } from "../src/prompt.js";
import {
	commandHandler,
	compactEvent,
	compactHandler,
	fakeCtx,
	fakePi,
	scriptComplete,
	type FakeCtxOptions,
	type FakeCtxState,
} from "./fakes.js";

const CONFIGURED = { compaction: { model: "prov/mdl" } };
/** Never exists, so tests never read a real ~/.pi/agent/extensions/pi-compact.md. */
const MISSING_OVERRIDE = join(tmpdir(), `pi-compact-missing-${process.pid}`, "pi-compact.md");

function notifiedWith(state: FakeCtxState, pattern: RegExp): boolean {
	return state.notifications.some((notification) => pattern.test(notification.message));
}

function setup(
	options: {
		settings?: unknown;
		getRuntimeModel?: () => string | undefined;
		ctx?: FakeCtxOptions;
		promptOverridePath?: string;
	} = {}
) {
	const { pi, handlers } = fakePi({ settings: options.settings ?? CONFIGURED });
	registerCompactionHook(pi, options.getRuntimeModel ?? (() => undefined), {
		promptOverridePath: options.promptOverridePath ?? MISSING_OVERRIDE,
		retryDelaysMs: [0, 0],
	});
	const { ctx, state } = fakeCtx(options.ctx);
	return { handler: compactHandler(handlers), ctx, state };
}

describe("session_before_compact handler", () => {
	it("stays out of the way when no model is configured", async () => {
		const { handler, ctx, state } = setup({ settings: {} });

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("returns the summary and usage when completion succeeds", async () => {
		const stub = { reasoning: false };
		const { handler, ctx, state } = setup({ ctx: { model: stub } });
		const event = compactEvent();

		const result = await handler(event, ctx);

		assert.deepEqual(result, {
			compaction: {
				summary: "S",
				firstKeptEntryId: "e1",
				tokensBefore: 50_000,
				usage: { input: 1, output: 2 },
			},
		});
		assert.deepEqual(state.findCalls, [{ provider: "prov", modelId: "mdl" }]);
		assert.equal(state.streamCalls.length, 1);
		const call = state.streamCalls[0];
		assert.equal(call.model, stub);
		assert.equal(call.options.cacheRetention, "none");
		assert.equal(call.options.signal, event.signal);
		assert.equal(call.context.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
		assert.ok(call.context.messages[0].content[0].text.startsWith("<conversation>"));
	});

	it("warns and falls back when the configured model is unknown", async () => {
		const { handler, ctx, state } = setup({ ctx: { model: undefined } });

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /model "prov\/mdl" not found/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("warns and falls back when the completion rejects", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: async () => {
					throw new Error("boom");
				},
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /compaction failed \(boom\)/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("warns and falls back on an empty summary", async () => {
		const { handler, ctx, state } = setup({
			ctx: { complete: async () => ({ content: [{ type: "text", text: "   " }] }) },
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /empty summary/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("warns nothing when an aborted signal meets an empty summary", async () => {
		const controller = new AbortController();
		controller.abort();
		const { handler, ctx, state } = setup({ ctx: { complete: async () => ({ content: [] }) } });

		assert.equal(await handler(compactEvent({ signal: controller.signal }), ctx), undefined);
		assert.deepEqual(state.notifications, []);
		assert.equal(state.streamCalls.length, 1);
	});

	it("honours a runtime override of \"\" as off even when settings have a model", async () => {
		const { handler, ctx, state } = setup({ getRuntimeModel: () => "" });

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.deepEqual(state.findCalls, []);
		assert.equal(state.streamCalls.length, 0);
	});

	it("passes custom instructions through as Additional focus", async () => {
		const { handler, ctx, state } = setup();

		await handler(compactEvent({ customInstructions: "focus on tests" }), ctx);

		const text = state.streamCalls[0].context.messages[0].content[0].text;
		assert.ok(text.includes("<conversation>"));
		assert.ok(text.includes("Additional focus: focus on tests"));
	});

	it("warns about invalid settings even when nothing is intercepted", async () => {
		const { handler, ctx, state } = setup({ settings: { compaction: { model: 42 } } });

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /expected a string/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("retries a transient provider error and returns the summary on attempt 3", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([
					new Error("transient"),
					new Error("transient"),
					{ content: [{ type: "text", text: "Recovered" }] },
				]),
			},
		});

		const result = await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls.length, 3);
		assert.deepEqual(state.notifications, []);
		assert.ok(result?.compaction);
		assert.equal(result.compaction.summary, "Recovered");
	});

	it("warns and falls back after the retries are exhausted", async () => {
		const { handler, ctx, state } = setup({ ctx: { complete: scriptComplete([new Error("boom")]) } });

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 3);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /compaction failed \(boom\)/);
	});

	it("retries a provider error returned as stopReason error and recovers", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([
					{ content: [], stopReason: "error", errorMessage: "overloaded" },
					{ content: [], stopReason: "error", errorMessage: "overloaded" },
					{ content: [{ type: "text", text: "Recovered" }] },
				]),
			},
		});

		const result = await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls.length, 3);
		assert.deepEqual(state.notifications, []);
		assert.equal(result?.compaction?.summary, "Recovered");
	});

	it("surfaces the real provider error after retries of stopReason error", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([
					{ content: [], stopReason: "error", errorMessage: "rate limited by provider" },
				]),
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 3);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /rate limited by provider/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("does not retry a truncated summary (stopReason length)", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([{ content: [{ type: "text", text: "partial" }], stopReason: "length" }]),
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 1);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /truncated/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("stays quiet when the provider reports stopReason aborted", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: async () => ({
					content: [{ type: "text", text: "partial" }],
					stopReason: "aborted",
					usage: { input: 1, output: 2 },
				}),
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 1);
		assert.deepEqual(state.notifications, []);
	});

	it("stops retrying silently when the signal aborts mid-retry", async () => {
		const controller = new AbortController();
		const { handler, ctx, state } = setup({
			ctx: {
				complete: async () => {
					controller.abort();
					throw new Error("boom");
				},
			},
		});

		assert.equal(await handler(compactEvent({ signal: controller.signal }), ctx), undefined);
		assert.equal(state.streamCalls.length, 1);
		assert.deepEqual(state.notifications, []);
	});

	it("treats a summary that attempts a tool call as a failure", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: async () => ({
					content: [{ type: "toolCall" }, { type: "text", text: "S" }],
				}),
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 1);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /attempted a tool call/);
		assert.equal(state.notifications[0].level, "warning");
	});

	it("propagates thinkingLevel as reasoning for reasoning models", async () => {
		const { handler, ctx, state } = setup({
			ctx: { model: { reasoning: true }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls[0].options.reasoning, "high");
	});

	it("omits the reasoning option when thinkingLevel is unset", async () => {
		const { handler, ctx, state } = setup({ ctx: { model: { reasoning: true } } });

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("sends a non-empty sessionId", async () => {
		const { handler, ctx, state } = setup();

		await handler(compactEvent(), ctx);

		const { sessionId } = state.streamCalls[0].options;
		assert.equal(typeof sessionId, "string");
		assert.ok(sessionId && sessionId.length > 0);
	});

	it("uses the native prompt and stays quiet when the override path is missing", async () => {
		const { handler, ctx, state } = setup({ promptOverridePath: MISSING_OVERRIDE });

		const result = await handler(compactEvent(), ctx);

		assert.ok(result);
		assert.deepEqual(state.notifications, []);
		const call = state.streamCalls[0];
		assert.equal(call.context.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
		assert.ok(call.context.messages[0].content[0].text.includes(SUMMARIZATION_PROMPT));
	});
});

describe("/pi-compact command", () => {
	function setupCommand(settings: unknown) {
		const { pi, handlers, commands } = fakePi({ settings });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ model: { reasoning: false } });
		return {
			run: (args: string) => run(args, ctx as unknown as ExtensionCommandContext),
			handler: compactHandler(handlers),
			ctx,
			state,
		};
	}

	it("opens the model picker with the model status in its title", async () => {
		const { run, state } = setupCommand({});

		await run("");

		// The prompt-status line is still notified; the model status moved into the title.
		assert.ok(notifiedWith(state, /prompt: native/));
		assert.equal(state.selectCalls.length, 1);
		assert.match(state.selectCalls[0].title, /not configured/);
		assert.deepEqual(state.selectCalls[0].items, ["off — pi default compaction"]);
		// Cancelling the picker leaves no state change.
		assert.equal(state.streamCalls.length, 0);
	});

	it("prints text status when there is no UI", async () => {
		const { pi, commands } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ hasUI: false, model: { reasoning: false } });
		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (message?: string) => {
			if (typeof message === "string") logged.push(message);
		};
		try {
			await run("", ctx as unknown as ExtensionCommandContext);
		} finally {
			console.log = originalLog;
		}

		assert.deepEqual(state.notifications, []);
		assert.deepEqual(state.selectCalls, []);
		assert.ok(logged.some((line) => /not configured/.test(line)));
		assert.ok(logged.some((line) => /prompt: native/.test(line)));
	});

	it("picker selection sets the session override", async () => {
		const { pi, handlers, commands } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({
			model: { reasoning: false },
			scopedModels: [
				{ model: { provider: "prov", id: "mdl" } },
				{ model: { provider: "other", id: "m2" } },
			],
			select: (_title, items) => items[0],
		});

		await run("", ctx as unknown as ExtensionCommandContext);

		assert.deepEqual(state.selectCalls[0].items, ["prov/mdl", "other/m2", "off — pi default compaction"]);
		assert.ok(notifiedWith(state, /will use prov\/mdl/));

		// The selection intercepts the next compaction.
		const result = await compactHandler(handlers)(compactEvent(), ctx);
		assert.ok(result?.compaction);
		assert.deepEqual(state.findCalls.at(-1), { provider: "prov", modelId: "mdl" });
	});

	it("picker marks the active model and offers off", async () => {
		const { pi, handlers, commands } = fakePi({ settings: CONFIGURED });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({
			model: { reasoning: false },
			scopedModels: [{ model: { provider: "prov", id: "mdl" } }],
			select: (_title, items) => items[items.length - 1],
		});

		await run("", ctx as unknown as ExtensionCommandContext);

		assert.deepEqual(state.selectCalls[0].items, ["● prov/mdl", "off — pi default compaction"]);
		assert.ok(notifiedWith(state, /disabled for this session/));
		assert.equal(await compactHandler(handlers)(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("disables interception for the session on \"off\"", async () => {
		const { run, handler, ctx, state } = setupCommand(CONFIGURED);

		await run("off");
		assert.ok(notifiedWith(state, /disabled for this session/));

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("sets a validated session override that intercepts compaction", async () => {
		const { run, handler, ctx, state } = setupCommand({});

		await run("prov/mdl");
		assert.ok(notifiedWith(state, /will use prov\/mdl/));

		const result = await handler(compactEvent(), ctx);
		assert.ok(result?.compaction);
		assert.equal(state.streamCalls.length, 1);
		assert.deepEqual(state.findCalls.at(-1), { provider: "prov", modelId: "mdl" });
	});

	it("rejects an unknown model without changing session state", async () => {
		const { run, handler, ctx, state } = setupCommand({});

		await run("badmodel");
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /model "badmodel" not found/);
		assert.equal(state.notifications[0].level, "error");

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("rejects a registry miss without changing session state", async () => {
		const { pi, handlers, commands } = fakePi({ settings: CONFIGURED });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const rejected = fakeCtx({ model: undefined });

		await run("prov/missing", rejected.ctx as unknown as ExtensionCommandContext);

		assert.deepEqual(rejected.state.findCalls, [{ provider: "prov", modelId: "missing" }]);
		assert.equal(rejected.state.notifications.length, 1);
		assert.match(rejected.state.notifications[0].message, /model "prov\/missing" not found/);
		assert.equal(rejected.state.notifications[0].level, "error");

		// The rejected spec was not recorded: settings (prov/mdl) still intercept.
		const accepted = fakeCtx({ model: { reasoning: false } });
		const result = await compactHandler(handlers)(compactEvent(), accepted.ctx);
		assert.ok(result?.compaction);
		assert.equal(accepted.state.streamCalls.length, 1);
		assert.deepEqual(accepted.state.findCalls, [{ provider: "prov", modelId: "mdl" }]);
	});
});

describe("entry opts reach the hook and status", () => {
	async function withOverrideFile(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), "pi-compact-override-"));
		const overridePath = join(dir, "pi-compact.md");
		await writeFile(overridePath, "Custom focus: keep exact file paths.");
		return overridePath;
	}

	it("surfaces invalid-settings warnings in status", async () => {
		const { pi, commands } = fakePi({ settings: { compaction: { model: 123 } } });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ model: { reasoning: false } });

		await run("", ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(state, /expected a string/));
		// The model status ("not configured") now lives in the picker title.
		assert.equal(state.selectCalls.length, 1);
		assert.match(state.selectCalls[0].title, /not configured/);
	});

	it("reports the native prompt when no override file exists", async () => {
		const { pi, commands } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ model: { reasoning: false } });

		await run("", ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(state, /prompt: native/));
	});

	it("builds the prompt from the entry's promptOverridePath", async () => {
		const overridePath = await withOverrideFile();
		try {
			const { pi, handlers, commands } = fakePi({ settings: CONFIGURED });
			defaultExtension(pi, { promptOverridePath: overridePath, retryDelaysMs: [0, 0] });
			const { ctx, state } = fakeCtx({ model: { reasoning: false } });

			// Status reflects the injected file.
			await commandHandler(commands, "pi-compact")("", ctx as unknown as ExtensionCommandContext);
			assert.ok(notifiedWith(state, /prompt: override file/));

			// The hook builds the summary prompt from the injected file, not the native one.
			const result = await compactHandler(handlers)(compactEvent(), ctx);
			assert.ok(result?.compaction);
			const promptText = state.streamCalls[0].context.messages[0].content[0].text;
			assert.ok(promptText.includes("Custom focus: keep exact file paths."));
			assert.ok(!promptText.includes(SUMMARIZATION_PROMPT));
		} finally {
			await rm(join(overridePath, ".."), { recursive: true, force: true });
		}
	});

	it("threads retryDelaysMs from the entry into retries", async () => {
		const { pi, handlers } = fakePi({ settings: CONFIGURED });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE, retryDelaysMs: [0, 0] });
		const { ctx, state } = fakeCtx({
			model: { reasoning: false },
			complete: scriptComplete([
				new Error("boom"),
				new Error("boom"),
				{ content: [{ type: "text", text: "S" }], usage: { input: 1, output: 2 } },
			]),
		});

		// The default 1s/2s backoff would take ~3s for two retries; injected [0, 0]
		// must keep the whole run far below that, which only holds if the entry
		// actually threads the delays through to withRetries.
		const startedAt = Date.now();
		const result = await compactHandler(handlers)(compactEvent(), ctx);
		const elapsedMs = Date.now() - startedAt;

		assert.ok(result?.compaction);
		assert.equal(state.streamCalls.length, 3);
		assert.ok(elapsedMs < 1_000, `expected injected zero delays, took ${elapsedMs}ms`);
	});
});
