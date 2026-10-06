import {
    getFrontend,
    Menu,
} from "siyuan";
import type {GalleryConfig} from "./config";
import type {GalleryMessages} from "./renderer";

type SettingsChange = Pick<Partial<GalleryConfig>, "orientation" | "columns" | "depth" | "showImage">;

// The public close callback releases ownership when SiYuan replaces its shared menu.
export function attachGallerySettings(
    header: HTMLElement,
    messages: GalleryMessages,
    getConfig: () => GalleryConfig,
    isCurrent: () => boolean,
    change: (patch: SettingsChange) => boolean,
): () => void {
    const button = header.ownerDocument.createElement("button");
    button.type = "button";
    button.className = "child-gallery__settings";
    button.title = messages.gallerySettings;
    button.setAttribute("aria-label", messages.gallerySettings);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    // Fixed host icon markup only; no document/configuration HTML is interpolated.
    button.innerHTML = '<svg aria-hidden="true"><use href="#iconSettings"></use></svg>';
    header.append(button);
    let ownedMenu: Menu | undefined;
    let disposed = false;
    const open = () => {
        if (disposed || !isCurrent()) return;
        if (ownedMenu) {
            ownedMenu.close();
            return;
        }
        const menu = new Menu(undefined, () => {
            ownedMenu = undefined;
            button.setAttribute("aria-expanded", "false");
        });
        ownedMenu = menu;
        const config = getConfig();
        // Native menu labels support HTML: escape all localized labels through textContent.
        const label = (text: string) => {
            const span = header.ownerDocument.createElement("span");
            span.textContent = text;
            return span.innerHTML;
        };
        const select = (patch: SettingsChange) => () => {
            if (!disposed && isCurrent() && ownedMenu === menu) change(patch);
        };
        menu.addItem({
            label: label(messages.cardLayout),
            submenu: [
                {
                    label: label(messages.vertical),
                    checked: config.orientation === "vertical",
                    click: select({orientation: "vertical"}),
                },
                {
                    label: label(messages.horizontal),
                    checked: config.orientation === "horizontal",
                    click: select({orientation: "horizontal"}),
                },
            ],
        });
        menu.addItem({
            label: label(messages.columns),
            submenu: (["auto", 1, 2, 3, 4] as const).map(columns => ({
                label: label(columns === "auto" ? messages.automatic : String(columns)),
                checked: config.columns === columns,
                click: select({columns}),
            })),
        });
        menu.addItem({
            label: label(messages.depth),
            submenu: ([1, 2, 3] as const).map(depth => ({
                label: String(depth),
                checked: config.depth === depth,
                click: select({depth}),
            })),
        });
        menu.addItem({
            label: label(messages.showPreviews),
            checked: config.showImage,
            click: select({showImage: !config.showImage}),
        });
        button.setAttribute("aria-expanded", "true");
        const frontend = getFrontend();
        if (frontend === "mobile" || frontend === "browser-mobile") menu.fullscreen();
        else {
            const rect = button.getBoundingClientRect();
            menu.open({x: rect.right, y: rect.bottom, isLeft: true});
        }
    };
    button.addEventListener("click", open);
    return () => {
        disposed = true;
        button.removeEventListener("click", open);
        ownedMenu?.close();
    };
}
