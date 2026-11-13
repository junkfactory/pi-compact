# pi-compact

A [Pi](https://pi.dev) extension that routes **every** compaction — automatic
threshold/overflow compaction and the native `/compact` command — to a
provider/model of your choice. The summary request is built with pi's own
native compaction prompt mechanics, so the output stays compatible with
everything pi expects. If anything goes wrong (model not found, provider
error, empty summary), pi-compact gets out of the way and pi's default
compaction runs instead.

You keep control over *who summarizes*; pi keeps control over *how*.

## Install

Add the package to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/junkfactory/pi-compact"]
}
```

Then restart pi, or run `/reload`.

## Configure

Point `compaction.model` at any model in pi's registry, written as
`"provider/modelId"`:

```json
{
  "compaction": {
    "model": "google/gemini-2.5-flash"
  }
}
```

- Global config lives in `~/.pi/agent/settings.json`.
- Project config lives in `<project>/.pi/settings.json` and overrides the
  global value.

Pi's other compaction fields — `enabled`, `reserveTokens`,
`keepRecentTokens`, `modelOverrides` — keep working untouched. pi-compact
only overrides **who summarizes**; it never re-implements cut-point
selection or token budgeting. With `compaction.model` unset, pi-compact stays
completely out of the way and pi's default compaction is used.

Editors validating against pi's settings `$schema` may flag the
extension-added `compaction.model` field as unknown. This is cosmetic — pi
preserves the field.

## Runtime override

The `/pi-compact` command adjusts the current session without touching
settings files:

| Command | Effect |
| --- | --- |
| `/pi-compact` | Show status: active model, whether it comes from settings or the session, prompt override state, and whether interception is disabled. |
| `/pi-compact <provider/model>` | Override the compaction model for this session. The model is validated against the model registry. |
| `/pi-compact off` | Disable interception for this session; pi's default compaction runs. |

Settings edits require `/reload`; the command applies instantly. A session
override is reset on session start.

## Prompt override

The native base prompt can be replaced with your own instructions by placing
a markdown file at:

```text
~/.pi/agent/extensions/pi-compact.md
```

Its contents replace pi's native base prompt. The surrounding machinery is
always preserved: the `<conversation>` and `<previous-summary>` tags, the
summarization system prompt, and the `Additional focus:` suffix carrying
`customInstructions`.

If the file is absent, pi's native prompt is sent byte-for-byte. If it is
blank or unreadable, pi-compact warns and falls back to the native prompt.

Example override, tuned for a structured engineering summary:

```markdown
Summarize the conversation so work can continue seamlessly. Use these
sections:

- **Goals**: what the user is trying to achieve.
- **Decisions**: choices made and the reasons behind them.
- **Changes**: files created or modified, with paths.
- **State**: what works, what is verified, what is uncommitted.
- **Blockers**: open problems, errors, or pending user input.
- **Next steps**: the concrete actions that follow.

Reference file paths exactly. Prefer facts from tool output over recollection.
Omit conversational filler.
```

## Behavior & fallback

The `session_before_compact` hook fires for manual, threshold, and overflow
compaction alike. Failures of two kinds are retried up to 3 attempts with
1s then 2s backoff (delays configurable via the extension options for
tests): errors thrown by the summary request, and provider failures returned
as a response with `stopReason: "error"` — in both cases the provider's own
error text ends up in the warning. A truncated response (`stopReason:
"length"`) is never retried: partial text must not become a checkpoint. Any
of the following produces a warning notification and hands the turn back to
pi's default compaction:

- the configured model is unknown to the registry;
- the summary request throws, or the provider returns `stopReason: "error"`
  (after retries);
- the summary response is truncated (`stopReason: "length"`) — fails at once;
- the summary request attempts a tool call — fails at once;
- the summary comes back empty.

A user abort is silent — no warning, no fallback noise. Overflow recovery
still works for the same reason: a failed custom attempt simply returns
control to pi, which compacts with its own path.

Known deviation from pi's default compaction: for a split user-message span
pi produces two merged summaries (one for the prefix, one for the rest),
while pi-compact always produces a single summary over all summarized
messages.

Values are pi's natives, not reinventions:

- no custom `maxTokens` — the model's own output limit applies;
- `cacheRetention: "none"` for the summarization request;
- cut-point selection, `reserveTokens`, and `keepRecentTokens` remain pi's.

## Development

```bash
npm install
npm run check   # tsc --noEmit
npm test        # node --test via jiti
```

This repo uses [jj](https://jj-vcs.github.io/jj/) (colocated with git).
Commits follow conventional-commit prefixes (`feat:`, `fix:`, `docs:`,
`test:`, `chore:`, `refactor:`). Never push or release automatically.
