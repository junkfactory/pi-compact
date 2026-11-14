/**
 * Reads pi-compact's settings from pi's settings object.
 *
 * pi-compact extends pi's native `compaction` settings object with `model`
 * (which summarizer model to use) and `thinking` (summarizer thinking effort,
 * independent of the session's chat thinking level). Only those fields are
 * read here; every other field under `compaction` belongs to pi and is
 * ignored.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface CompactConfig {
	model?: string;
	thinking?: ThinkingLevel;
}

/** Thinking effort levels pi accepts, shared with the session's levels. */
const THINKING_LEVELS: ReadonlySet<ThinkingLevel> = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

const WARN_NOT_OBJECT = "pi-compact: ignoring settings.compaction (expected an object)";
const WARN_MODEL_NOT_STRING = "pi-compact: ignoring compaction.model (expected a string)";
const WARN_THINKING_NOT_STRING = "pi-compact: ignoring compaction.thinking (expected a string)";
const WARN_THINKING_INVALID =
	"pi-compact: ignoring compaction.thinking (expected one of: off, minimal, low, medium, high, xhigh)";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function readConfig(settings: unknown): { config: CompactConfig; warnings: string[] } {
	const warnings: string[] = [];
	const config: CompactConfig = {};

	if (!isPlainObject(settings)) return { config, warnings };

	const compaction = settings["compaction"];
	if (compaction === undefined) return { config, warnings };

	if (!isPlainObject(compaction)) {
		warnings.push(WARN_NOT_OBJECT);
		return { config, warnings };
	}

	const model = compaction["model"];
	if (model !== undefined) {
		if (typeof model !== "string") {
			warnings.push(WARN_MODEL_NOT_STRING);
		} else {
			const trimmed = model.trim();
			if (trimmed !== "") config.model = trimmed;
		}
	}

	const thinking = compaction["thinking"];
	if (thinking !== undefined) {
		if (typeof thinking !== "string") {
			warnings.push(WARN_THINKING_NOT_STRING);
		} else {
			const trimmed = thinking.trim().toLowerCase();
			if (trimmed === "") {
				// Mirror model: whitespace-only means unset, not a warning.
			} else if (THINKING_LEVELS.has(trimmed as ThinkingLevel)) {
				config.thinking = trimmed as ThinkingLevel;
			} else {
				warnings.push(WARN_THINKING_INVALID);
			}
		}
	}

	return { config, warnings };
}
