export const FALLBACK_PALETTE_COUNT = 14;

export interface FallbackCoverAppearance {
    palette: number;
    angle: number;
    stop: number;
}

// FNV-1a over the stable document ID; no title, randomness or persisted state.
export function fallbackCoverAppearance(id: string): FallbackCoverAppearance {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index++) {
        hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
    }
    const seed = hash >>> 0;
    return {
        palette: seed % FALLBACK_PALETTE_COUNT + 1,
        angle: (seed >>> 8) % 360,
        stop: 35 + (seed >>> 20) % 31,
    };
}
