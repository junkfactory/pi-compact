import type { EntryRenderer, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, type SelectItem } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { registerCompactionHook, resolveModel, SUMMARY_ENTRY_TYPE, type SummaryCardData } from "./compaction.js";
import { pickModel } from "./picker.js";
import { loadPromptOverride, PROMPT_OVERRIDE_PATH } from "./prompt.js";
import { readConfig, THINKING_LEVELS } from "./settings.js";
import { savePermanentSetting } from "./settings-write.js";

type NotifyLevel = "info" | "warning" | "error";

/**
 * Durable transcript card: rendered right under pi's `[compaction]` block for
 * every summary pi-compact produced, and persisted in the session file.
 */
const summaryCardRenderer: EntryRenderer<SummaryCardData> = (entry, _options, theme) => {
	const data = entry.data;
	if (!data?.model) return undefined;
	const effort = data.thinking && data.thinking !== "off" ? ` @ ${data.thinking} effort` : "";
	const tokens = data.usage ? ` (${fmtTokens(data.usage.input)} → ${fmtTokens(data.usage.output)} tokens)` : "";
	return new Text(theme.fg("dim", `pi-compact: summary via ${data.model}${effort}${tokens}`));
};

function fmtTokens(n: number): string {
	return n.toLocaleString("en-US");
}

const OFF_ITEM = "off";
const OFF_LABEL = "off — pi default compaction";
const PROMPT_EDITOR_TITLE = "pi-compact prompt override";
const PROMPT_TEMPLATE =
	"<!-- pi-compact prompt override.\n" +
	"     Replaces pi's native compaction prompt entirely for the configured model.\n" +
	"     Saving an empty file falls back to the native prompt (a warning notifies you). -->\n\n";

/**
 * Model specs offered by the picker: session-scoped models when the session has
 * scoping (mirrors pi's built-in /model picker), otherwise every available model.
 */
function pickerModelSpecs(ctx: { scopedModels: readonly { model: { provider: string; id: string } }[]; modelRegistry: { getAvailable(): { provider: string; id: string }[] } }): string[] {
	const models = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
	return [...new Set(models.map((model) => `${model.provider}/${model.id}`))];
}

/**
 * pi-compact entry point.
 *
 * The hook intercepts compaction; this extension adds a `/pi-compact` command
 * to pick the session model, edit the prompt override, and disable interception.
 */
