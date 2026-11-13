import type { CompactionResult, ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import { uuidv7 } from "@earendil-works/pi-ai";
import { buildSummaryMessages, loadPromptOverride } from "./prompt.js";
import { readConfig } from "./settings.js";

/**
 * Resolves a `"provider/modelId"` spec against the model registry. Splits on the
 * FIRST "/" so model IDs that themselves contain "/" (e.g. OpenRouter, Ollama)
 * keep working. Returns undefined for specs without a non-empty provider and ID.
 */
export function resolveModel(
	spec: string,
	modelRegistry: { find(provider: string, modelId: string): unknown },
): unknown | undefined {
	const i = spec.indexOf("/");
	if (i <= 0 || i === spec.length - 1) return undefined;
	return modelRegistry.find(spec.slice(0, i), spec.slice(i + 1));
}

/** Model and request-option shapes are derived from the registry so no `any` is needed. */
type ChatModel = Parameters<ModelRegistry["streamSimple"]>[0];
type ChatOptions = NonNullable<Parameters<ModelRegistry["streamSimple"]>[2]>;

const RETRY_DELAYS_MS = [1_000, 2_000];

/** An error carrying `nonRetryable` truthy is rethrown without another attempt. */
type RetryableError = Error & { nonRetryable?: boolean };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `run` once per entry in `retryDelaysMs`, sleeping that delay between
 * attempts. Only thrown errors are retried; a resolved response is returned
 * as-is, and an error marked `nonRetryable` rethrows at once without sleeping.
 * Abort checks bracket each sleep, so a signal that fires during a sleep is
 * observed only after that sleep resolves. Returns undefined when the signal
 * aborts mid-retry.
 */
async function withRetries<T>(
	run: () => Promise<T>,
	signal: AbortSignal,
	retryDelaysMs: number[],
): Promise<T | undefined> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await run();
		} catch (error) {
			if ((error as RetryableError).nonRetryable) throw error;
			if (attempt >= retryDelaysMs.length) throw error;
			if (signal.aborted) return undefined;
			await sleep(retryDelaysMs[attempt]);
			if (signal.aborted) return undefined;
		}
	}
}

/** Data appended as a custom entry after a successful pi-compact summary. */
export interface SummaryCardData {
	model: string;
	prompt: "native" | "override";
	usage?: { input: number; output: number };
}

/** Custom-entry type the transcript renderer picks up; see registerEntryRenderer. */
export const SUMMARY_ENTRY_TYPE = "pi-compact";

/**
 * Registers the `session_before_compact` handler. It intercepts every compaction
 * path (manual, threshold, overflow). Any problem — no model configured, unknown
 * model, empty summary, provider error, abort — returns undefined so pi's default
 * compaction runs instead.
 *
 * After a successful interception it stashes which model produced the summary
 * and, when `session_compact` confirms pi accepted the extension-provided entry,
 * appends a durable `pi-compact` custom entry to the session so the transcript
 * shows exactly which model ran (surviving pi's compaction re-render).
 *
 * `getRuntimeModel` returns the session override: undefined follows settings,
 * "" disables interception, anything else is a "provider/modelId" spec.
 */
export function registerCompactionHook(
	pi: ExtensionAPI,
	getRuntimeModel: () => string | undefined,
	opts?: { promptOverridePath?: string; retryDelaysMs?: number[] },
): void {
	const retryDelaysMs = opts?.retryDelaysMs ?? RETRY_DELAYS_MS;
	let lastSummary: SummaryCardData | undefined;

	pi.on("session_compact", (event) => {
		// Only claim compactions pi actually took from us; a stale stash from a
		// hook whose compaction never landed must never be attributed.
		if (!event.fromExtension || !lastSummary) return;
		pi.appendEntry(SUMMARY_ENTRY_TYPE, lastSummary);
		lastSummary = undefined;
	});
	pi.on("session_before_compact", async (event, ctx) => {
		const runtime = getRuntimeModel();
		const { config, warnings } = readConfig(pi.getSettings());

		// Warn about invalid settings before any early return, so a bad
		// `compaction.model` is reported even when nothing is intercepted.
		if (ctx.hasUI) {
			for (const warning of warnings) ctx.ui.notify(warning, "warning");
		}

		const spec = runtime === "" ? undefined : runtime || config.model;
		if (spec === undefined) return undefined;
		lastSummary = undefined;

		const model = resolveModel(spec, ctx.modelRegistry);
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`pi-compact: model "${spec}" not found, using default compaction`, "warning");
			return undefined;
		}
		lastSummary = undefined;

		try {
			const conversationText = serializeConversation(
				convertToLlm([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages]),
			);

			const override = await loadPromptOverride(opts?.promptOverridePath);
			if (override.warning && ctx.hasUI) ctx.ui.notify(override.warning, "warning");
			lastSummary = { model: spec, prompt: override.text ? "override" : "native" };

			const messages = buildSummaryMessages({
				conversationText,
				previousSummary: event.preparation.previousSummary,
				customInstructions: event.customInstructions,
				overridePrompt: override.text,
			});

			const chatModel = model as ChatModel;
			const thinkingLevel = ctx.thinkingLevel;
			const options: ChatOptions = {
				signal: event.signal,
				cacheRetention: "none",
				sessionId: uuidv7(),
			};
			if (chatModel.reasoning && thinkingLevel && thinkingLevel !== "off") {
				options.reasoning = thinkingLevel;
			}

			const response = await withRetries(
				async () => {
					const message = await ctx.modelRegistry.streamSimple(chatModel, messages, options).result();
					// An aborted request is not a failure: fall back silently to pi's default compaction.
					if (message.stopReason === "aborted") return undefined;
					// Provider failures resolve as a message with stopReason "error"; rethrow so
					// the retry path handles them and the real provider text is surfaced.
					if (message.stopReason === "error") {
						throw new Error(message.errorMessage || "provider error");
					}
					// A truncated summary must never become a checkpoint, and retrying cannot help.
					if (message.stopReason === "length") {
						const truncated: RetryableError = new Error("summary output truncated (stopReason length)");
						truncated.nonRetryable = true;
						throw truncated;
					}
					return message;
				},
				event.signal,
				retryDelaysMs,
			);
			if (!response) {
				lastSummary = undefined;
				return undefined;
			}

			// Mirror pi's native behavior: a summary that tries to call tools is a failure.
			if (response.content.some((block) => block.type === "toolCall")) {
				if (ctx.hasUI) {
					ctx.ui.notify("pi-compact: summary request attempted a tool call, using default compaction", "warning");
				}
				return undefined;
			}

			const summary = response.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");

			if (summary.trim() === "") {
				if (!event.signal.aborted && ctx.hasUI) {
					ctx.ui.notify("pi-compact: empty summary, using default compaction", "warning");
				}
				return undefined;
			}

			const compaction: CompactionResult = {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
			};
			if (response.usage) {
				compaction.usage = response.usage;
				lastSummary = { ...lastSummary, usage: { input: response.usage.input, output: response.usage.output } };
			}

			// Immediate confirmation that this compaction ran through the configured
			// model (visible in RPC clients; the durable card covers the transcript).
			if (ctx.hasUI) {
				const tokens = response.usage ? ` (${response.usage.input} → ${response.usage.output} tokens)` : "";
				ctx.ui.notify(`pi-compact: summary via ${spec}${tokens}`, "info");
			}

			return { compaction };
		} catch (error) {
			lastSummary = undefined;
			if (!event.signal.aborted && ctx.hasUI) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`pi-compact: compaction failed (${message}), using default compaction`, "warning");
			}
			return undefined;
		}
	});
}
