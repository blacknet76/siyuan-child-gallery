export const CUSTOM_BLOCK_TYPE = "child-gallery";

export interface GalleryConfig {
    version: 1;
    source: "children";
    depth: 1 | 2 | 3;
    orientation: "vertical" | "horizontal";
    columns: "auto" | 1 | 2 | 3 | 4;
    showImage: boolean;
    showDescription: boolean;
}

export const DEFAULT_CONFIG: Readonly<GalleryConfig> = Object.freeze({
    version: 1,
    source: "children",
    depth: 1,
    orientation: "vertical",
    columns: "auto",
    showImage: true,
    showDescription: true,
});

// Reject unsupported data without rewriting it or silently migrating future versions.
export function parseConfig(content: string): GalleryConfig | undefined {
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    const config = value as Record<string, unknown>;
    if (
        config.version !== 1 || config.source !== "children" ||
        (config.depth !== undefined && ![1, 2, 3].includes(config.depth as number)) ||
        (config.showImage !== undefined && typeof config.showImage !== "boolean") ||
        (config.showDescription !== undefined && typeof config.showDescription !== "boolean")
    ) return undefined;
    return {
        ...DEFAULT_CONFIG,
        ...config,
        depth: (config.depth ?? 1) as GalleryConfig["depth"],
        orientation: config.orientation === "horizontal" ? "horizontal" : "vertical",
        columns: [1, 2, 3, 4].includes(config.columns as number) ? config.columns as 1 | 2 | 3 | 4 : "auto",
        showImage: (config.showImage ?? true) as boolean,
        showDescription: (config.showDescription ?? true) as boolean,
    } as GalleryConfig;
}

// Explicit edits change only the selected setting; retain unknown version-1 keys.
export function updateGalleryConfig(
    content: string,
    patch: Pick<Partial<GalleryConfig>, "orientation" | "columns" | "depth" | "showImage">,
): string | undefined {
    if (!parseConfig(content)) return;
    const keys = Object.keys(patch);
    if (keys.length !== 1 || !["orientation", "columns", "depth", "showImage"].includes(keys[0])) return;
    if (keys[0] === "orientation" && !["vertical", "horizontal"].includes(patch.orientation as string)) return;
    if (keys[0] === "columns" && !["auto", 1, 2, 3, 4].includes(patch.columns as string | number)) return;
    if (keys[0] === "depth" && ![1, 2, 3].includes(patch.depth as number)) return;
    if (keys[0] === "showImage" && typeof patch.showImage !== "boolean") return;
    return JSON.stringify({...JSON.parse(content), ...patch}, null, 2);
}

export function updateLayoutConfig(
    content: string,
    patch: Pick<Partial<GalleryConfig>, "orientation" | "columns">,
): string | undefined {
    if (Object.keys(patch).some(key => key !== "orientation" && key !== "columns")) return;
    return updateGalleryConfig(content, patch);
}

export function defaultBlockMarkdown(pluginName: string): string {
    const info = `${encodeURIComponent(pluginName)}/${encodeURIComponent(CUSTOM_BLOCK_TYPE)}`;
    // JSON escapes newlines in strings; no standalone closing-fence line can occur in this payload.
    return `;;;${info}\n${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n;;;`;
}
