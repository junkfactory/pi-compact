import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, SelectList, type SelectItem, Text } from "@earendil-works/pi-tui";

export type PickResult = { spec: string; permanent: boolean };

/**
 * Interactive model picker built on pi-tui's SelectList inside `ctx.ui.custom`
 * (plain `ctx.ui.select` cannot bind extra keys). Enter accepts for the
 * session, Ctrl+S persists the selection to settings, Escape cancels.
 */
export function pickModel(
	ctx: ExtensionCommandContext,
	items: SelectItem[],
	title: string,
): Promise<PickResult | undefined> {
	return ctx.ui.custom<PickResult | undefined>((tui, theme, _keybindings, done) => {
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		selectList.onSelect = (item) => done({ spec: item.value, permanent: false });
		selectList.onCancel = () => done(undefined);

		const container = new Container();
		container.addChild(new Text(theme.fg("accent", title)));
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑/↓ move · enter = session · ctrl+s = permanent · esc cancel")));

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
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
