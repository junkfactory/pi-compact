import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Copied verbatim from pi 1.5.2 packages/coding-agent/src/core/compaction/utils.ts (Apache-2.0).
export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// Copied verbatim from pi 1.5.2 packages/coding-agent/src/core/compaction/compaction.ts (Apache-2.0).
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_INSTRUCTIONS = `Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Copied verbatim from pi 1.5.2 packages/coding-agent/src/core/compaction/compaction.ts (Apache-2.0).
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

${UPDATE_SUMMARIZATION_INSTRUCTIONS}`;

export const PROMPT_OVERRIDE_PATH = join(getAgentDir(), "extensions", "pi-compact.md");

export async function loadPromptOverride(path: string = PROMPT_OVERRIDE_PATH): Promise<{ text?: string; warning?: string }> {
	let content: string;
	try {
		content = await readFile(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return {};
		const message = error instanceof Error ? error.message : String(error);
		return { warning: `pi-compact: could not read prompt override ${path}: ${message}` };
	}
	if (content.trim() === "") {
		return { warning: "pi-compact: prompt override file is blank, using native prompt" };
	}
	return { text: content };
}

export function buildSummaryMessages(opts: {
	conversationText: string;
	previousSummary?: string;
	customInstructions?: string;
	overridePrompt?: string;
}): {
	systemPrompt: string;
	messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
} {
	const basePrompt = opts.overridePrompt ?? (opts.previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT);
	const text =
		`<conversation>\n${opts.conversationText}\n</conversation>\n\n` +
		(opts.previousSummary ? `<previous-summary>\n${opts.previousSummary}\n</previous-summary>\n\n` : "") +
		basePrompt +
		(opts.customInstructions ? `\n\nAdditional focus: ${opts.customInstructions}` : "");
	return {
		systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
		messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
	};
}
