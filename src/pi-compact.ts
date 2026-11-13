import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactionHook, resolveModel } from "./compaction.js";
import { loadPromptOverride, PROMPT_OVERRIDE_PATH } from "./prompt.js";
import { readConfig } from "./settings.js";

type NotifyLevel = "info" | "warning" | "error";

const OFF_ITEM = "off — pi default compaction";

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
 * The hook intercepts compaction; this extension only adds a `/pi-compact`
 * command to inspect status and set a per-session model override.
 */
export default function (
	pi: ExtensionAPI,
	opts?: { promptOverridePath?: string; retryDelaysMs?: number[] },
) {
	// Session runtime override: undefined = follow settings compaction.model,
	// "" = off (pi's default compaction), otherwise "provider/modelId".
	let runtimeModel: string | undefined;

	pi.on("session_start", () => {
		runtimeModel = undefined;
	});

	registerCompactionHook(pi, () => runtimeModel, {
		promptOverridePath: opts?.promptOverridePath,
		retryDelaysMs: opts?.retryDelaysMs,
	});

	pi.registerCommand("pi-compact", {
		description: "Configure pi-compact compaction model",
		handler: async (args, ctx) => {
			const say = (msg: string, level: NotifyLevel = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};

			const trimmed = args.trim();

			if (trimmed === "") {
				const { config, warnings } = readConfig(pi.getSettings());
				for (const warning of warnings) say(warning, "warning");
				const configured = config.model;
				const current = runtimeModel === "" ? "off (default compaction)" : runtimeModel || configured || "not configured";

				const override = await loadPromptOverride(opts?.promptOverridePath);
				if (override.warning) say(override.warning, "warning");
				else if (override.text) {
					say(`pi-compact prompt: override file (${opts?.promptOverridePath ?? PROMPT_OVERRIDE_PATH})`, "info");
				}
				else say("pi-compact prompt: native", "info");

				if (!ctx.hasUI) {
					say(`pi-compact model: ${current}`, "info");
					return;
				}

				// Interactive: a picker mirroring pi's model list; Esc/cancel keeps
				// the current state. The title carries the model status.
				const items = pickerModelSpecs(ctx).map((spec) => (spec === (runtimeModel || configured) ? `● ${spec}` : spec));
				items.push(runtimeModel === "" ? `● ${OFF_ITEM}` : OFF_ITEM);
				const choice = await ctx.ui.select(`pi-compact compaction model — current: ${current}`, items);
				if (choice === undefined) return;
				const spec = choice.replace(/^● /, "");
				if (spec.startsWith("off")) {
					runtimeModel = "";
					say("pi-compact disabled for this session (default compaction)", "info");
					return;
				}
				if (!resolveModel(spec, ctx.modelRegistry)) {
					say(`pi-compact: model "${spec}" not found`, "error");
					return;
				}
				runtimeModel = spec;
				say(`pi-compact will use ${spec} for this session`, "info");
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
