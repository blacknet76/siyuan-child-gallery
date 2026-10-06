import {
    getFrontend,
    openMobileFileById,
    openTab,
    Plugin,
} from "siyuan";
import type {Protyle} from "siyuan";
import {
    CUSTOM_BLOCK_TYPE,
    defaultBlockMarkdown,
} from "./config";
import english from "./i18n/en.json";
import childGallerySvg from "./icons/icon-child-gallery.svg";
import {renderGallery} from "./renderer";
import type {GalleryMessages} from "./renderer";
import "./index.scss";

type Toolbar = Parameters<Plugin["updateProtyleToolbar"]>[0];
export const CHILD_GALLERY_ICON = "icon-siyuan-child-gallery-insert";

export default class ChildGalleryPlugin extends Plugin {
    // SiYuan supplies the active i18n file. English also protects against missing translations.
    private get messages(): GalleryMessages {
        const messages = {...english};
        for (const key of Object.keys(english) as Array<keyof GalleryMessages>) {
            const translated = this.i18n[key];
            if (typeof translated === "string" && translated.trim()) {
                messages[key] = translated;
            }
        }
        return messages;
    }

    onload(): void {
        if (!document.getElementById(CHILD_GALLERY_ICON)) {
            // Adapt only the approved SVG root for the host symbol registry; retain every attribute/shape.
            this.addIcons(
                childGallerySvg.replace("<svg", `<symbol id="${CHILD_GALLERY_ICON}"`).replace("</svg>", "</symbol>"),
            );
        }
        this.customBlockRenders[CUSTOM_BLOCK_TYPE] = {
            render: ({element, content, setContent}) =>
                renderGallery(
                    element,
                    content,
                    this.messages,
                    this.name,
                    async id => {
                        const frontend = getFrontend();
                        if (frontend === "mobile" || frontend === "browser-mobile") {
                            openMobileFileById(this.app, id);
                        } else {
                            await openTab({app: this.app, doc: {id}});
                        }
                    },
                    this.eventBus,
                    setContent,
                ),
        };
        const label = this.messages.galleryName;
        // Use the sample's native slash-item markup, escaping the localized label via textContent.
        const text = document.createElement("span");
        text.className = "b3-list-item__text";
        text.textContent = label;
        this.protyleSlash = [{
            id: "insert-child-gallery",
            filter: [label, "gallery", "child", "children", "unterseiten", "galerie"],
            html:
                `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#${CHILD_GALLERY_ICON}"></use></svg>${text.outerHTML}</div>`,
            callback: (protyle) => this.insertGallery(protyle),
        }];
    }

    updateProtyleToolbar(toolbar: Toolbar): Toolbar {
        const name = "insert-child-gallery";
        if (toolbar.some(item => typeof item !== "string" && item.name === name)) {
            return toolbar;
        }
        return [...toolbar, {
            name,
            icon: CHILD_GALLERY_ICON,
            tip: this.messages.galleryName,
            tipPosition: "n",
            click: (protyle) => this.insertGallery(protyle),
        }];
    }

    private insertGallery(protyle: Protyle): void {
        const editor = protyle.protyle;
        if (editor.disabled || !editor.lute) {
            return;
        }
        const markdown = defaultBlockMarkdown(this.name);
        protyle.insert(editor.lute.Md2BlockDOM(markdown), true);
    }
}
