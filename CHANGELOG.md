# Changelog

## [Unreleased]

- Successful compactions are verifiable: a dim `pi-compact: summary via <provider/model> (N → M tokens)` card is rendered under pi's `[compaction]` block and persisted as a custom session entry (plus an info notification for RPC clients), so the model that produced each summary stays visible across restarts and reloads.
- `/pi-compact` opens an interactive model picker (`model` subcommand) mirroring pi's model list, with an `off` entry and the active model marked; headless mode keeps text status. Enter applies for the session; Ctrl+S persists the choice to `compaction.model` in the global settings (Ctrl+S on `off` removes the setting).
- New `prompt` subcommand edits the prompt-override file in pi's built-in editor (Ctrl+G for the external `$EDITOR`), with starter template for missing files and blank-save warnings; `prompt reset` deletes the file to revert to the native prompt.
- Command arguments autocomplete (`model`, `prompt`, `off`).

## [0.1.0]

- Initial release: route every pi compaction (manual, threshold, overflow) to a model configured as `compaction.model` in settings, with an optional prompt override at `~/.pi/agent/extensions/pi-compact.md` and fallback to pi's default compaction on any failure.
