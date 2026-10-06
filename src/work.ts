// Each invocation owns its cursor/workers; galleries never share queue or concurrency state.
export async function forEachLimited<T>(
    items: readonly T[],
    work: (item: T, index: number) => Promise<void>,
    isCurrent: () => boolean,
): Promise<void> {
    let cursor = 0;
    async function worker(): Promise<void> {
        while (isCurrent() && cursor < items.length) {
            const index = cursor++;
            await work(items[index], index);
        }
    }
    await Promise.all(Array.from({length: Math.min(4, items.length)}, worker));
}
