import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readConfig } from "../src/settings.js";

describe("readConfig", () => {
	it("returns an empty config and no warnings when compaction is absent", () => {
		const { config, warnings } = readConfig({});
		assert.deepEqual(config, {});
		assert.deepEqual(warnings, []);
	});

	it("extracts compaction.model", () => {
		const { config, warnings } = readConfig({ compaction: { model: "prov/mdl" } });
		assert.deepEqual(config, { model: "prov/mdl" });
		assert.deepEqual(warnings, []);
	});

	it("warns and ignores a non-object compaction value", () => {
		for (const value of ["nope", 42, null, []]) {
			const { config, warnings } = readConfig({ compaction: value });
			assert.deepEqual(config, {});
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /settings\.compaction/);
		}
	});

	it("warns and leaves the model unset for a non-string model", () => {
		const { config, warnings } = readConfig({ compaction: { model: 42 } });
		assert.deepEqual(config, {});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /compaction\.model/);
	});

	it("treats a whitespace-only model string as unset without warning", () => {
		const { config, warnings } = readConfig({ compaction: { model: "   " } });
		assert.deepEqual(config, {});
		assert.deepEqual(warnings, []);
	});
});
