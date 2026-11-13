# Changelog

## [Unreleased]

- `/pi-compact` opens an interactive model picker (`model` subcommand) mirroring pi's model list, with an `off` entry and the active model marked; headless mode keeps text status. Enter applies for the session; Ctrl+S persists the choice to `compaction.model` in the global settings (Ctrl+S on `off` removes the setting).
- New `prompt` subcommand edits the prompt-override file in pi's built-in editor (Ctrl+G for the external `$EDITOR`), with starter template for missing files and blank-save warnings.
- Command arguments autocomplete (`model`, `prompt`, `off`).

## [0.1.0]

- Initial release: route every pi compaction (manual, threshold, overflow) to a model configured as `compaction.model` in settings, with an optional prompt override at `~/.pi/agent/extensions/pi-compact.md` and fallback to pi's default compaction on any failure.
