import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionHook } from "../src/compaction.js";
import defaultExtension from "../src/pi-compact.js";
import { savePermanentSetting } from "../src/settings-write.js";
import { SUMMARIZATION_PROMPT, SUMMARIZATION_SYSTEM_PROMPT } from "../src/prompt.js";
import {
	commandHandler,
	compactEvent,
	compactHandler,
	fakeCtx,
	fakePi,
	renderCard,
	scriptComplete,
	sessionCompactHandler,
	summaryCardRenderer,
	type FakeCtxOptions,
	type FakeCtxState,
} from "./fakes.js";

const CONFIGURED = { compaction: { model: "prov/mdl" } };
/** Never exists, so tests never read a real ~/.pi/agent/extensions/pi-compact.md. */
const MISSING_OVERRIDE = join(tmpdir(), `pi-compact-missing-${process.pid}`, "pi-compact.md");
/** Scratch path for `/pi-compact prompt` save tests; tests clear it before use. */
const PROMPT_DIR = join(tmpdir(), `pi-compact-prompt-${process.pid}`);
const PROMPT_PATH = join(PROMPT_DIR, "override.md");
/** Scratch agent dir for permanent-save tests; tests clear it before use. */
const AGENT_DIR = join(tmpdir(), `pi-compact-agent-${process.pid}`);
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

function notifiedWith(state: FakeCtxState, pattern: RegExp): boolean {
	return state.notifications.some((notification) => pattern.test(notification.message));
}

function setup(
	options: {
		settings?: unknown;
		getRuntimeModel?: () => string | undefined;
		getRuntimeThinking?: () => string | undefined;
		ctx?: FakeCtxOptions;
		promptOverridePath?: string;
	} = {}
) {
	const { pi, handlers, state: piState } = fakePi({ settings: options.settings ?? CONFIGURED });
	registerCompactionHook(pi, options.getRuntimeModel ?? (() => undefined), {
		promptOverridePath: options.promptOverridePath ?? MISSING_OVERRIDE,
		retryDelaysMs: [0, 0],
		getRuntimeThinking: options.getRuntimeThinking,
	});
	const { ctx, state } = fakeCtx(options.ctx);
	return {
		handler: compactHandler(handlers),
		sessionCompact: sessionCompactHandler(handlers),
		ctx,
		state,
		entries: piState.entries as Array<{ customType: string; data?: unknown }>,
	};
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
		assert.ok(notifiedWith(state, /summary via prov\/mdl \(1 → 2 tokens\)/));
		assert.equal(state.notifications.find((n) => /summary via/.test(n.message))?.level, "info");
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

	it("retries an empty summary and returns the summary on the next attempt", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([
					{ content: [{ type: "text", text: "   " }] },
					{ content: [{ type: "text", text: "Recovered" }] },
				]),
			},
		});

		const result = await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls.length, 2);
		assert.ok(notifiedWith(state, /summary via prov\/mdl/));
		assert.equal(result?.compaction?.summary, "Recovered");
	});

	it("warns and falls back when every attempt returns an empty summary", async () => {
		const { handler, ctx, state } = setup({
			ctx: {
				complete: scriptComplete([{ content: [{ type: "text", text: "   " }] }]),
			},
		});

		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 3);
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /compaction failed \(empty summary\)/);
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
		// No usage in the scripted response, so the confirmation carries no token counts.
		assert.ok(notifiedWith(state, /summary via prov\/mdl/));
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

	it("retries a provider error returned as stopReason error and recovers, confirming via notify", async () => {
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
		assert.ok(notifiedWith(state, /summary via prov\/mdl/));
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

	it("defaults to high reasoning for reasoning models, ignoring the session thinking level", async () => {
		const { handler, sessionCompact, ctx, state, entries } = setup({
			ctx: { model: { reasoning: true }, thinkingLevel: "low" },
		});

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: true });

		assert.equal(state.streamCalls[0].options.reasoning, "high");
		assert.equal((entries[0].data as { thinking?: string }).thinking, "high");
	});

	it("uses the configured compaction.thinking as reasoning", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "low" } },
			ctx: { model: { reasoning: true }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls[0].options.reasoning, "low");
	});

	it("follows the session thinking level when compaction.thinking is auto", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "auto" } },
			ctx: { model: { reasoning: true }, thinkingLevel: "medium" },
		});

		await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls[0].options.reasoning, "medium");
	});

	it("omits the reasoning option when thinking is auto and the session level is off", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "auto" } },
			ctx: { model: { reasoning: true }, thinkingLevel: "off" },
		});

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("omits the reasoning option when thinking is auto and the session level is unset", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "auto" } },
			ctx: { model: { reasoning: true } },
		});

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("omits the reasoning option when compaction.thinking is off", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "off" } },
			ctx: { model: { reasoning: true }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("omits the reasoning option for non-reasoning models regardless of thinking config", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "high" } },
			ctx: { model: { reasoning: false }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("session thinking override beats the settings value", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "high" } },
			getRuntimeThinking: () => "low",
			ctx: { model: { reasoning: true }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls[0].options.reasoning, "low");
	});

	it("an empty session thinking override forces reasoning off for the session", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "high" } },
			getRuntimeThinking: () => "",
			ctx: { model: { reasoning: true }, thinkingLevel: "high" },
		});

		await handler(compactEvent(), ctx);

		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("a session thinking override of auto follows the session thinking level", async () => {
		const { handler, ctx, state } = setup({
			settings: { compaction: { model: "prov/mdl", thinking: "high" } },
			getRuntimeThinking: () => "auto",
			ctx: { model: { reasoning: true }, thinkingLevel: "medium" },
		});

		await handler(compactEvent(), ctx);

		assert.equal(state.streamCalls[0].options.reasoning, "medium");
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
		// Success is confirmed, not silent: exactly the one info notification.
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /summary via prov\/mdl/);
		const call = state.streamCalls[0];
		assert.equal(call.context.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
		assert.ok(call.context.messages[0].content[0].text.includes(SUMMARIZATION_PROMPT));
	});
});

