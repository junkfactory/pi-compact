import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Persist the compaction model to the global settings file
 * (`<agentDir>/settings.json`).
 *
 * pi's SettingsManager has no public API for arbitrary fields, so this does a
 * read-modify-write of the JSON file directly, mirroring pi's own semantics
 * (BOM-stripped JSON.parse, 2-space JSON.stringify output). A `""` spec removes
 * `compaction.model` instead of writing an empty string.
 */
export function savePermanentModel(
	spec: string,
	agentDir: string,
): { ok: true } | { ok: false; error: string } {
	const settingsPath = join(agentDir, "settings.json");
	try {
		let settings: Record<string, unknown> = {};
		try {
			const content = readFileSync(settingsPath, "utf-8");
			settings = JSON.parse(content.replace(/^\uFEFF/, ""));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				return { ok: false, error: `could not read ${settingsPath}: ${(error as Error).message}` };
			}
		}
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
			return { ok: false, error: `${settingsPath} does not contain a JSON object` };
		}
		const compaction = { ...(settings.compaction as Record<string, unknown> | undefined) };
		if (spec === "") delete compaction.model;
		else compaction.model = spec;
		settings.compaction = compaction;
		writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		return { ok: true };
	} catch (error) {
		return { ok: false, error: `could not write ${settingsPath}: ${(error as Error).message}` };
	}
}
