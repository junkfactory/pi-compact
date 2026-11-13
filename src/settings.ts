/**
 * Reads pi-compact's settings from pi's settings object.
 *
 * pi-compact extends pi's native `compaction` settings object with a `model`
 * field. Only that field is read here; every other field under `compaction`
 * belongs to pi and is ignored.
 */

export interface CompactConfig {
	model?: string;
}

const WARN_NOT_OBJECT = "pi-compact: ignoring settings.compaction (expected an object)";
const WARN_MODEL_NOT_STRING = "pi-compact: ignoring compaction.model (expected a string)";

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
	if (model === undefined) return { config, warnings };

	if (typeof model !== "string") {
		warnings.push(WARN_MODEL_NOT_STRING);
		return { config, warnings };
	}

	const trimmed = model.trim();
	if (trimmed !== "") config.model = trimmed;

	return { config, warnings };
}