describe("summary card entry", () => {
	it("appends a card naming the model when pi accepts the extension compaction", async () => {
		const { handler, sessionCompact, ctx, entries } = setup();

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: true });

		assert.equal(entries.length, 1);
		assert.equal(entries[0].customType, "pi-compact");
		assert.deepEqual(entries[0].data, {
			model: "prov/mdl",
			prompt: "native",
			thinking: "off",
			usage: { input: 1, output: 2 },
		});
	});

	it("marks the card when the override prompt was used", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		mkdirSync(PROMPT_DIR, { recursive: true });
		writeFileSync(PROMPT_PATH, "my override", "utf-8");
		const { handler, sessionCompact, ctx, entries } = setup({ promptOverridePath: PROMPT_PATH });

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: true });

		assert.equal(entries[0].data && (entries[0].data as { prompt: string }).prompt, "override");
	});

	it("appends nothing for native compactions", async () => {
		const { handler, sessionCompact, ctx, entries } = setup();

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: false });

		assert.deepEqual(entries, []);
	});

	it("appends nothing when the hook fell back and never delivered a summary", async () => {
		const { handler, sessionCompact, ctx, entries } = setup({ settings: {} });

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: true });

		assert.deepEqual(entries, []);
	});

	it("consumes the card on the first accepted compaction only", async () => {
		const { handler, sessionCompact, ctx, entries } = setup();

		await handler(compactEvent(), ctx);
		sessionCompact({ fromExtension: true });
		sessionCompact({ fromExtension: true });

		assert.equal(entries.length, 1);
	});
});

describe("summary card renderer", () => {
	it("registers under the pi-compact entry type", () => {
		const { pi, state } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });

		assert.ok(state.entryRenderers instanceof Map);
		assert.ok(state.entryRenderers.has("pi-compact"));
	});

	it("renders the model and token counts", () => {
		const { pi, state } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const lines = renderCard(summaryCardRenderer(state.entryRenderers), {
			model: "opencode-go/beam-free",
			prompt: "native",
			thinking: "high",
			usage: { input: 9_347, output: 4_692 },
		});

		assert.match(lines.join("\n"), /pi-compact: summary via opencode-go\/beam-free @ high effort \(9,347 → 4,692 tokens\)/);
	});

	it("omits token counts when usage is missing", () => {
		const { pi, state } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const lines = renderCard(summaryCardRenderer(state.entryRenderers), {
			model: "prov/mdl",
			prompt: "native",
		});

		assert.match(lines.join("\n"), /pi-compact: summary via prov\/mdl\s*\n/);
	});

	it("omits the effort segment when thinking was off", () => {
		const { pi, state } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const lines = renderCard(summaryCardRenderer(state.entryRenderers), {
			model: "prov/mdl",
			prompt: "native",
			thinking: "off",
		});

		assert.match(lines.join("\n"), /pi-compact: summary via prov\/mdl\s*\n/);
		assert.ok(!lines.join("\n").includes("effort"));
	});

	it("renders nothing for a card without a model", () => {
		const { pi, state } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const lines = renderCard(summaryCardRenderer(state.entryRenderers), {});

		assert.deepEqual(lines, []);
	});
});

