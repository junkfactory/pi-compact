import assert from "node:assert/strict";
import { DEFAULT_COMPACTION_SETTINGS } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionBeforeCompactResult,
} from "@earendil-works/pi-coding-agent";

/** Only the `streamSimple()` surface the hook and tests touch; the real types are far wider. */
export type FakeChatContext = {
	systemPrompt?: string;
	messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
};

export type FakeChatOptions = {
	signal?: AbortSignal;
	cacheRetention?: string;
	sessionId?: string;
	reasoning?: string;
};

/** The `AssistantMessage` fields the hook reads, with inert defaults for the rest. */
export type FakeCompletion = {
	content: Array<{ type: string; text?: string }>;
	usage?: { input: number; output: number };
	stopReason?: string;
	errorMessage?: string;
};

export type FakeComplete = (
	model: unknown,
	context: FakeChatContext,
	options: FakeChatOptions
) => Promise<FakeCompletion>;

export type FakeCtxOptions = {
	hasUI?: boolean;
	thinkingLevel?: string;
	/** Stub returned by `modelRegistry.find`; pass `undefined` to simulate an unknown model. */
	model?: unknown;
	complete?: FakeComplete;
};

export type FakeCtxState = {
	notifications: Array<{ message: string; level: string | undefined }>;
	findCalls: Array<{ provider: string; modelId: string }>;
	streamCalls: Array<{ model: unknown; context: FakeChatContext; options: FakeChatOptions }>;
};

async function defaultComplete(): Promise<FakeCompletion> {
	return {
		content: [{ type: "text", text: "S" }],
		usage: { input: 1, output: 2 },
		stopReason: "stop",
	};
}

/**
 * Playback fake: each `streamSimple().result()` call consumes the next step.
 * `Error` steps reject (for retry tests); message steps resolve. Once the script
 * runs out the last step repeats.
 */
export function scriptComplete(steps: Array<FakeCompletion | Error>): FakeComplete {
	assert.ok(steps.length > 0, "scriptComplete needs at least one step");
	let i = 0;
	return async () => {
		const step = steps[Math.min(i, steps.length - 1)];
		i += 1;
		if (step instanceof Error) throw step;
		return { stopReason: "stop", ...step };
	};
}

/** Minimal ExtensionContext double: notifications recorder, model registry, no-op UI. */
export function fakeCtx(options: FakeCtxOptions = {}) {
	// `model` may be deliberately undefined (unknown-model case), so probe the key.
	const model = "model" in options ? options.model : { reasoning: false };
	const complete = options.complete ?? defaultComplete;
	const state: FakeCtxState = { notifications: [], findCalls: [], streamCalls: [] };

	const modelRegistry = {
		find(provider: string, modelId: string) {
			state.findCalls.push({ provider, modelId });
			return model;
		},
		streamSimple(m: unknown, context: FakeChatContext, opts: FakeChatOptions) {
			state.streamCalls.push({ model: m, context, options: opts });
			return { result: () => complete(m, context, opts) };
		},
	};

	const ctx = {
		hasUI: options.hasUI ?? true,
		thinkingLevel: options.thinkingLevel,
		ui: {
			notify(message: string, level?: string) {
				state.notifications.push({ message, level });
			},
		},
		modelRegistry,
	};

	return { ctx: ctx as unknown as ExtensionContext, state };
}

export type FakeHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export type FakeCommand = {
	description?: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
};

/** Registers are the whole ExtensionAPI surface pi-compact uses. */
export function fakePi(options: { settings?: unknown } = {}) {
	const state = { settings: options.settings };
	const handlers = new Map<string, FakeHandler>();
	const commands = new Map<string, FakeCommand>();

	const pi = {
		on(event: string, handler: FakeHandler) {
			handlers.set(event, handler);
			return () => {
				handlers.delete(event);
			};
		},
		registerCommand(name: string, command: FakeCommand) {
			commands.set(name, command);
		},
		getSettings() {
			return state.settings;
		},
	};

	return { pi: pi as unknown as ExtensionAPI, state, handlers, commands };
}

export type CompactHandler = (
	event: SessionBeforeCompactEvent,
	ctx: ExtensionContext
) => Promise<SessionBeforeCompactResult | undefined>;

export function compactHandler(handlers: Map<string, FakeHandler>): CompactHandler {
	const handler = handlers.get("session_before_compact");
	assert.ok(handler, "no session_before_compact handler registered");
	return async (event, ctx) => (await handler(event, ctx)) as SessionBeforeCompactResult | undefined;
}

export function commandHandler(commands: Map<string, FakeCommand>, name: string): FakeCommand["handler"] {
	const command = commands.get(name);
	assert.ok(command, `command "${name}" not registered`);
	return command.handler;
}

export type CompactEventOverrides = {
	preparation?: Partial<SessionBeforeCompactEvent["preparation"]>;
	customInstructions?: string;
	reason?: SessionBeforeCompactEvent["reason"];
	willRetry?: boolean;
	signal?: AbortSignal;
};

/**
 * `isSplitTurn`/`fileOps`/`settings` are required by the event type but never read
 * by the hook, so they stay at inert defaults.
 */
export function compactEvent(overrides: CompactEventOverrides = {}): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			tokensBefore: 50_000,
			firstKeptEntryId: "e1",
			previousSummary: undefined,
			isSplitTurn: false,
			fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
			settings: DEFAULT_COMPACTION_SETTINGS,
			...overrides.preparation,
		},
		branchEntries: [],
		customInstructions: overrides.customInstructions,
		reason: overrides.reason ?? "manual",
		willRetry: overrides.willRetry ?? false,
		signal: overrides.signal ?? new AbortController().signal,
	};
}
