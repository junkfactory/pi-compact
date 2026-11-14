import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fakeCtx } from "./fakes.js";
import { filterItems, pickModel, type PickResult } from "../src/picker.js";

const items = [
	{ value: "openrouter/anthropic/claude-opus-4-5", label: "openrouter/anthropic/claude-opus-4-5" },
	{ value: "openrouter/openai/gpt-5.1", label: "openrouter/openai/gpt-5.1 (active)" },
	{ value: "anthropic/claude-sonnet-4-5", label: "anthropic/claude-sonnet-4-5" },
	{ value: "google/gemini-3-pro", label: "google/gemini-3-pro" },
];

const pickerItems = [
	{ value: "prov/alpha", label: "prov/alpha" },
	{ value: "prov/beta", label: "prov/beta" },
	{ value: "other/gamma", label: "other/gamma" },
];

function runPicker(customKeys: string[]) {
	const { ctx, state } = fakeCtx({ customKeys });
	return { result: pickModel(ctx as unknown as ExtensionCommandContext, pickerItems, "title"), state };
}

test("empty query returns all items in original order", () => {
	assert.deepEqual(filterItems(items, ""), items);
	assert.deepEqual(filterItems(items, "   "), items);
});

test("fuzzy match on value: tokens match in order", () => {
	const result = filterItems(items, "opus").map((item) => item.value);
	// "sonnet" only matches via scattered o→n→...→s fragments, so "opus" as a
	// contiguous substring must rank first.
	assert.equal(result[0], "openrouter/anthropic/claude-opus-4-5");
});

test("space/slash-separated tokens all must match", () => {
	const result = filterItems(items, "claude sonnet").map((item) => item.value);
	assert.deepEqual(result, ["anthropic/claude-sonnet-4-5"]);
});

test("no match returns empty list", () => {
	assert.deepEqual(filterItems(items, "zzz"), []);
});

test("does not match label-only markers", () => {
	// "(active)" appears only on a label, never on a value — "active" must not match it.
	assert.deepEqual(filterItems(items, "active"), []);
});

test("PickResult type shape", () => {
	const result: PickResult = { spec: "google/gemini-3-pro", permanent: true };
	assert.equal(result.permanent, true);
});

test("typing narrows the list and escape cancels", async () => {
	const { result, state } = runPicker(["a", "l", "p", "\x1b"]);

	assert.equal(await result, undefined);
	const rendered = state.customCalls[0].render(100).join("\n");
	assert.match(rendered, /prov\/alpha/);
	assert.doesNotMatch(rendered, /prov\/beta/);
	assert.doesNotMatch(rendered, /other\/gamma/);
});

test("enter selects from the filtered list", async () => {
	// "gam" matches only other/gamma, which is not index 0 — proving the
	// selection comes from the filtered list, not the unfiltered one.
	const { result } = runPicker(["g", "a", "m", "\r"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: false });
});

test("enter prefers the retained selection over filter rank", async () => {
	// Down selects prov/beta; "t" filters to other/gamma (better rank) +
	// prov/beta; retention keeps beta highlighted, so Enter resolves beta.
	const { result, state } = runPicker(["\x1b[B", "t", "\r"]);

	assert.deepEqual(await result, { spec: "prov/beta", permanent: false });
	const rendered = state.customCalls[0].render(100).join("\n");
	assert.match(rendered, /→ prov\/beta/);
});

test("implicit index-0 selection is retained across query refinement", async () => {
	// "t" filters to other/gamma (better rank) + prov/beta; gamma becomes the
	// implicit index-0 selection. Refining to "ta" filters to prov/beta (better
	// rank) + other/gamma; the retained gamma must still be highlighted.
	const { result } = runPicker(["t", "a", "\r"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: false });
});

test("selection survives a zero-match gap", async () => {
	// PageDown selects other/gamma; "z" matches nothing (selection would reset
	// to index 0 on rebuild); backspace clears the filter — gamma must regain
	// the highlight instead of falling back to index 0.
	const { result } = runPicker(["\x1b[6~", "z", "\x7f", "\r"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: false });
});

test("ctrl+s on a filtered item persists it", async () => {
	const { result } = runPicker(["g", "a", "m", "\x13"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: true });
});

test("selection survives filtering when it still matches", async () => {
	// PageDown selects other/gamma; "t" filters to prov/beta + other/gamma;
	// gamma must stay highlighted, so Enter still resolves gamma.
	const { result, state } = runPicker(["\x1b[6~", "t", "\r"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: false });
	const rendered = state.customCalls[0].render(100).join("\n");
	assert.match(rendered, /→ other\/gamma/);
	assert.doesNotMatch(rendered, /prov\/alpha/);
});

test("pageDown pages the unfiltered list", async () => {
	// maxVisible = min(3, 10) = 3, so one PageDown lands on the last item.
	// PageDown's raw sequence here is \x1b[6~ (pi-tui keys.ts maps it to "pageDown").
	const { result } = runPicker(["\x1b[6~", "\r"]);

	assert.deepEqual(await result, { spec: "other/gamma", permanent: false });
});

test("ctrl+s on zero matches does not select", async () => {
	// Ctrl+S with nothing selected must not resolve; escape still cancels.
	const { result, state } = runPicker(["z", "z", "z", "\x13", "\x1b"]);

	assert.equal(await result, undefined);
	assert.match(state.customCalls[0].render(100).join("\n"), /No matching/);
});
