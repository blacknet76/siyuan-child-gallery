import type {EventBus} from "siyuan";
import {resolveHierarchy} from "./children";
import type {GalleryNode} from "./children";
import {
    parseConfig,
    updateGalleryConfig,
} from "./config";
import {
    getGalleryBlockId,
    startContainingDocumentResolution,
} from "./context";
import {fallbackCoverAppearance} from "./fallback";
import type english from "./i18n/en.json";
import {resolveDocumentPreview} from "./preview";
import {attachGallerySettings} from "./settings";
import {forEachLimited} from "./work";

export type GalleryMessages = typeof english;

function isRasterSource(source: string, baseURL: string): boolean {
    if (/^data:image\/(png|jpeg|gif|webp|avif);base64,/.test(source)) return true;
    try {
        return /\.(png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(decodeURIComponent(new URL(source, baseURL).pathname));
    } catch {
        return false;
    }
}

export function renderGallery(
    element: HTMLElement,
    content: string,
    messages: GalleryMessages,
    pluginName: string,
    openDocument: (id: string) => Promise<void>,
    eventBus: Pick<EventBus, "on" | "off">,
    setContent?: (content: string) => boolean,
): () => void {
    const document = element.ownerDocument;
    const gallery = document.createElement("div");
    gallery.className = "child-gallery";
    const title = document.createElement("strong");
    title.textContent = messages.galleryName;
    const status = document.createElement("p");
    status.className = "child-gallery__notice";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    gallery.append(title, status);
    element.replaceChildren(gallery);
    let alive = true;
    let workCurrent = true;
    let cancelContext: (() => void) | undefined;
    const isCurrent = () => alive && element.isConnected && gallery.parentElement === element;
    const canLoad = () => isCurrent() && workCurrent;
    let config = parseConfig(content);
    let savedContent = content;
    let disposeSettings: (() => void) | undefined;
    const mediaCleanups = new Set<() => void>();
    function stopMediaObservers(): void {
        for (const cleanup of mediaCleanups) cleanup();
    }
    function applyLayout(): void {
        if (!config) return;
        gallery.setAttribute("data-orientation", config.orientation);
        gallery.setAttribute("data-columns", String(config.columns));
    }
    applyLayout();
    if (config && setContent) {
        const header = document.createElement("div");
        header.className = "child-gallery__header";
        gallery.insertBefore(header, title);
        header.append(title);
        disposeSettings = attachGallerySettings(header, messages, () => config!, isCurrent, patch => {
            if (!isCurrent()) return false;
            const next = updateGalleryConfig(savedContent, patch);
            if (!next) return false;
            try {
                if (!setContent(next)) {
                    status.textContent = messages.settingsUnavailable;
                    return false;
                }
            } catch {
                if (isCurrent()) status.textContent = messages.settingsUnavailable;
                return false;
            }
            if (!isCurrent()) return false;
            if (patch.depth !== undefined && patch.depth !== config?.depth) {
                workCurrent = false; // Accepted depth writes let the host rebuild; stop old queued work now.
                cancelContext?.();
                stopMediaObservers();
            }
            if (patch.showImage === false) stopMediaObservers();
            savedContent = next;
            config = parseConfig(next);
            applyLayout(); // Same cards immediately; the host owns the ensuing content/rerender lifecycle.
            return true;
        });
    }
    const blockId = config ? getGalleryBlockId(element, pluginName) : null;
    status.textContent = !config ?
        messages.invalidConfig :
        !blockId ?
        messages.contextUnavailable :
        messages.loadingChildren;

    async function load(blockId: string): Promise<void> {
        gallery.setAttribute("aria-busy", "true");
        const context = startContainingDocumentResolution(blockId, eventBus, canLoad);
        cancelContext = context.cancel;
        const rootId = await context.result;
        if (!canLoad()) return;
        if (!rootId) {
            status.textContent = messages.contextUnavailable;
            gallery.setAttribute("aria-busy", "false");
            return;
        }
        const depth = config!.depth;
        const children = await resolveHierarchy(rootId, depth, canLoad);
        if (!canLoad()) return;
        gallery.setAttribute("aria-busy", "false");
        status.textContent = children === null ?
            messages.childrenUnavailable :
            children.length === 0 ?
            messages.noChildren :
            "";
        if (!children?.length) return;
        const previews: (() => Promise<void>)[] = [];
        function createCard(child: GalleryNode, owner: HTMLElement): HTMLButtonElement {
            const card = document.createElement("button");
            card.type = "button";
            card.className = "child-gallery__card";
            const cardTitle = document.createElement("span");
            cardTitle.className = "child-gallery__title";
            cardTitle.textContent = child.title || messages.untitledDocument;
            card.append(cardTitle);
            // Native buttons provide Enter/Space activation without synthetic keyboard handlers.
            card.addEventListener("click", () => {
                if (!isCurrent()) return;
                void openDocument(child.id).catch(() => {
                    if (isCurrent()) status.textContent = messages.openUnavailable;
                });
            });
            const canEnrich = () => canLoad() && card.isConnected && card.parentElement === owner;
            function publishMedia(source?: string): void {
                if (!canEnrich()) return;
                const cover = document.createElement("span");
                cover.className = "child-gallery__media child-gallery__fallback";
                cover.setAttribute("aria-hidden", "true");
                const appearance = fallbackCoverAppearance(child.id);
                cover.setAttribute("data-cover-palette", String(appearance.palette));
                cover.style.setProperty("--child-gallery-cover-angle", `${appearance.angle}deg`);
                cover.style.setProperty("--child-gallery-cover-stop", `${appearance.stop}%`);
                card.insertBefore(cover, cardTitle);
                const raster = source !== undefined && isRasterSource(source, document.baseURI);
                cover.setAttribute("data-media-state", source ? raster ? "loading" : "cover" : "fallback");
                if (!source) return;
                const image = document.createElement("img");
                image.className = "child-gallery__image";
                image.alt = "";
                image.loading = "lazy";
                let observer: ResizeObserver | undefined;
                let loaded = false;
                let lastWidth = -1;
                let lastHeight = -1;
                const stopObserving = () => {
                    observer?.disconnect();
                    observer = undefined;
                    mediaCleanups.delete(stopObserving);
                };
                const ownsMedia = () =>
                    canEnrich() && gallery.contains(card) && config?.showImage === true &&
                    cover.parentElement === card &&
                    image.parentElement === cover;
                function classify(): void {
                    if (!ownsMedia()) {
                        stopObserving();
                        return;
                    }
                    const width = cover.clientWidth;
                    const height = cover.clientHeight;
                    if (!(width > 0 && height > 0)) return;
                    if (width === lastWidth && height === lastHeight) return;
                    lastWidth = width;
                    lastHeight = height;
                    const naturalWidth = image.naturalWidth;
                    const naturalHeight = image.naturalHeight;
                    const state = naturalWidth > 0 && naturalHeight > 0 &&
                            Math.max(width / naturalWidth, height / naturalHeight) > 1.5 ?
                        "contained" :
                        "cover";
                    if (cover.getAttribute("data-media-state") !== state) cover.setAttribute("data-media-state", state);
                }
                image.addEventListener("load", () => {
                    if (!ownsMedia()) {
                        stopObserving();
                        return;
                    }
                    if (!raster || loaded) return;
                    loaded = true;
                    classify();
                    if (cover.getAttribute("data-media-state") === "loading") {
                        cover.setAttribute("data-media-state", "cover");
                    }
                    const Observer = document.defaultView?.ResizeObserver;
                    if (Observer) {
                        observer = new Observer(classify);
                        mediaCleanups.add(stopObserving);
                        observer.observe(cover);
                    }
                });
                image.addEventListener("error", () => {
                    if (!ownsMedia()) {
                        stopObserving();
                        return;
                    }
                    stopObserving();
                    image.remove();
                    cover.setAttribute("data-media-state", "fallback");
                });
                cover.append(image);
                image.src = source;
            }
            async function enrich(): Promise<void> {
                if (!canEnrich()) return;
                const preview = await resolveDocumentPreview(child.id, document);
                if (!canEnrich()) return;
                if (config?.showImage) publishMedia(preview.image);
                if (config?.showDescription && preview.description) {
                    const description = document.createElement("span");
                    description.className = "child-gallery__description";
                    description.textContent = preview.description;
                    card.append(description);
                }
            }
            if (config?.showImage || config?.showDescription) previews.push(enrich);
            return card;
        }
        function createGroup(nodes: GalleryNode[], level: number, label: string): HTMLElement {
            const group = document.createElement("ul");
            group.className = "child-gallery__grid child-gallery__group" + (level > 1 ? " child-gallery__nested" : "");
            group.setAttribute("role", "list");
            group.setAttribute("aria-label", label);
            group.setAttribute("data-level", String(level));
            for (const child of nodes) {
                const branch = document.createElement("li");
                branch.className = "child-gallery__branch";
                branch.append(createCard(child, branch));
                if (level < depth && child.children.length) {
                    branch.append(createGroup(child.children, level + 1, child.title || messages.untitledDocument));
                }
                group.append(branch);
            }
            return group;
        }
        if (depth === 1) {
            const grid = document.createElement("div");
            grid.className = "child-gallery__grid";
            for (const child of children) grid.append(createCard(child, grid));
            gallery.append(grid); // Preserve the established depth-1 DOM and layout.
        } else {
            gallery.append(createGroup(children, 1, messages.galleryName));
        }
        // Structure/navigation is complete before progressive enrichment; every render owns this queue.
        await forEachLimited(previews, enrich => enrich(), canLoad);
    }
    if (blockId) void load(blockId);
    return () => {
        alive = false;
        cancelContext?.();
        disposeSettings?.();
        stopMediaObservers();
        gallery.remove();
    };
}
