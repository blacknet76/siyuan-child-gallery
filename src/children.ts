import {fetchSyncPost} from "siyuan";
import type {GalleryConfig} from "./config";
import {forEachLimited} from "./work";

export type ChildDocument = {id: string; title: string;};
export type GalleryNode = ChildDocument & {children: GalleryNode[];};
type LocatedChild = ChildDocument & {path: string;};
type ParentWork = {path: string; node: GalleryNode;};
const ID = /^[0-9]{14}-[a-z0-9]{7}$/;
const DOCUMENT_PATH = /^(\/[0-9]{14}-[a-z0-9]{7})+\.sy$/;

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function responseData(response: unknown): Record<string, unknown> | null {
    return record(response) && response.code === 0 && record(response.data) ? response.data : null;
}

async function listChildren(notebook: string, path: string): Promise<LocatedChild[] | null> {
    try {
        // Omit sort at every level; retain native ordering/filtering without the configured list cap.
        const data = responseData(
            await fetchSyncPost(
                "/api/filetree/listDocsByPath",
                {notebook, path, maxListCount: 0},
                undefined,
                false,
            ),
        );
        if (!data || data.box !== notebook || data.path !== path || !Array.isArray(data.files)) return null;
        const children: LocatedChild[] = [];
        const seen = new Set<string>();
        for (const file of data.files) {
            if (
                !record(file) || typeof file.id !== "string" || !ID.test(file.id) ||
                typeof file.name !== "string" || seen.has(file.id) ||
                file.path !== `${path.slice(0, -3)}/${file.id}.sy`
            ) return null;
            seen.add(file.id);
            children.push({id: file.id, title: file.name, path: file.path as string});
        }
        return children;
    } catch {
        return null;
    }
}

// Paths are fresh query coordinates only. Depth bounds the iterations; queued work is render-local.
export async function resolveHierarchy(
    rootId: string,
    depth: GalleryConfig["depth"],
    isCurrent: () => boolean = () => true,
): Promise<GalleryNode[] | null> {
    if (!ID.test(rootId) || ![1, 2, 3].includes(depth) || !isCurrent()) return null;
    try {
        const location = responseData(await fetchSyncPost("/api/filetree/getPathByID", {id: rootId}, undefined, false));
        if (!isCurrent()) return null;
        if (
            !location || typeof location.notebook !== "string" || !ID.test(location.notebook) ||
            typeof location.path !== "string" || !DOCUMENT_PATH.test(location.path) ||
            !location.path.endsWith(`/${rootId}.sy`)
        ) return null;
        const {notebook, path} = location;
        const direct = await listChildren(notebook, path);
        if (!isCurrent() || !direct || direct.some(child => child.id === rootId)) return null;
        const seen = new Set([rootId]);
        function nodesAt(children: LocatedChild[]): ParentWork[] {
            return children.map(({id, title, path}) => {
                seen.add(id);
                return {path, node: {id, title, children: []}};
            });
        }
        let parents = nodesAt(direct);
        const nodes = parents.map(parent => parent.node);
        for (let level = 1; level < depth && parents.length; level++) {
            const results: (LocatedChild[] | null)[] = Array(parents.length).fill(null);
            await forEachLimited(parents, async (parent, index) => {
                results[index] = await listChildren(notebook, parent.path);
            }, isCurrent);
            if (!isCurrent()) return null;
            const next: ParentWork[] = [];
            // Merge in parent order, even when requests finish out of order; invalid branches stay empty.
            parents.forEach((parent, index) => {
                const children = results[index];
                if (!children || children.some(child => seen.has(child.id))) return;
                const nested = nodesAt(children);
                parent.node.children = nested.map(child => child.node);
                for (const child of nested) next.push(child);
            });
            parents = next;
        }
        return nodes;
    } catch {
        return null;
    }
}

export async function resolveDirectChildren(rootId: string): Promise<ChildDocument[] | null> {
    const nodes = await resolveHierarchy(rootId, 1);
    return nodes?.map(({id, title}) => ({id, title})) ?? null;
}
