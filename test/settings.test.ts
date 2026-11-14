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

	it("extracts compaction.thinking and reads it independently of model", () => {
		const { config, warnings } = readConfig({ compaction: { thinking: "low" } });
		assert.deepEqual(config, { thinking: "low" });
		assert.deepEqual(warnings, []);
	});

	it("extracts model and thinking together", () => {
		const { config, warnings } = readConfig({ compaction: { model: "prov/mdl", thinking: "medium" } });
		assert.deepEqual(config, { model: "prov/mdl", thinking: "medium" });
		assert.deepEqual(warnings, []);
	});

	it("accepts every documented thinking level and normalizes case", () => {
		for (const level of ["auto", "off", "minimal", "low", "medium", "high", "xhigh"]) {
			const { config, warnings } = readConfig({ compaction: { thinking: level.toUpperCase() } });
			assert.deepEqual(config, { thinking: level });
			assert.deepEqual(warnings, []);
		}
	});

	it("warns and ignores an unknown thinking level", () => {
		const { config, warnings } = readConfig({ compaction: { thinking: "maximum" } });
		assert.deepEqual(config, {});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /compaction\.thinking/);
		assert.match(warnings[0], /expected one of/);
	});

	it("warns and ignores a non-string thinking value", () => {
		const { config, warnings } = readConfig({ compaction: { thinking: 42 } });
		assert.deepEqual(config, {});
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /compaction\.thinking \(expected a string\)/);
	});

	it("treats a whitespace-only thinking string as unset without warning", () => {
		const { config, warnings } = readConfig({ compaction: { thinking: "   " } });
		assert.deepEqual(config, {});
		assert.deepEqual(warnings, []);
	});
});
