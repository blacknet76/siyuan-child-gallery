import {fetchSyncPost} from "siyuan";
import type {EventBus} from "siyuan";
import {CUSTOM_BLOCK_TYPE} from "./config";

const BLOCK_ID = /^[0-9]{14}-[a-z0-9]{7}$/;

// The sole host-DOM compatibility boundary: SiYuan mounts directly inside its owning custom block.
export function getGalleryBlockId(mount: HTMLElement, pluginName: string): string | null {
    try {
        const host = mount.parentElement;
        const info = `${encodeURIComponent(pluginName)}/${encodeURIComponent(CUSTOM_BLOCK_TYPE)}`;
        if (!host || host.getAttribute("data-type") !== "NodeCustomBlock" || host.getAttribute("data-info") !== info) {
            return null;
        }
        const id = host.getAttribute("data-node-id");
        return typeof id === "string" && BLOCK_ID.test(id) ? id : null;
    } catch {
        return null;
    }
}

export async function resolveContainingDocumentId(blockId: string): Promise<string | null> {
    if (!BLOCK_ID.test(blockId)) {
        return null;
    }
    try {
        // Suppress host error notifications: context failure is represented by our localized status.
        const response: unknown = await fetchSyncPost("/api/block/getBlockInfo", {id: blockId}, undefined, false);
        if (!response || typeof response !== "object" || Array.isArray(response)) {
            return null;
        }
        const {code, data} = response as {code?: unknown; data?: unknown;};
        if (code !== 0 || !data || typeof data !== "object" || Array.isArray(data)) {
            return null;
        }
        const rootId = (data as {rootID?: unknown;}).rootID;
        return typeof rootId === "string" && BLOCK_ID.test(rootId) ? rootId : null;
    } catch {
        return null;
    }
}

// The DOM can render before its insertion reaches the kernel. A matching committed
// transaction permits exactly one new metadata lookup; the deadline only releases resources.
export function startContainingDocumentResolution(
    blockId: string,
    eventBus: Pick<EventBus, "on" | "off">,
    isCurrent: () => boolean,
): {result: Promise<string | null>; cancel: () => void;} {
    if (!BLOCK_ID.test(blockId) || !isCurrent()) {
        return {result: Promise.resolve(null), cancel: () => {}};
    }
    let settled = false;
    let confirm: (inserted: boolean) => void;
    const inserted = new Promise<boolean>(resolve => confirm = resolve);
    const finish = (committed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        eventBus.off("ws-main", onTransaction);
        confirm(committed);
    };
    const onTransaction = (event: CustomEvent<{cmd?: unknown; code?: unknown; data?: unknown;}>) => {
        if (!isCurrent()) {
            finish(false);
            return;
        }
        const message = event.detail;
        if (!message || message.cmd !== "transactions" || message.code !== 0 || !Array.isArray(message.data)) return;
        const matchingInsert = message.data.some(batch =>
            batch && Array.isArray(batch.doOperations) && batch.doOperations.some((operation: unknown) => {
                if (!operation || typeof operation !== "object") return false;
                const {action, id} = operation as {action?: unknown; id?: unknown;};
                return action === "insert" && id === blockId;
            })
        );
        if (matchingInsert) finish(true);
    };
    // Subscribe before the first request so an acknowledgement cannot be lost in flight.
    eventBus.on("ws-main", onTransaction);
    const deadline = setTimeout(() => finish(false), 5000);
    const cancel = () => finish(false);
    const result = (async () => {
        try {
            const rootId = await resolveContainingDocumentId(blockId);
            if (!isCurrent()) return null;
            if (rootId) return rootId;
            if (!await inserted || !isCurrent()) return null;
            return await resolveContainingDocumentId(blockId);
        } finally {
            cancel();
        }
    })();
    return {result, cancel};
}
