# Changelog

## [0.3.0]

- The `/pi-compact model` and `/pi-compact thinking` pickers gain type-to-filter fuzzy search: typing narrows the list by matching on the model spec or effort level, Enter picks from the filtered list, and the highlighted selection is retained across query refinements and zero-match gaps. PageUp/PageDown still page the list, Ctrl+S persists the filtered selection to settings, and Escape cancels.

## [0.2.0]

- New `compaction.thinking` setting controls the summarizer's thinking effort (default `high`); `auto` follows the session's thinking level and `off` disables reasoning. Invalid values warn and are ignored.
- `/pi-compact thinking` opens a picker over the same effort levels (Esc keeps the current state); Enter applies for the session, Ctrl+S persists it to settings. Picking `off` permanently keeps `compaction.thinking: "off"` in settings — a session-only `off` reverts to the configured default on the next session. Bare `/pi-compact` shows the combined model, thinking, and prompt status, with settings warnings surfaced in the same message.
- The summary card records the resolved effort, rendered as e.g. `@ high effort`.
- Empty summaries are retried instead of falling back to pi's default compaction immediately.

## [0.1.0]

- Initial release: route every pi compaction (manual, threshold, overflow) to a model configured as `compaction.model` in settings, with an optional prompt override at `~/.pi/agent/extensions/pi-compact.md` and fallback to pi's default compaction on any failure.
- Successful compactions are verifiable: a dim `pi-compact: summary via <provider/model> (N → M tokens)` card is rendered under pi's `[compaction]` block and persisted as a custom session entry (plus an info notification for RPC clients), so the model that produced each summary stays visible across restarts and reloads.
- `/pi-compact` opens an interactive model picker (`model` subcommand) mirroring pi's model list, with an `off` entry and the active model marked; headless mode keeps text status. Enter applies for the session; Ctrl+S persists the choice to `compaction.model` in the global settings (Ctrl+S on `off` removes the setting).
- New `prompt` subcommand edits the prompt-override file in pi's built-in editor (Ctrl+G for the external `$EDITOR`), with starter template for missing files and blank-save warnings; `prompt reset` deletes the file to revert to the native prompt.
- Command arguments autocomplete (`model`, `prompt`, `off`).
