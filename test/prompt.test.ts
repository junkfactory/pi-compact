import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildSummaryMessages,
	loadPromptOverride,
	PROMPT_OVERRIDE_PATH,
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../src/prompt.js";

function userText(built: ReturnType<typeof buildSummaryMessages>): string {
	return built.messages[0].content[0].text;
}

describe("buildSummaryMessages", () => {
	it("wraps the conversation and puts the native base prompt after it", () => {
		const built = buildSummaryMessages({ conversationText: "USER: hello" });
		const text = userText(built);

		assert.equal(built.systemPrompt, SUMMARIZATION_SYSTEM_PROMPT);
		assert.ok(text.startsWith("<conversation>\nUSER: hello\n</conversation>\n\n"));
		assert.ok(text.endsWith(SUMMARIZATION_PROMPT));
		assert.ok(!text.includes("<previous-summary>"));
	});

	it("adds a previous-summary block and switches to the update prompt", () => {
		const built = buildSummaryMessages({ conversationText: "USER: hello", previousSummary: "old summary" });
		const text = userText(built);

		assert.ok(text.includes("<previous-summary>\nold summary\n</previous-summary>\n\n"));
		assert.ok(text.endsWith(UPDATE_SUMMARIZATION_PROMPT));
		assert.ok(!text.includes(SUMMARIZATION_PROMPT));
	});

	it("appends custom instructions as Additional focus", () => {
		const built = buildSummaryMessages({ conversationText: "USER: hello", customInstructions: "focus on tests" });
		assert.ok(userText(built).endsWith("\n\nAdditional focus: focus on tests"));
	});

	it("replaces the base prompt with an override", () => {
		const built = buildSummaryMessages({ conversationText: "USER: hello", overridePrompt: "OVERRIDE INSTRUCTIONS" });
		const text = userText(built);

		assert.ok(text.endsWith("OVERRIDE INSTRUCTIONS"));
		assert.ok(!text.includes(SUMMARIZATION_PROMPT));
		assert.ok(!text.includes(UPDATE_SUMMARIZATION_PROMPT));
	});
});

describe("loadPromptOverride", () => {
	it("reads an override file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-compact-prompt-"));
		try {
			const path = join(dir, "override.md");
			await writeFile(path, "OVERRIDE INSTRUCTIONS");

			const override = await loadPromptOverride(path);

			assert.equal(override.text, "OVERRIDE INSTRUCTIONS");
			assert.equal(override.warning, undefined);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("reports nothing for a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-compact-prompt-"));
		try {
			const override = await loadPromptOverride(join(dir, "does-not-exist.md"));

			assert.equal(override.text, undefined);
			assert.equal(override.warning, undefined);
			assert.deepEqual(override, {});
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("warns for a blank file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-compact-prompt-"));
		try {
			const path = join(dir, "override.md");
			await writeFile(path, "  \n\t\n");

			const override = await loadPromptOverride(path);

			assert.equal(override.text, undefined);
			assert.match(override.warning ?? "", /blank/);
		} finally {
			await rm(dir, { recursive: true });
		}
	});

	it("defaults to the pi-compact file under the agent extensions directory", () => {
		assert.ok(PROMPT_OVERRIDE_PATH.endsWith(join("extensions", "pi-compact.md")));
	});
});
