import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	getKeybindings,
	Input,
	Key,
	matchesKey,
	SelectList,
	type SelectItem,
	Text,
} from "@earendil-works/pi-tui";

export type PickResult = { spec: string; permanent: boolean };

/**
 * Fuzzy-filter picker items on a search query, matching against the item
 * value (the model spec / thinking level) only. Labels carry presentation
 * markers like "(active)" that would pollute matching.
 */
export function filterItems(items: SelectItem[], query: string): SelectItem[] {
	return fuzzyFilter(items, query, (item) => item.value);
}

/**
 * Interactive model picker built on pi-tui's SelectList inside `ctx.ui.custom`
 * (plain `ctx.ui.select` cannot bind extra keys). Typing filters the list
 * fuzzily (pi core's thinking-selector pattern). Enter accepts for the
 * session, Ctrl+S persists the selection to settings, Escape cancels.
 */
export function pickModel(
	ctx: ExtensionCommandContext,
	items: SelectItem[],
	title: string,
): Promise<PickResult | undefined> {
	return ctx.ui.custom<PickResult | undefined>((tui, theme, _keybindings, done) => {
		const selectListTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};

		const buildList = (filtered: SelectItem[], preselect?: string) => {
			const list = new SelectList(filtered, Math.min(Math.max(filtered.length, 1), 10), selectListTheme);
			list.onSelect = (item) => done({ spec: item.value, permanent: false });
			list.onCancel = () => done(undefined);
			// Keep the previously selected item highlighted if it survives the filter;
			// the retained selection wins over filter rank, so Enter may pick it even
			// when it is not the top-ranked match (pi core's thinking-selector behavior;
			// the → marker makes it visible).
			const index = filtered.findIndex((item) => item.value === preselect);
			if (index >= 0) list.setSelectedIndex(index);
			return list;
		};

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", title)));

		const search = new Input({ placeholder: "filter…" });
		// The search line is the only focusable in this ctx.ui.custom overlay; the
		// focus flag emits CURSOR_MARKER so the hardware cursor / IME lands here.
		search.focused = true;
		container.addChild(search);

		let selectList = buildList(items);
		const listIndex = container.children.length;
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "type to filter · ↑/↓ move · enter = session · ctrl+s = permanent · esc cancel")));

		// Last selection visible in a non-empty list. Carried forward so retention
		// survives a zero-match gap; without navigation this is the implicit index-0
		// item, which is retained too (pi core's thinking-selector behavior).
		let selectedValue: string | undefined;

		const applyFilter = (query: string) => {
			const current = selectList.getSelectedItem()?.value;
			if (current !== undefined) selectedValue = current;
			const filtered = filterItems(items, query);
			const next = buildList(filtered, selectedValue);
			container.children[listIndex] = next;
			selectList = next;
		};

		return {
			capturesViewportInput: selectList.capturesViewportInput,
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.ctrl("s"))) {
					const selected = selectList.getSelectedItem();
					if (selected) done({ spec: selected.value, permanent: true });
					return;
				}
				const kb = getKeybindings();
				const isNav =
					kb.matches(data, "tui.select.up") ||
					kb.matches(data, "tui.select.down") ||
					kb.matches(data, "tui.select.pageUp") ||
					kb.matches(data, "tui.select.pageDown") ||
					kb.matches(data, "tui.select.confirm") ||
					kb.matches(data, "tui.select.cancel");
				if (isNav) {
					selectList.handleInput(data);
				} else {
					search.handleInput(data);
					applyFilter(search.getValue());
				}
				tui.requestRender();
			},
		};
	});
}
