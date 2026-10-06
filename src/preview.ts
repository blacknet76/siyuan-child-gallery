import {fetchSyncPost} from "siyuan";

export interface DocumentPreview {
    image?: string;
    description?: string;
}

const ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const CONTENT_BLOCKS = new Set([
    "NodeParagraph",
    "NodeHeading",
    "NodeList",
    "NodeListItem",
    "NodeTable",
    "NodeBlockquote",
    "NodeSuperBlock",
]);
const NON_PROSE = new Set(["NodeHeading", "NodeList", "NodeListItem", "NodeTable"]);
const NON_TEXT = new Set(["IMG", "SVG", "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"]);

function imageSource(source: string | null, baseURL: string): string | undefined {
    if (!source) return;
    const raw = source.trim();
    if (/^data:image\/(png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/]+={0,2}$/.test(raw)) return raw;
    const asset = /^\/?assets\//.test(raw);
    if (!asset && !/^https?:\/\//i.test(raw) && !raw.startsWith("//")) return;
    if (Array.from(raw).some(character => character.charCodeAt(0) < 32 || character === "\\")) return;
    try {
        const url = new URL(raw, baseURL);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
        const path = decodeURIComponent(url.pathname);
        if (asset && (!path.startsWith("/assets/") || !/\.(png|jpe?g|gif|webp|svg|avif|bmp|tiff?)$/i.test(path))) {
            return;
        }
        if (/\/(api\/icon|emojis?|icons?|avatars?)(\/|$)/i.test(path)) return;
        if (/\.(ico|pdf|html?|js|json|md|txt|sy|mp[34]|webm|zip)$/i.test(path)) return;
        return url.href;
    } catch {
        return;
    }
}

function plainText(node: Node): string {
    if (node.nodeType === 3) return node.textContent || "";
    if (node.nodeType !== 1) return "";
    const element = node as Element;
    const type = element.getAttribute("data-type");
    if (NON_TEXT.has(element.tagName) || type === "img" || type === "emoji") return "";
    if (element.tagName === "BR") return " ";
    return Array.from(element.childNodes).map(plainText).join("");
}

// Walk only an inert API-content fragment, never a live SiYuan editor or its ancestors.
export function extractDocumentPreview(content: ParentNode, baseURL: string): DocumentPreview {
    const preview: DocumentPreview = {};
    function findImage(element: Element): string | undefined {
        if (element.tagName === "IMG") {
            return imageSource(element.getAttribute("data-src") ?? element.getAttribute("src"), baseURL);
        }
        for (const child of Array.from(element.children)) {
            const source = findImage(child);
            if (source) return source;
        }
    }
    function visit(element: Element, prose = true, withinContent = false): void {
        if (preview.image && preview.description) return;
        const type = element.getAttribute("data-type") || "";
        if (type.startsWith("Node")) {
            if (!CONTENT_BLOCKS.has(type)) return; // No technical blocks or expanded embed/query output.
            withinContent = true;
            prose = prose && !NON_PROSE.has(type);
        }
        if (!withinContent || NON_TEXT.has(element.tagName)) return;
        if (!preview.image && type === "img") {
            const source = findImage(element);
            if (source) preview.image = source;
        }
        if (
            !preview.description && prose && type === "NodeParagraph" && element.getAttribute("tabs-title") !== "true"
        ) {
            const editable = Array.from(element.children).find(child =>
                child.getAttribute("contenteditable") === "true"
            );
            if (editable && !/(^|\s)(callout-title|tab-item-title)(\s|$)/.test(editable.getAttribute("class") || "")) {
                const text = plainText(editable).replace(/[\u200b\ufeff]/g, "").replace(/\s+/g, " ").trim();
                if (text) preview.description = text;
            }
        }
        for (const child of Array.from(element.children)) visit(child, prose, withinContent);
    }
    for (const block of Array.from(content.children)) visit(block);
    return preview;
}

export async function resolveDocumentPreview(id: string, document: Document): Promise<DocumentPreview> {
    if (!ID.test(id)) return {};
    try {
        const response: unknown = await fetchSyncPost("/api/block/getBlockDOM", {id}, undefined, false);
        if (!response || typeof response !== "object" || Array.isArray(response)) return {};
        const {code, data} = response as {code?: unknown; data?: unknown;};
        if (code !== 0 || !data || typeof data !== "object" || Array.isArray(data)) return {};
        const block = data as {id?: unknown; dom?: unknown;};
        if (block.id !== id || typeof block.dom !== "string" || !block.dom.trim()) return {};
        // Template contents are inert: no script execution, resource loading or insertion into the live page.
        const template = document.createElement("template");
        template.innerHTML = block.dom;
        return extractDocumentPreview(template.content, document.baseURI);
    } catch {
        return {}; // A failed preview must leave its navigable title card intact.
    }
}