describe("/pi-compact command", () => {
	function setupCommand(settings: unknown, ctxOptions: FakeCtxOptions = {}, promptPath = MISSING_OVERRIDE, agentDir?: string) {
		const { pi, handlers, commands } = fakePi({ settings });
		defaultExtension(pi, { promptOverridePath: promptPath, agentDir });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ model: { reasoning: false }, ...ctxOptions });
		return {
			run: (args: string) => run(args, ctx as unknown as ExtensionCommandContext),
			handler: compactHandler(handlers),
			commands,
			ctx,
			state,
		};
	}

	it("bare invocation shows the status without a picker", async () => {
		const { run, state } = setupCommand({});

		await run("");

		// pi's status line replaces the previous notify, so the whole status
		// must arrive as one multi-line message.
		assert.equal(state.notifications.length, 1);
		assert.match(state.notifications[0].message, /pi-compact model: not configured\n/);
		assert.match(state.notifications[0].message, /pi-compact thinking: high \(default\)\n/);
		assert.match(state.notifications[0].message, /\n?pi-compact prompt: native/);
		assert.equal(state.notifications[0].level, "info");
		assert.equal(state.customCalls.length, 0);
	});

	it("bare status carries settings warnings in its single message at warning level", async () => {
		const { run, state } = setupCommand({ compaction: { model: 123 } });

		await run("");

		assert.equal(state.notifications.length, 1);
		assert.equal(state.notifications[0].level, "warning");
		assert.match(state.notifications[0].message, /expected a string/);
		assert.match(state.notifications[0].message, /pi-compact model/);
	});

	it("opens the model picker with the model status in its title", async () => {
		const { run, state } = setupCommand({}, { customKeys: ["\x1b"] });

		await run("model");

		// The prompt-status line is still notified; the model status moved into the title.
		assert.ok(notifiedWith(state, /prompt: native/));
		assert.equal(state.customCalls.length, 1);
		assert.match(state.customCalls[0].render(100).join("\n"), /not configured/);
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
		assert.deepEqual(state.customCalls, []);
		assert.ok(logged.some((line) => /not configured/.test(line)));
		assert.ok(logged.some((line) => /prompt: native/.test(line)));
		assert.ok(logged.some((line) => /pi-compact thinking: high \(default\)/.test(line)));
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
			customKeys: ["\r"],
		});

		await run("model", ctx as unknown as ExtensionCommandContext);

		const rendered = state.customCalls[0].render(100).join("\n");
		assert.match(rendered, /prov\/mdl/);
		assert.match(rendered, /other\/m2/);
		assert.match(rendered, /off — pi default compaction/);
		assert.ok(notifiedWith(state, /will use prov\/mdl for this session/));

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
			customKeys: ["\x1b[B", "\r"],
		});

		await run("model", ctx as unknown as ExtensionCommandContext);

		// "prov/mdl" is active (settings model) and the off entry is selectable.
		const rendered = state.customCalls[0].render(100).join("\n");
		assert.match(rendered, /prov\/mdl \(active\)/);
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

	it("ctrl+s saves the selection to settings and applies this session", async () => {
		rmSync(AGENT_DIR, { recursive: true, force: true });
		mkdirSync(AGENT_DIR, { recursive: true });
		const { run, handler, ctx, state } = setupCommand(
			{},
			{ scopedModels: [{ model: { provider: "prov", id: "mdl" } }, { model: { provider: "other", id: "m2" } }], customKeys: ["\x13"] },
			MISSING_OVERRIDE,
			AGENT_DIR,
		);

		await run("model");

		assert.deepEqual(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")), { compaction: { model: "prov/mdl" } });
		assert.ok(notifiedWith(state, /will use prov\/mdl \(saved to settings/));

		// Applies to the current session immediately.
		const result = await handler(compactEvent(), ctx);
		assert.ok(result?.compaction);
		assert.deepEqual(state.findCalls.at(-1), { provider: "prov", modelId: "mdl" });
	});

	it("ctrl+s on the off entry removes compaction.model from settings", async () => {
		rmSync(AGENT_DIR, { recursive: true, force: true });
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(SETTINGS_PATH, JSON.stringify({ defaultModel: "keep", compaction: { reserveTokens: 100, model: "prov/mdl" } }), "utf-8");
		const { run, handler, ctx, state } = setupCommand(
			CONFIGURED,
			{ scopedModels: [{ model: { provider: "prov", id: "mdl" } }], customKeys: ["\x1b[B", "\x13"] },
			MISSING_OVERRIDE,
			AGENT_DIR,
		);

		await run("model");

		// Only compaction.model is removed; sibling keys are preserved.
		assert.deepEqual(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")), { defaultModel: "keep", compaction: { reserveTokens: 100 } });
		assert.ok(notifiedWith(state, /disabled \(settings updated/));

		// Session is off: settings never intercept.
		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("completes the thinking subcommand", () => {
		const { commands } = setupCommand({});
		const completions = commands.get("pi-compact")?.getArgumentCompletions?.("") ?? [];
		assert.ok(completions.some((item) => item.value === "thinking"));
	});

	it("thinking picker selection sets the session override", async () => {
		const { run, handler, ctx, state } = setupCommand(CONFIGURED, {
			model: { reasoning: true },
			thinkingLevel: "high",
			customKeys: ["\x1b[B", "\x1b[B", "\x1b[B", "\r"],
		});

		await run("thinking");

		const rendered = state.customCalls[0].render(100).join("\n");
		assert.match(rendered, /pi-compact thinking — current: high \(default\)/);
		assert.match(rendered, /auto/);
		assert.ok(notifiedWith(state, /will think at low for this session/));

		// The override intercepts the next compaction with low reasoning.
		await handler(compactEvent(), ctx);
		assert.equal(state.streamCalls[0].options.reasoning, "low");
	});

	it("thinking picker off disables reasoning for the session", async () => {
		const { run, handler, ctx, state } = setupCommand(CONFIGURED, {
			model: { reasoning: true },
			customKeys: ["\x1b[B", "\r"],
		});

		await run("thinking");

		assert.ok(notifiedWith(state, /thinking off for this session/));

		// Compaction is still intercepted, but without the reasoning option.
		await handler(compactEvent(), ctx);
		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("thinking picker escape leaves the session state unchanged", async () => {
		const { run, handler, ctx, state } = setupCommand(CONFIGURED, {
			model: { reasoning: true },
			customKeys: ["\x1b"],
		});

		await run("thinking");

		await handler(compactEvent(), ctx);
		assert.equal(state.streamCalls[0].options.reasoning, "high");
	});

	it("thinking picker marks high active when nothing is configured", async () => {
		const { run, state } = setupCommand({}, { customKeys: ["\x1b"] });

		await run("thinking");

		assert.match(state.customCalls[0].render(100).join("\n"), /high \(active\)/);
	});

	it("session_start clears the session thinking override", async () => {
		const { pi, handlers, commands } = fakePi({ settings: CONFIGURED });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({
			model: { reasoning: true },
			customKeys: ["\x1b[B", "\x1b[B", "\x1b[B", "\r"],
		});
		const handler = compactHandler(handlers);

		await run("thinking", ctx as unknown as ExtensionCommandContext);
		await handler(compactEvent(), ctx);
		assert.equal(state.streamCalls[0].options.reasoning, "low");

		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart, "no session_start handler registered");
		await sessionStart({ type: "session_start" }, ctx);
		await handler(compactEvent(), ctx);
		assert.equal(state.streamCalls[1].options.reasoning, "high");
	});

	it("thinking ctrl+s saves the selection to settings and applies this session", async () => {
		rmSync(AGENT_DIR, { recursive: true, force: true });
		mkdirSync(AGENT_DIR, { recursive: true });
		const { run, handler, ctx, state } = setupCommand(
			CONFIGURED,
			{ model: { reasoning: true }, thinkingLevel: "medium", customKeys: ["\x13"] },
			MISSING_OVERRIDE,
			AGENT_DIR,
		);

		await run("thinking");

		// The scratch settings file starts empty, so only thinking is written;
		// sibling-key preservation is covered by the savePermanentSetting tests.
		assert.deepEqual(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")), {
			compaction: { thinking: "auto" },
		});
		assert.ok(notifiedWith(state, /will think at auto \(saved to settings/));

		// Applies to the current session immediately; "auto" follows the
		// session's thinking level.
		await handler(compactEvent(), ctx);
		assert.equal(state.streamCalls[0].options.reasoning, "medium");
	});

	it("thinking ctrl+s on the off entry persists compaction.thinking as off", async () => {
		rmSync(AGENT_DIR, { recursive: true, force: true });
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(SETTINGS_PATH, JSON.stringify({ defaultModel: "keep", compaction: { reserveTokens: 100, thinking: "low" } }), "utf-8");
		const { run, handler, ctx, state } = setupCommand(
			CONFIGURED,
			{ model: { reasoning: true }, customKeys: ["\x1b[B", "\x13"] },
			MISSING_OVERRIDE,
			AGENT_DIR,
		);

		await run("thinking");

		// "off" is a valid persisted level; only compaction.thinking is replaced.
		assert.deepEqual(JSON.parse(readFileSync(SETTINGS_PATH, "utf-8")), {
			defaultModel: "keep",
			compaction: { reserveTokens: 100, thinking: "off" },
		});
		assert.ok(notifiedWith(state, /thinking off \(settings updated/));

		await handler(compactEvent(), ctx);
		assert.ok(!("reasoning" in state.streamCalls[0].options));
	});

	it("prints the thinking status when there is no UI", async () => {
		const { run, state } = setupCommand(CONFIGURED, { hasUI: false });
		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (message?: string) => {
			if (typeof message === "string") logged.push(message);
		};
		try {
			await run("thinking");
		} finally {
			console.log = originalLog;
		}

		assert.deepEqual(state.notifications, []);
		assert.deepEqual(state.customCalls, []);
		assert.ok(logged.some((line) => /pi-compact thinking: high \(default\)/.test(line)));
	});

	it("prints the configured thinking level in the model status when there is no UI", async () => {
		const { pi, commands } = fakePi({ settings: { compaction: { model: "prov/mdl", thinking: "low" } } });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ hasUI: false, model: { reasoning: false } });
		const logged: string[] = [];
		const originalLog = console.log;
		console.log = (message?: string) => {
			if (typeof message === "string") logged.push(message);
		};
		try {
			await run("model", ctx as unknown as ExtensionCommandContext);
		} finally {
			console.log = originalLog;
		}

		assert.deepEqual(state.customCalls, []);
		assert.ok(logged.some((line) => /pi-compact thinking: low$/.test(line)));
		assert.ok(!logged.some((line) => /pi-compact thinking: high/.test(line)));
	});

	it("marks the off entry active in the thinking picker when the session is off", async () => {
		const { pi, handlers, commands } = fakePi({ settings: { compaction: { model: "prov/mdl", thinking: "low" } } });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const turnOff = fakeCtx({ model: { reasoning: true }, customKeys: ["\x1b[B", "\r"] });
		await run("thinking", turnOff.ctx as unknown as ExtensionCommandContext);

		const reopened = fakeCtx({ model: { reasoning: true }, customKeys: ["\x1b"] });
		await run("thinking", reopened.ctx as unknown as ExtensionCommandContext);

		const rendered = reopened.state.customCalls[0].render(100).join("\n");
		assert.match(rendered, /off \(active\)/);
		assert.doesNotMatch(rendered, /low \(active\)/);
		// The title reports the session-off state with the settings fallback.
		assert.match(rendered, /current: off \(default low\)/);

		// Reopening the picker in the session-off state leaves reasoning off.
		await compactHandler(handlers)(compactEvent(), reopened.ctx);
		assert.ok(!("reasoning" in reopened.state.streamCalls[0].options));
	});

	it("reports the effective fallback when the session thinking is off", async () => {
		const { pi, commands } = fakePi({ settings: { compaction: { model: "prov/mdl", thinking: "low" } } });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const turnOff = fakeCtx({ model: { reasoning: true }, customKeys: ["\x1b[B", "\r"] });
		await run("thinking", turnOff.ctx as unknown as ExtensionCommandContext);

		const status = fakeCtx({ model: { reasoning: true } });
		await run("", status.ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(status.state, /pi-compact thinking: off \(default low\)/));
	});

	it("reports off with the built-in default when no settings thinking is configured", async () => {
		const { pi, commands } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const turnOff = fakeCtx({ model: { reasoning: true }, customKeys: ["\x1b[B", "\r"] });
		await run("thinking", turnOff.ctx as unknown as ExtensionCommandContext);

		const status = fakeCtx({ model: { reasoning: true } });
		await run("", status.ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(status.state, /pi-compact thinking: off \(default high\)/));
	});

	it("reports an error when the settings file is malformed", async () => {
		rmSync(AGENT_DIR, { recursive: true, force: true });
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(SETTINGS_PATH, "{not json", "utf-8");
		const { run, handler, ctx, state } = setupCommand(
			{},
			{ scopedModels: [{ model: { provider: "prov", id: "mdl" } }], customKeys: ["\x13"] },
			MISSING_OVERRIDE,
			AGENT_DIR,
		);

		await run("model");

		assert.ok(notifiedWith(state, /could not read .*settings\.json/));
		assert.equal(state.notifications.find((n) => /could not read/.test(n.message))?.level, "error");
		// Nothing was set: no session override, no compaction interception.
		assert.equal(await handler(compactEvent(), ctx), undefined);
		assert.equal(state.streamCalls.length, 0);
	});

	it("completes the subcommands", () => {
		const { commands } = setupCommand({});
		const completions = commands.get("pi-compact")?.getArgumentCompletions?.("");

		assert.deepEqual(
			completions?.map((item) => item.value),
			["model", "thinking", "prompt", "prompt reset", "off"],
		);
		// No match yields no completions.
		assert.equal(commands.get("pi-compact")?.getArgumentCompletions?.("zzz"), null);
	});

	it("opens the picker on the model subcommand", async () => {
		const { run, state } = setupCommand(
			{},
			{ scopedModels: [{ model: { provider: "prov", id: "mdl" } }], customKeys: ["\x1b"] },
		);

		await run("model");

		assert.equal(state.customCalls.length, 1);
		const rendered = state.customCalls[0].render(100).join("\n");
		assert.match(rendered, /prov\/mdl/);
		assert.match(rendered, /off — pi default compaction/);
	});

	it("prompt opens the editor with a template and saves the result", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		const { run, state } = setupCommand({}, { editor: (_title, prefill) => prefill?.replace("-->", "edited -->") }, PROMPT_PATH);

		await run("prompt");

		assert.equal(state.editorCalls.length, 1);
		assert.match(state.editorCalls[0].prefill ?? "", /pi-compact prompt override/);
		assert.ok(existsSync(PROMPT_PATH), "override file written");
		assert.match(readFileSync(PROMPT_PATH, "utf-8"), /edited -->/);
		assert.ok(notifiedWith(state, /saved .*applies on the next compaction/));
	});

	it("prompt prefills the existing file and saves edits", async () => {
		mkdirSync(PROMPT_DIR, { recursive: true });
		writeFileSync(PROMPT_PATH, "existing prompt", "utf-8");
		const { run, state } = setupCommand({}, { editor: () => "existing prompt, edited" }, PROMPT_PATH);

		await run("prompt");

		assert.equal(state.editorCalls[0].prefill, "existing prompt");
		assert.equal(readFileSync(PROMPT_PATH, "utf-8"), "existing prompt, edited");
		assert.ok(notifiedWith(state, /saved/));
	});

	it("prompt reset removes the override file", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		mkdirSync(PROMPT_DIR, { recursive: true });
		writeFileSync(PROMPT_PATH, "my override", "utf-8");
		const { run, state } = setupCommand({}, {}, PROMPT_PATH);

		await run("prompt reset");

		assert.ok(!existsSync(PROMPT_PATH), "override file removed");
		assert.ok(notifiedWith(state, /removed .*native prompt/));
	});

	it("prompt reset without a file says so", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		const { run, state } = setupCommand({}, {}, PROMPT_PATH);

		await run("prompt reset");

		assert.ok(notifiedWith(state, /no override file/));
	});

	it("prompt warns when the saved override is blank", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		const { run, state } = setupCommand({}, { editor: () => "   " }, PROMPT_PATH);

		await run("prompt");

		assert.ok(existsSync(PROMPT_PATH));
		assert.ok(notifiedWith(state, /blank override is ignored/));
		assert.equal(state.notifications.find((n) => /blank/.test(n.message))?.level, "warning");
	});

	it("prompt cancel writes nothing", async () => {
		rmSync(PROMPT_DIR, { recursive: true, force: true });
		const { run, state } = setupCommand({}, {}, PROMPT_PATH);

		await run("prompt");

		assert.equal(state.editorCalls.length, 1);
		assert.ok(!existsSync(PROMPT_PATH), "no file written on cancel");
		assert.ok(notifiedWith(state, /cancelled/));
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
		const { ctx, state } = fakeCtx({ model: { reasoning: false }, customKeys: ["\x1b"] });

		await run("model", ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(state, /expected a string/));
		// The model status ("not configured") now lives in the picker title.
		assert.equal(state.customCalls.length, 1);
		assert.match(state.customCalls[0].render(100).join("\n"), /not configured/);
	});

	it("reports the native prompt when no override file exists", async () => {
		const { pi, commands } = fakePi({ settings: {} });
		defaultExtension(pi, { promptOverridePath: MISSING_OVERRIDE });
		const run = commandHandler(commands, "pi-compact");
		const { ctx, state } = fakeCtx({ model: { reasoning: false }, customKeys: ["\x1b"] });

		await run("", ctx as unknown as ExtensionCommandContext);

		assert.ok(notifiedWith(state, /prompt: native/));
	});

	it("builds the prompt from the entry's promptOverridePath", async () => {
		const overridePath = await withOverrideFile();
		try {
			const { pi, handlers, commands } = fakePi({ settings: CONFIGURED });
			defaultExtension(pi, { promptOverridePath: overridePath, retryDelaysMs: [0, 0] });
			const { ctx, state } = fakeCtx({ model: { reasoning: false }, customKeys: ["\x1b"] });

			// Status reflects the injected file.
			await commandHandler(commands, "pi-compact")("", ctx as unknown as ExtensionCommandContext);
			assert.ok(notifiedWith(state, new RegExp(`prompt: ${overridePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)));

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

describe("savePermanentSetting", () => {
	function freshAgentDir(): string {
		const dir = join(tmpdir(), `pi-compact-save-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		return dir;
	}

	it("creates compaction.model in a missing settings file", () => {
		const agentDir = freshAgentDir();

		const result = savePermanentSetting("model", "prov/mdl", agentDir);

		assert.deepEqual(result, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), {
			compaction: { model: "prov/mdl" },
		});
	});

	it("preserves existing settings and removes the model on empty spec", () => {
		const agentDir = freshAgentDir();
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultModel: "keep", compaction: { reserveTokens: 100, model: "old/mdl" } }),
			"utf-8",
		);

		const setResult = savePermanentSetting("model", "new/mdl", agentDir);
		assert.deepEqual(setResult, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), {
			defaultModel: "keep",
			compaction: { reserveTokens: 100, model: "new/mdl" },
		});

		const clearResult = savePermanentSetting("model", "", agentDir);
		assert.deepEqual(clearResult, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), {
			defaultModel: "keep",
			compaction: { reserveTokens: 100 },
		});
	});

	it("writes and clears compaction.thinking while preserving compaction.model", () => {
		const agentDir = freshAgentDir();
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { model: "prov/mdl" } }), "utf-8");

		const setResult = savePermanentSetting("thinking", "low", agentDir);
		assert.deepEqual(setResult, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), {
			compaction: { model: "prov/mdl", thinking: "low" },
		});

		const clearResult = savePermanentSetting("thinking", "", agentDir);
		assert.deepEqual(clearResult, { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")), {
			compaction: { model: "prov/mdl" },
		});
	});

	it("reports an error instead of writing on malformed settings", () => {
		const agentDir = freshAgentDir();
		writeFileSync(join(agentDir, "settings.json"), "{oops", "utf-8");

		const result = savePermanentSetting("model", "prov/mdl", agentDir);

		assert.equal(result.ok, false);
		assert.match(result.error, /could not read/);
		assert.equal(readFileSync(join(agentDir, "settings.json"), "utf-8"), "{oops");
	});
});