export default function (
	pi: ExtensionAPI,
	opts?: { promptOverridePath?: string; retryDelaysMs?: number[]; agentDir?: string },
) {
	// Session runtime override: undefined = follow settings compaction.model,
	// "" = off (pi's default compaction), otherwise "provider/modelId".
	let runtimeModel: string | undefined;
	// Session runtime thinking: undefined = follow settings compaction.thinking
	// (default high), "" = off (no reasoning), otherwise a thinking level.
	let runtimeThinking: string | undefined;
	const promptPath = opts?.promptOverridePath ?? PROMPT_OVERRIDE_PATH;
	const agentDir = opts?.agentDir ?? getAgentDir();

	pi.on("session_start", () => {
		runtimeModel = undefined;
		runtimeThinking = undefined;
	});

	registerCompactionHook(pi, () => runtimeModel, {
		promptOverridePath: promptPath,
		retryDelaysMs: opts?.retryDelaysMs,
		getRuntimeThinking: () => runtimeThinking,
	});

	pi.registerEntryRenderer(SUMMARY_ENTRY_TYPE, summaryCardRenderer);

	pi.registerCommand("pi-compact", {
		description: "Configure pi-compact compaction model and prompt",
		// Only subcommands are completed here; model specs are offered by the
		// picker, which has registry access via the command context.
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "model", label: "model", description: "pick the compaction model" },
				{ value: "thinking", label: "thinking", description: "pick the summarizer thinking effort" },
				{ value: "prompt", label: "prompt", description: "edit the prompt override" },
				{ value: "prompt reset", label: "prompt reset", description: "remove the override, back to native" },
				{ value: "off", label: "off", description: "use pi's default compaction" },
			];
			const remaining = items.filter((item) => item.value.startsWith(prefix));
			return remaining.length > 0 ? remaining : null;
		},
		handler: async (args, ctx) => {
			const say = (msg: string, level: NotifyLevel = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			// Effective thinking effort for display: session override wins, then
			// settings, then the built-in default.
			const thinkingCurrent = (configured?: string) =>
				runtimeThinking === "" ? `off (default ${configured ?? "high"})` : runtimeThinking || configured || "high (default)";

			const trimmed = args.trim();

			if (trimmed === "") {
				// Bare invocation: a status display, no picker. pi's status line
				// shows only the latest notify, so all lines go out as one message.
				const { config, warnings } = readConfig(pi.getSettings());
				const current = runtimeModel === "" ? "off (default compaction)" : runtimeModel || config.model || "not configured";

				const override = await loadPromptOverride(promptPath);
				const promptLine = override.warning
					? override.warning
					: override.text
						? `pi-compact prompt: ${promptPath}`
						: "pi-compact prompt: native";
				say(
					[
						...warnings,
						`pi-compact model: ${current}`,
						`pi-compact thinking: ${thinkingCurrent(config.thinking)}`,
						promptLine,
					].join("\n"),
					warnings.length > 0 || override.warning ? "warning" : "info",
				);
				return;
			}

			if (trimmed === "model") {
				const { config, warnings } = readConfig(pi.getSettings());
				for (const warning of warnings) say(warning, "warning");
				const configured = config.model;
				const current = runtimeModel === "" ? "off (default compaction)" : runtimeModel || configured || "not configured";

				const override = await loadPromptOverride(promptPath);
				if (override.warning) say(override.warning, "warning");
				else if (override.text) say(`pi-compact prompt: ${promptPath}`, "info");
				else say("pi-compact prompt: native", "info");

				if (!ctx.hasUI) {
					say(`pi-compact model: ${current}`, "info");
					say(`pi-compact thinking: ${thinkingCurrent(config.thinking)}`, "info");
					return;
				}

				// Interactive: a picker mirroring pi's model list; Esc/cancel keeps
				// the current state. The title carries the model status.
				const active = runtimeModel || configured;
				const items: SelectItem[] = pickerModelSpecs(ctx).map((spec) => ({
					value: spec,
					label: spec === active && runtimeModel !== "" ? `${spec} (active)` : spec,
				}));
				items.push({ value: OFF_ITEM, label: runtimeModel === "" ? `${OFF_LABEL} (active)` : OFF_LABEL });
				const choice = await pickModel(ctx, items, `pi-compact compaction model — current: ${current}`);
				if (choice === undefined) return;

				if (choice.permanent) {
					const result = savePermanentSetting("model", choice.spec === OFF_ITEM ? "" : choice.spec, agentDir);
					if (!result.ok) {
						say(`pi-compact: ${result.error}`, "error");
						return;
					}
				}

				if (choice.spec === OFF_ITEM) {
					runtimeModel = "";
					say(
						choice.permanent
							? "pi-compact disabled (settings updated; default compaction)"
							: "pi-compact disabled for this session (default compaction)",
						"info",
					);
					return;
				}

				if (!resolveModel(choice.spec, ctx.modelRegistry)) {
					say(`pi-compact: model "${choice.spec}" not found`, "error");
					return;
				}
				runtimeModel = choice.spec;
				say(
					choice.permanent
						? `pi-compact will use ${choice.spec} (saved to settings, applies immediately)`
						: `pi-compact will use ${choice.spec} for this session`,
					"info",
					);
				return;
			}

			if (trimmed === "thinking") {
				const { config, warnings } = readConfig(pi.getSettings());
				for (const warning of warnings) say(warning, "warning");
				const current = thinkingCurrent(config.thinking);

				if (!ctx.hasUI) {
					say(`pi-compact thinking: ${current}`, "info");
					return;
				}

				// Interactive: the same picker the model branch uses; Esc/cancel
				// keeps the current state. The title carries the effort status.
				const active = runtimeThinking === "" ? "off" : runtimeThinking || config.thinking || "high";
				const items: SelectItem[] = THINKING_LEVELS.map((level) => ({
					value: level,
					label: level === active ? `${level} (active)` : level,
				}));
				const choice = await pickModel(ctx, items, `pi-compact thinking — current: ${current}`);
				if (choice === undefined) return;

				if (choice.permanent) {
					// "off" is a valid persisted level (readConfig accepts it), so it is
				// written literally — only the model field uses "" = unset.
				const result = savePermanentSetting("thinking", choice.spec, agentDir);
					if (!result.ok) {
						say(`pi-compact: ${result.error}`, "error");
						return;
					}
				}

				if (choice.spec === "off") {
					runtimeThinking = "";
					say(
						choice.permanent
							? "pi-compact thinking off (settings updated; the summarizer runs without reasoning)"
							: "pi-compact thinking off for this session",
						"info",
					);
					return;
				}

				runtimeThinking = choice.spec;
				say(
					choice.permanent
						? `pi-compact will think at ${choice.spec} (saved to settings, applies immediately)`
						: `pi-compact will think at ${choice.spec} for this session`,
					"info",
				);
				return;
			}

			if (trimmed === "prompt reset") {
				const existed = existsSync(promptPath);
				rmSync(promptPath, { force: true });
				say(
					existed
						? `pi-compact prompt: removed ${promptPath} — the native prompt is used from the next compaction`
						: `pi-compact prompt: no override file at ${promptPath}`,
					"info",
				);
				return;
			}

			if (trimmed === "prompt") {
				if (!ctx.hasUI) {
					console.log(`pi-compact prompt: editing requires an interactive UI; edit ${promptPath} directly`);
					return;
				}
				let existing: string | undefined;
				try {
					existing = readFileSync(promptPath, "utf-8");
				} catch {
					existing = undefined; // Missing or unreadable: start from the template.
				}
				const text = await ctx.ui.editor(PROMPT_EDITOR_TITLE, existing ?? PROMPT_TEMPLATE);
				if (text === undefined) {
					ctx.ui.notify("pi-compact prompt: cancelled — file unchanged", "info");
					return;
				}
				mkdirSync(dirname(promptPath), { recursive: true });
				writeFileSync(promptPath, text, "utf-8");
				if (text.trim() === "") {
					ctx.ui.notify(`pi-compact prompt: saved ${promptPath} — blank override is ignored; the native prompt is used`, "warning");
				} else {
					ctx.ui.notify(`pi-compact prompt: saved ${promptPath} — applies on the next compaction`, "info");
				}
				return;
			}

			if (trimmed === "off") {
				runtimeModel = "";
				say("pi-compact disabled for this session (default compaction)", "info");
				return;
			}

			if (!resolveModel(trimmed, ctx.modelRegistry)) {
				say(`pi-compact: model "${trimmed}" not found`, "error");
				return;
			}

			runtimeModel = trimmed;
			say(`pi-compact will use ${trimmed} for this session`, "info");
		},
	});
}
