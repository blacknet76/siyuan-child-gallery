import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import {runInNewContext} from "node:vm";
import ts from "typescript";

// Follow the official sample's node:test + TypeScript transpilation approach; no DOM/framework dependency.
const english = JSON.parse(readFileSync(new URL("../src/i18n/en.json", import.meta.url), "utf8"));
const german = JSON.parse(readFileSync(new URL("../src/i18n/de.json", import.meta.url), "utf8"));

function element(tag, ownerDocument) {
    let text = "";
    let source;
    return {
        tag,
        tagName: tag.toUpperCase(),
        get src() {
            return source;
        },
        set src(value) {
            this.handlersBeforeSource = Boolean(this.listeners.load && this.listeners.error);
            source = value;
        },
        nodeType: 1,
        ownerDocument,
        className: "",
        get textContent() {
            return text + this.children.map(child => child.textContent).join("");
        },
        set textContent(value) {
            text = value;
            this.replaceChildren();
        },
        children: [],
        get childNodes() {
            return this.children;
        },
        parent: undefined,
        attributes: {},
        attributeWrites: [],
        clientWidth: 128,
        clientHeight: 128,
        naturalWidth: 0,
        naturalHeight: 0,
        listeners: {},
        style: {
            setProperty(name, value) {
                this[name] = value;
            },
            getPropertyValue(name) {
                return this[name] ?? "";
            },
        },
        setAttribute(key, value) {
            this.attributeWrites.push([key, value]);
            this.attributes[key] = value;
        },
        getAttribute(key) {
            return this.attributes[key] ?? null;
        },
        addEventListener(type, listener) {
            this.listeners[type] = listener;
        },
        removeEventListener(type, listener) {
            if (this.listeners[type] === listener) delete this.listeners[type];
        },
        getBoundingClientRect() {
            return {right: 700, bottom: 150};
        },
        get innerHTML() {
            return this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        },
        set innerHTML(value) {
            this.fixedHTML = value;
        },
        click() {
            this.listeners.click?.();
        },
        contains(node) {
            return node === this || this.children.some(child => child.contains?.(node));
        },
        get parentElement() {
            return this.parent || null;
        },
        get isConnected() {
            return this.connected ?? this.parent?.isConnected ?? false;
        },
        get outerHTML() {
            const text = this.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(
                ">",
                "&gt;",
            );
            return `<${tag} class="${this.className}">${text}</${tag}>`;
        },
        append(...children) {
            for (const child of children) {
                child.remove?.();
                child.parent = this;
                this.children.push(child);
            }
        },
        insertBefore(child, anchor) {
            child.parent = this;
            this.children.splice(this.children.indexOf(anchor), 0, child);
        },
        replaceChildren(...children) {
            this.children.forEach(child => child.parent = undefined);
            this.children = [];
            this.append(...children);
        },
        remove() {
            if (this.parent) {
                this.parent.children = this.parent.children.filter(child => child !== this);
                this.parent = undefined;
            }
        },
    };
}

function loadPlugin(
    i18n = english,
    fetchSyncPost = () => assert.fail("Unexpected kernel request"),
    navigation = {},
    previewFragments = new Map(),
) {
    // Native template HTML parsing is verified in the live browser. Unit fixtures supply its inert node tree.
    const observers = [];
    const icons = [];
    const registeredIcons = new Map();
    class ResizeObserver {
        constructor(callback) {
            this.callback = callback;
            observers.push(this);
        }
        observe(target) {
            this.target = target;
        }
        disconnect() {
            this.disconnected = true;
        }
        emit(width = this.target.clientWidth, height = this.target.clientHeight) {
            this.target.clientWidth = width;
            this.target.clientHeight = height;
            this.callback([{target: this.target}]); // Also permits deliberately late deliveries.
        }
    }
    const document = {
        defaultView: {ResizeObserver},
        baseURI: "http://siyuan.example.org/",
        getElementById(id) {
            return registeredIcons.get(id) ?? null;
        },
        createElement(tag) {
            if (tag === "template") {
                return {
                    set innerHTML(html) {
                        this.content = previewFragments.get(html) ?? {children: []};
                    },
                };
            }
            return element(tag, document);
        },
    };
    const deadlines = new Map();
    const eventBus = {
        listeners: new Set(),
        on(type, listener) {
            assert.equal(type, "ws-main");
            this.listeners.add(listener);
        },
        off(type, listener) {
            assert.equal(type, "ws-main");
            this.listeners.delete(listener);
        },
        emit(detail) {
            for (const listener of [...this.listeners]) listener({detail});
        },
    };
    class Plugin {
        name = "siyuan-child-gallery";
        app = {testApp: true};
        eventBus = eventBus;
        i18n = i18n;
        customBlockRenders = {};
        addIcons(svg) {
            icons.push(svg);
            registeredIcons.set(svg.match(/<symbol id="([^"]+)"/)[1], {});
        }
    }
    const menus = [];
    let sharedMenu;
    class Menu {
        items = [];
        constructor(id, closeCB) {
            sharedMenu?.close();
            this.closeCB = closeCB;
            // Model SiYuan's shared native Menu solely within this test fixture.
            // eslint-disable-next-line @typescript-eslint/no-this-alias
            sharedMenu = this;
            menus.push(this);
        }
        addItem(item) {
            this.items.push(item);
        }
        open(position) {
            this.position = position;
        }
        fullscreen() {
            this.fullscreenCalled = true;
        }
        close() {
            this.closed = true;
            if (sharedMenu === this) sharedMenu = undefined;
            const callback = this.closeCB;
            this.closeCB = undefined;
            callback?.();
        }
    }
    const cache = new Map();
    function load(url) {
        if (cache.has(url.href)) return cache.get(url.href);
        const exports = {};
        cache.set(url.href, exports);
        const source = readFileSync(url, "utf8");
        const code = ts.transpileModule(source, {
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true},
        }).outputText;
        runInNewContext(code, {
            exports,
            document,
            URL,
            setTimeout(callback, delay) {
                const id = {};
                deadlines.set(id, {callback, delay});
                return id;
            },
            clearTimeout(id) {
                deadlines.delete(id);
            },
            require(name) {
                if (name === "siyuan") {
                    return {
                        Plugin,
                        Menu,
                        fetchSyncPost,
                        getFrontend: () => "browser-desktop",
                        openTab: () => assert.fail("Unexpected navigation"),
                        ...navigation,
                    };
                }
                if (name.endsWith(".scss")) return {};
                if (name.endsWith(".svg")) return readFileSync(new URL(name, url), "utf8");
                const dependency = new URL(name.endsWith(".json") ? name : `${name}.ts`, url);
                if (name.endsWith(".json")) return JSON.parse(readFileSync(dependency, "utf8"));
                return load(dependency);
            },
        });
        return exports;
    }
    const plugin = new (load(new URL("../src/index.ts", import.meta.url)).default)();
    plugin.onload();
    return {
        plugin,
        icons,
        observers,
        menus,
        document,
        deadlines,
        expireDeadline() {
            for (const [id, {callback}] of [...deadlines]) {
                deadlines.delete(id);
                callback();
            }
        },
        config: load(new URL("../src/config.ts", import.meta.url)),
        context: load(new URL("../src/context.ts", import.meta.url)),
        children: load(new URL("../src/children.ts", import.meta.url)),
        preview: load(new URL("../src/preview.ts", import.meta.url)),
        fallback: load(new URL("../src/fallback.ts", import.meta.url)),
    };
}

test("approved functional SVG preserves viewBox/currentColor geometry in one plugin-level symbol", () => {
    const svg = readFileSync(new URL("../src/icons/icon-child-gallery.svg", import.meta.url), "utf8");
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.match(svg, /stroke="currentColor"/);
    assert.match(svg, /fill="none"/);
    assert.doesNotMatch(svg, /<(?:image|script|style|text|foreignObject|use)\b|\bon\w+=|\bhref=|url\(|@font-face/i);
    assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /https?:|data:|file:/i);
    const {plugin, icons} = loadPlugin();
    assert.equal(icons.length, 1);
    const original = icons[0].replace('<symbol id="icon-siyuan-child-gallery-insert"', "<svg").replace(
        "</symbol>",
        "</svg>",
    );
    const normalize = value => value.replace(/>\s+</g, "><").trim();
    assert.equal(normalize(original), normalize(svg)); // Every root/shape attribute, without irrelevant whitespace.
    plugin.onload();
    assert.equal(icons.length, 1); // Existing global symbol is reused on plugin reload.
});

test("only the two existing Child Gallery insertion surfaces use the plugin-owned icon", () => {
    const {plugin} = loadPlugin();
    assert.equal(plugin.protyleSlash.length, 1);
    assert.match(plugin.protyleSlash[0].html, /<use xlink:href="#icon-siyuan-child-gallery-insert"/);
    assert.doesNotMatch(plugin.protyleSlash[0].html, /#iconAdd/);
    const toolbar = plugin.updateProtyleToolbar([]);
    assert.equal(toolbar.length, 1);
    assert.equal(toolbar[0].icon, "icon-siyuan-child-gallery-insert");
});

test("gallery/card rendering does not register icons and keeps the native settings gear", () => {
    const {plugin, icons, document, config} = loadPlugin();
    for (let index = 0; index < 2; index++) {
        const mount = document.createElement("div");
        const dispose = plugin.customBlockRenders["child-gallery"].render({
            element: mount,
            content: JSON.stringify(config.DEFAULT_CONFIG),
            setContent: () => true,
        });
        const header = mount.children[0].children[0];
        assert.match(header.children[1].fixedHTML, /href="#iconSettings"/);
        assert.equal(icons.length, 1);
        dispose();
    }
});

test("slash and toolbar insert the same namespaced configuration-only block through native conversion", () => {
    const {plugin} = loadPlugin();
    const inserted = [];
    const converted = [];
    const editor = {
        protyle: {
            disabled: false,
            lute: {
                Md2BlockDOM(markdown) {
                    converted.push(markdown);
                    return "host-converted-block";
                },
            },
        },
        insert: (...args) => inserted.push(args),
    };
    plugin.protyleSlash[0].callback(editor);
    plugin.updateProtyleToolbar([])[0].click(editor);
    assert.deepEqual(converted.slice(0, 1), converted.slice(1));
    assert.deepEqual(inserted, [["host-converted-block", true], ["host-converted-block", true]]);
    const lines = converted[0].split("\n");
    assert.equal(lines.shift(), ";;;siyuan-child-gallery/child-gallery");
    assert.equal(lines.pop(), ";;;");
    const persisted = JSON.parse(lines.join("\n"));
    assert.deepEqual(persisted, {
        version: 1,
        source: "children",
        depth: 1,
        orientation: "vertical",
        columns: "auto",
        showImage: true,
        showDescription: true,
    });
});

test("toolbar preserves existing plugin items and is safe to apply repeatedly", () => {
    const {plugin} = loadPlugin();
    const otherPlugin = {name: "other-plugin-action", click() {}};
    const existing = ["strong", "|", otherPlugin];
    const toolbar = plugin.updateProtyleToolbar(existing);
    assert.equal(existing.length, 3);
    assert.equal(toolbar.length, 4);
    assert.equal(toolbar[2], otherPlugin);
    assert.equal(plugin.updateProtyleToolbar(toolbar).length, 4);
});

test("both insertion paths refuse disabled editors and unavailable converters", () => {
    const {plugin} = loadPlugin();
    for (const protyle of [{disabled: true, lute: {}}, {disabled: false}]) {
        const editor = {protyle, insert: () => assert.fail("Must not modify document")};
        plugin.protyleSlash[0].callback(editor);
        plugin.updateProtyleToolbar([])[0].click(editor);
    }
});

test("unsupported and malformed persisted data is rejected without writes or HTML interpretation", () => {
    const {plugin, document, config} = loadPlugin();
    const render = plugin.customBlockRenders["child-gallery"].render;
    const mount = document.createElement("div");
    const sibling = document.createElement("div");
    sibling.textContent = "User content";
    const parent = document.createElement("div");
    parent.append(mount, sibling);
    for (
        const content of [
            "not JSON",
            "null",
            "[]",
            "{}",
            '<img src=x onerror="alert(1)">',
            JSON.stringify({...config.DEFAULT_CONFIG, version: 2}),
            JSON.stringify({...config.DEFAULT_CONFIG, depth: "1"}),
            JSON.stringify({...config.DEFAULT_CONFIG, source: "tags"}),
            JSON.stringify({...config.DEFAULT_CONFIG, showImage: "true"}),
        ]
    ) {
        assert.equal(config.parseConfig(content), undefined);
        const dispose = render({element: mount, content, setContent: () => assert.fail("Must preserve saved data")});
        assert.equal(mount.children[0].children[1].textContent, english.invalidConfig);
        dispose();
        dispose();
        assert.equal(mount.children.length, 0);
        assert.equal(sibling.textContent, "User content");
        assert.equal(parent.children.length, 2);
    }
});

test("English and German localize slash, toolbar, and gallery states; missing keys fall back to English", () => {
    assert.deepEqual(Object.keys(german).sort(), Object.keys(english).sort());
    for (const messages of [english, german, {galleryName: "", invalidConfig: 123}]) {
        const {plugin, document, config} = loadPlugin(messages);
        const name = messages.galleryName || english.galleryName;
        assert.ok(plugin.protyleSlash[0].html.includes(name));
        assert.equal(plugin.updateProtyleToolbar([])[0].tip, name);
        const mount = document.createElement("div");
        const content = JSON.stringify(config.DEFAULT_CONFIG);
        plugin.customBlockRenders["child-gallery"].render({element: mount, content});
        assert.equal(mount.children[0].children[0].textContent, name);
        assert.ok(config.parseConfig(content));
        assert.equal(
            mount.children[0].children[1].textContent,
            messages.contextUnavailable || english.contextUnavailable,
        );
    }
});

test("block info URI-encodes plugin name and slash markup escapes localized labels", () => {
    const {plugin, config} = loadPlugin({...english, galleryName: "<script>& Gallery"});
    assert.ok(config.defaultBlockMarkdown("example/name").startsWith(";;;example%2Fname/child-gallery\n"));
    assert.ok(plugin.protyleSlash[0].html.includes("&lt;script&gt;&amp; Gallery"));
    assert.ok(!plugin.protyleSlash[0].html.includes("<script>"));
});

test("unowned mounts fail closed without editor discovery or changing saved content", () => {
    const {plugin, document, config} = loadPlugin();
    const render = plugin.customBlockRenders["child-gallery"].render;
    const otherDocument = {createElement: tag => element(tag, otherDocument)};
    const content = JSON.stringify(config.DEFAULT_CONFIG);
    // Two mounts in one document, another in a different document, all with identical configuration.
    const mounts = [document.createElement("div"), document.createElement("div"), otherDocument.createElement("div")];
    const disposers = [];
    for (const mount of mounts) {
        for (const key of ["parentNode", "dataset", "closest", "querySelector", "getAttribute"]) {
            Object.defineProperty(mount, key, {get: () => assert.fail(`Must not inspect mount internals: ${key}`)});
        }
        const dispose = render({
            element: mount,
            content,
            setContent: () => assert.fail("Context status must not rewrite configuration"),
        });
        assert.equal(mount.children[0].children[1].textContent, english.contextUnavailable);
        assert.equal(mount.children[0].ownerDocument, mount.ownerDocument);
        disposers.push(dispose);
    }
    disposers[0]();
    assert.equal(mounts[0].children.length, 0);
    assert.equal(mounts[1].children.length, 1);
    assert.equal(mounts[2].children.length, 1);
    disposers.slice(1).forEach(dispose => dispose());
});

test("German resources use SiYuan's current de locale rather than an unmatched de-DE tag", () => {
    const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
    assert.equal(manifest.displayName.de, german.galleryName);
    assert.equal(manifest.readme.de, "README.siyuan.de-DE.md");
    assert.ok(manifest.description.de);
});

// All fixture IDs use the synthetic 2000-01-01 prefix; no IDs or note content come from a workspace.
const BLOCK_A = "20000101000000-blockaa";
const BLOCK_B = "20000101000000-blockab";
const ROOT_A = "20000101000001-rootaaa";
const ROOT_B = "20000101000001-rootaab";

function galleryMount(document, id = BLOCK_A, info = "siyuan-child-gallery/child-gallery", type = "NodeCustomBlock") {
    const host = document.createElement("div");
    host.connected = true;
    const attributes = {"data-type": type, "data-info": info, "data-node-id": id};
    host.getAttribute = key => attributes[key] ?? null;
    // A valid result must not require an ancestor or selector search.
    for (const key of ["parentElement", "parentNode", "closest", "querySelector"]) {
        Object.defineProperty(host, key, {get: () => assert.fail(`Forbidden owner inspection: ${key}`)});
    }
    const mount = document.createElement("div");
    host.append(mount);
    return mount;
}

async function settleContext() {
    await new Promise(resolve => setImmediate(resolve));
}

test("identity adapter accepts only the immediate matching Child Gallery host", () => {
    const {context, document} = loadPlugin();
    assert.equal(context.getGalleryBlockId(galleryMount(document), "siyuan-child-gallery"), BLOCK_A);
    assert.equal(
        context.getGalleryBlockId(galleryMount(document, BLOCK_A, "example%2Fname/child-gallery"), "example/name"),
        BLOCK_A,
    );
    const invalid = [
        document.createElement("div"),
        galleryMount(document, BLOCK_A, undefined, "NodeParagraph"),
        galleryMount(document, BLOCK_A, "another-plugin/child-gallery"),
        galleryMount(document, BLOCK_A, "siyuan-child-gallery/other-type"),
        galleryMount(document, BLOCK_A, ""),
        galleryMount(document, null),
        galleryMount(document, ""),
        galleryMount(document, "not-a-block-id"),
        galleryMount(document, "20000101000000-BLOCKaa"),
        galleryMount(document, ` ${BLOCK_A}`),
    ];
    for (const mount of invalid) assert.equal(context.getGalleryBlockId(mount, "siyuan-child-gallery"), null);
});

test("document resolver uses the official block metadata request and validates root identity", async () => {
    const requests = [];
    const {context} = loadPlugin(english, async (...args) => {
        requests.push(args);
        return {code: 0, data: {rootID: ROOT_A}};
    });
    assert.equal(await context.resolveContainingDocumentId(BLOCK_A), ROOT_A);
    assert.equal(requests[0][0], "/api/block/getBlockInfo");
    assert.equal(JSON.stringify(requests[0][1]), JSON.stringify({id: BLOCK_A}));
    assert.equal(requests[0][2], undefined);
    assert.equal(requests[0][3], false); // No host error toasts; unavailable status owns this failure.
    assert.equal(await context.resolveContainingDocumentId("invalid"), null);
    assert.equal(requests.length, 1);
});

test("document resolver returns unavailable for API failure and unexpected response shapes", async () => {
    const responses = [
        null,
        undefined,
        "bad JSON",
        [],
        {},
        {code: -1, data: {rootID: ROOT_A}},
        {code: 3, data: null},
        {code: "0", data: {rootID: ROOT_A}},
        {code: 0},
        {code: 0, data: null},
        {code: 0, data: []},
        {code: 0, data: {}},
        {code: 0, data: {rootID: 123}},
        {code: 0, data: {rootID: ""}},
        {code: 0, data: {rootID: "bad-id"}},
        {code: 0, data: {rootID: `${ROOT_A} `}},
    ];
    const {context} = loadPlugin(english, async () => responses.shift());
    while (responses.length) assert.equal(await context.resolveContainingDocumentId(BLOCK_A), null);
    for (
        const request of [() => {
            throw new Error("request failed");
        }, async () => {
            throw new Error("network failed");
        }]
    ) {
        const {context: failed} = loadPlugin(english, request);
        assert.equal(await failed.resolveContainingDocumentId(BLOCK_A), null);
    }
});

const CHILD_A1 = "20000101000002-childaa";
const CHILD_A2 = "20000101000002-childab";
const CHILD_B1 = "20000101000002-childac";
const NOTEBOOK = "20000101000003-notebaa";
const pathFor = root => `/${root}.sy`;
const location = root => ({code: 0, data: {notebook: NOTEBOOK, path: pathFor(root)}});
const file = (root, id, name) => ({id, name, path: `/${root}/${id}.sy`});
const listing = (root, files = []) => ({code: 0, data: {box: NOTEBOOK, path: pathFor(root), files}});

function kernelResponse(url, body) {
    if (url === "/api/block/getBlockDOM") return {code: 0, data: {id: body.id, dom: ""}};
    if (url === "/api/block/getBlockInfo") return {code: 0, data: {rootID: body.id === BLOCK_B ? ROOT_B : ROOT_A}};
    if (url === "/api/filetree/getPathByID") return location(body.id);
    if (url === "/api/filetree/listDocsByPath") {
        const root = body.path === pathFor(ROOT_B) ? ROOT_B : ROOT_A;
        return listing(
            root,
            root === ROOT_A ?
                [file(root, CHILD_A2, "Second & <title>.sy"), file(root, CHILD_A1, "First")] :
                [file(root, CHILD_B1, "Other")],
        );
    }
    assert.fail(`Unexpected endpoint ${url}`);
}

function renderMount(
    loaded,
    blockId = BLOCK_A,
    config = loaded.config.DEFAULT_CONFIG,
    setContent = () => assert.fail("Rendering must never persist derived data"),
) {
    const mount = galleryMount(loaded.document, blockId);
    const dispose = loaded.plugin.customBlockRenders["child-gallery"].render({
        element: mount,
        content: JSON.stringify(config),
        setContent,
    });
    return {mount, dispose, status: mount.children[0].children[1]};
}
const cards = mount => mount.children[0].children[2]?.children ?? [];

test("direct-child helper uses current path, native order, unlimited direct listing and literal titles", async () => {
    const requests = [];
    const loaded = loadPlugin(english, async (...args) => {
        requests.push(args);
        return kernelResponse(...args);
    });
    const result = await loaded.children.resolveDirectChildren(ROOT_A);
    assert.equal(
        JSON.stringify(result),
        JSON.stringify([
            {id: CHILD_A2, title: "Second & <title>.sy"},
            {id: CHILD_A1, title: "First"},
        ]),
    );
    assert.equal(requests.length, 2); // No calls for descendants, even when a child itself has children.
    assert.equal(requests[0][0], "/api/filetree/getPathByID");
    assert.equal(JSON.stringify(requests[0][1]), JSON.stringify({id: ROOT_A}));
    assert.equal(requests[1][0], "/api/filetree/listDocsByPath");
    assert.equal(
        JSON.stringify(requests[1][1]),
        JSON.stringify({notebook: NOTEBOOK, path: pathFor(ROOT_A), maxListCount: 0}),
    );
    requests.forEach(request => {
        assert.equal(request[2], undefined);
        assert.equal(request[3], false);
    });
});

test("no direct children is an empty success, including a leaf document", async () => {
    const loaded = loadPlugin(english, async url => url.endsWith("getPathByID") ? location(ROOT_A) : listing(ROOT_A));
    assert.equal(JSON.stringify(await loaded.children.resolveDirectChildren(ROOT_A)), "[]");
});

test("child discovery rejects failed/malformed path responses and invalid root IDs without listing", async () => {
    for (
        const response of [
            null,
            [],
            {},
            {code: -1},
            {code: "0", data: {}},
            {code: 0, data: "legacy-string"},
            {code: 0, data: {notebook: NOTEBOOK, path: "/wrong.sy"}},
            {code: 0, data: {notebook: "invalid", path: pathFor(ROOT_A)}},
            location(ROOT_B),
        ]
    ) {
        const requests = [];
        const loaded = loadPlugin(english, async (...args) => {
            requests.push(args);
            return response;
        });
        assert.equal(await loaded.children.resolveDirectChildren(ROOT_A), null);
        assert.equal(requests.length, 1);
        assert.equal(await loaded.children.resolveDirectChildren("invalid"), null);
        assert.equal(requests.length, 1);
    }
});

test("child discovery fails safely on either request failure and malformed/non-direct listings", async () => {
    const malformed = [
        null,
        [],
        {},
        {code: -1},
        {code: 0, data: {}},
        listing(ROOT_B),
        listing(ROOT_A, null),
        listing(ROOT_A, [{}]),
        listing(ROOT_A, [file(ROOT_A, "invalid", "Title")]),
        listing(ROOT_A, [file(ROOT_A, CHILD_A1, 123)]),
        listing(ROOT_A, [{...file(ROOT_A, CHILD_A1, "Nested"), path: `/${ROOT_A}/${CHILD_A2}/${CHILD_A1}.sy`}]),
        listing(ROOT_A, [file(ROOT_A, CHILD_A1, "Duplicate"), file(ROOT_A, CHILD_A1, "Duplicate")]),
    ];
    for (const response of malformed) {
        const loaded = loadPlugin(english, async url => url.endsWith("getPathByID") ? location(ROOT_A) : response);
        assert.equal(await loaded.children.resolveDirectChildren(ROOT_A), null);
    }
    for (const stage of ["getPathByID", "listDocsByPath"]) {
        for (const asynchronous of [false, true]) {
            const loaded = loadPlugin(english, url => {
                if (url.endsWith(stage)) {
                    if (asynchronous) return Promise.reject(new Error("Private API error"));
                    throw new Error("Private API error");
                }
                return location(ROOT_A);
            });
            assert.equal(await loaded.children.resolveDirectChildren(ROOT_A), null);
        }
    }
});

test("renderer shows localized loading, title-only native buttons and opens each exact ID", async () => {
    for (const messages of [english, german]) {
        const opened = [];
        const loaded = loadPlugin(messages, async (...args) => kernelResponse(...args), {
            openTab: async options => opened.push(options),
        });
        const {mount, status, dispose} = renderMount(loaded);
        assert.equal(status.textContent, messages.loadingChildren);
        assert.equal(status.attributes.role, "status");
        assert.equal(mount.children[0].attributes["aria-busy"], "true");
        await settleContext();
        assert.equal(status.textContent, "");
        assert.equal(mount.children[0].attributes["aria-busy"], "false");
        assert.deepEqual(cards(mount).map(card => card.textContent), ["Second & <title>.sy", "First"]);
        cards(mount).forEach(card => {
            assert.equal(card.tag, "button");
            assert.equal(card.type, "button");
        });
        cards(mount)[0].click();
        cards(mount)[1].click();
        await settleContext();
        assert.deepEqual(opened.map(options => options.doc.id), [CHILD_A2, CHILD_A1]);
        assert.ok(opened.every(options => options.app === loaded.plugin.app));
        const oldCard = cards(mount)[0];
        dispose();
        oldCard.click();
        assert.equal(opened.length, 2);
    }
});

test("mobile cards use the public mobile navigation API with the child's ID", async () => {
    for (const frontend of ["mobile", "browser-mobile"]) {
        const opened = [];
        const loaded = loadPlugin(english, async (...args) => kernelResponse(...args), {
            getFrontend: () => frontend,
            openMobileFileById: (...args) => opened.push(args),
        });
        const {mount} = renderMount(loaded);
        await settleContext();
        cards(mount)[1].click();
        assert.deepEqual(opened, [[loaded.plugin.app, CHILD_A1]]);
    }
});

test("empty, unavailable context and child failure have distinct localized safe states", async () => {
    for (const messages of [english, german]) {
        for (const state of ["empty", "context", "children"]) {
            const loaded = loadPlugin(messages, async (url, body) => {
                if (state === "context") return {code: -1};
                if (url.endsWith("listDocsByPath")) return state === "empty" ? listing(ROOT_A) : {code: -1};
                return kernelResponse(url, body);
            });
            const {mount, status} = renderMount(loaded);
            await settleContext();
            if (state === "context") {
                loaded.expireDeadline();
                await settleContext();
            }
            assert.equal(
                status.textContent,
                state === "empty" ?
                    messages.noChildren :
                    state === "context" ?
                    messages.contextUnavailable :
                    messages.childrenUnavailable,
            );
            assert.equal(cards(mount).length, 0);
        }
    }
});

test("invalid persisted depths fail safely without context/discovery requests", () => {
    for (const messages of [english, german]) {
        const loaded = loadPlugin(messages);
        for (const depth of [0, 4, -1, 2.5, "2", null]) {
            const {status} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth});
            assert.equal(status.textContent, messages.invalidConfig);
        }
    }
});

test("empty titles have a localized fallback and navigation rejection remains inside the gallery", async () => {
    for (const messages of [english, german]) {
        let reject;
        const loaded = loadPlugin(messages, async (url, body) =>
            url.endsWith("listDocsByPath") ?
                listing(ROOT_A, [file(ROOT_A, CHILD_A1, "")]) :
                kernelResponse(url, body), {
            openTab: () => new Promise((_resolve, rejection) => reject = rejection),
        });
        const {mount, status, dispose} = renderMount(loaded);
        await settleContext();
        assert.equal(cards(mount)[0].textContent, messages.untitledDocument);
        cards(mount)[0].click();
        reject(new Error("Private detail"));
        await settleContext();
        assert.equal(status.textContent, messages.openUnavailable);
        cards(mount)[0].click();
        status.textContent = "";
        dispose();
        reject(new Error("Private detail"));
        await settleContext();
        assert.equal(status.textContent, "");
    }
});

test("context completion cannot start child discovery for disposed/detached/replaced renders", async () => {
    for (const action of ["dispose", "detach", "replace", "rerender"]) {
        const pending = [];
        const childRequests = [];
        const loaded = loadPlugin(english, (url, body) => {
            if (url.endsWith("getBlockInfo")) return new Promise(resolve => pending.push(resolve));
            childRequests.push(url);
            return kernelResponse(url, body);
        });
        const {mount, status, dispose} = renderMount(loaded);
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        if (action === "rerender") {
            loaded.plugin.customBlockRenders["child-gallery"].render({
                element: mount,
                content: JSON.stringify(loaded.config.DEFAULT_CONFIG),
            });
        }
        pending[0]({code: 0, data: {rootID: ROOT_A}});
        await settleContext();
        assert.equal(status.textContent, english.loadingChildren);
        assert.deepEqual(childRequests, []);
        if (action === "rerender") {
            pending[1]({code: 0, data: {rootID: ROOT_B}});
            await settleContext();
            assert.deepEqual(cards(mount).map(card => card.textContent), ["Other"]);
        }
        dispose();
    }
});

test("pending child results cannot update disposed/detached/replaced/rerendered galleries", async () => {
    for (const action of ["dispose", "detach", "replace", "rerender"]) {
        const pending = [];
        const loaded = loadPlugin(english, (url, body) =>
            url.endsWith("listDocsByPath") ?
                new Promise(resolve => pending.push({resolve, root: body.path === pathFor(ROOT_B) ? ROOT_B : ROOT_A})) :
                kernelResponse(url, body));
        const {mount, status, dispose} = renderMount(loaded);
        await settleContext();
        const oldGallery = mount.children[0];
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        if (action === "rerender") {
            loaded.plugin.customBlockRenders["child-gallery"].render({
                element: mount,
                content: JSON.stringify(loaded.config.DEFAULT_CONFIG),
            });
        }
        pending[0].resolve(listing(ROOT_A, [file(ROOT_A, CHILD_A1, "Old")]));
        await settleContext();
        assert.equal(status.textContent, english.loadingChildren);
        assert.equal(oldGallery.children.length, 2);
        if (action === "rerender") {
            pending[1].resolve(listing(ROOT_A, [file(ROOT_A, CHILD_A2, "New")]));
            await settleContext();
            dispose(); // Old cleanup must not remove the successor.
            assert.deepEqual(cards(mount).map(card => card.textContent), ["New"]);
        }
        dispose();
    }
});

test("different roots and multiple blocks/editor copies have independent out-of-order child sets", async () => {
    const pending = [];
    const opened = [];
    const loaded = loadPlugin(english, (url, body) =>
        url.endsWith("listDocsByPath") ?
            new Promise(resolve => pending.push({body, resolve})) :
            kernelResponse(url, body), {
        openTab: async options => opened.push(options.doc.id),
    });
    const instances = [renderMount(loaded, BLOCK_A), renderMount(loaded, BLOCK_B), renderMount(loaded, BLOCK_A)];
    await settleContext();
    assert.deepEqual(pending.map(request => request.body.path), [pathFor(ROOT_A), pathFor(ROOT_B), pathFor(ROOT_A)]);
    pending[1].resolve(listing(ROOT_B, [file(ROOT_B, CHILD_B1, "B1")]));
    await settleContext();
    assert.deepEqual(cards(instances[1].mount).map(card => card.textContent), ["B1"]);
    assert.equal(cards(instances[0].mount).length, 0);
    instances[0].dispose();
    pending[2].resolve(listing(ROOT_A, [file(ROOT_A, CHILD_A1, "A1")]));
    pending[0].resolve(listing(ROOT_A, [file(ROOT_A, CHILD_A2, "Disposed")]));
    await settleContext();
    assert.deepEqual(cards(instances[2].mount).map(card => card.textContent), ["A1"]);
    cards(instances[1].mount)[0].click();
    cards(instances[2].mount)[0].click();
    await settleContext();
    assert.deepEqual(opened, [CHILD_B1, CHILD_A1]);
    assert.equal(instances[0].mount.children.length, 0);
});

test("a nested/moved document uses its freshly resolved ID path rather than cached title or location", async () => {
    let path = `/${ROOT_B}/${ROOT_A}.sy`;
    let title = "Before rename";
    const requests = [];
    const loaded = loadPlugin(english, async (url, body) => {
        requests.push({url, body});
        return url.endsWith("getPathByID") ?
            {code: 0, data: {notebook: NOTEBOOK, path}} :
            {
                code: 0,
                data: {
                    box: NOTEBOOK,
                    path,
                    files: [{id: CHILD_A1, name: title, path: `${path.slice(0, -3)}/${CHILD_A1}.sy`}],
                },
            };
    });
    assert.equal((await loaded.children.resolveDirectChildren(ROOT_A))[0].title, "Before rename");
    path = pathFor(ROOT_A);
    title = "After rename";
    assert.equal((await loaded.children.resolveDirectChildren(ROOT_A))[0].title, "After rename");
    assert.equal(requests.length, 4);
    assert.equal(requests[1].body.path, `/${ROOT_B}/${ROOT_A}.sy`);
    assert.equal(requests[3].body.path, pathFor(ROOT_A));
});

const insertionCommitted = id => ({cmd: "transactions", code: 0, data: [{doOperations: [{action: "insert", id}]}]});

test("fresh render survives block-not-found until its own insertion commit, without rereopening", async () => {
    for (const messages of [english, german]) {
        let committed = false;
        const requests = [];
        const loaded = loadPlugin(messages, async (url, body) => {
            requests.push({url, body});
            if (url.endsWith("getBlockInfo") && !committed) return {code: -1, data: null};
            return kernelResponse(url, body);
        });
        const {mount, status} = renderMount(loaded);
        const originalGallery = mount.children[0];
        await settleContext();
        assert.equal(status.textContent, messages.loadingChildren);
        assert.equal(requests.length, 1);
        assert.equal(loaded.plugin.eventBus.listeners.size, 1);
        assert.deepEqual([...loaded.deadlines.values()].map(item => item.delay), [5000]);
        for (
            const unrelated of [
                null,
                {},
                {cmd: "transactions", code: 0, data: {}},
                {...insertionCommitted(BLOCK_A), code: -1},
                {...insertionCommitted(BLOCK_A), cmd: "other"},
                insertionCommitted(BLOCK_B),
                {cmd: "transactions", code: 0, data: [{doOperations: [null, {}, {action: "update", id: BLOCK_A}]}]},
            ]
        ) {
            loaded.plugin.eventBus.emit(unrelated);
        }
        await settleContext();
        assert.equal(requests.length, 1); // No retries due to elapsed time, errors or unrelated transactions.
        committed = true;
        loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
        await settleContext();
        assert.equal(mount.children[0], originalGallery);
        assert.equal(status.textContent, "");
        assert.deepEqual(cards(mount).map(card => card.textContent), ["Second & <title>.sy", "First"]);
        assert.equal(requests.filter(request => request.url.endsWith("getBlockInfo")).length, 2);
        assert.equal(loaded.plugin.eventBus.listeners.size, 0);
        assert.equal(loaded.deadlines.size, 0);
        loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
        loaded.expireDeadline();
        await settleContext();
        assert.equal(requests.length, 6); // Metadata/location/listing plus one preview read per child, never refresh again.
    }
});

test("insertion acknowledgement arriving while the first failing request is in flight is retained", async () => {
    let first;
    let metadataCalls = 0;
    const loaded = loadPlugin(english, (url, body) => {
        if (url.endsWith("getBlockInfo") && ++metadataCalls === 1) return new Promise(resolve => first = resolve);
        return kernelResponse(url, body);
    });
    const {mount} = renderMount(loaded);
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
    first({code: -1, data: null});
    await settleContext();
    assert.equal(metadataCalls, 2);
    assert.equal(cards(mount).length, 2);
});

test("existing committed blocks resolve immediately and remove the unused commit watch", async () => {
    let metadataCalls = 0;
    const loaded = loadPlugin(english, (url, body) => {
        if (url.endsWith("getBlockInfo")) metadataCalls++;
        return kernelResponse(url, body);
    });
    const {mount} = renderMount(loaded);
    await settleContext();
    assert.equal(cards(mount).length, 2);
    assert.equal(metadataCalls, 1);
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
});

test("missing insertion commit times out safely without another API request or lingering listener", async () => {
    let requests = 0;
    const loaded = loadPlugin(english, async () => {
        requests++;
        return {code: -1, data: null};
    });
    const {status} = renderMount(loaded);
    await settleContext();
    assert.equal(status.textContent, english.loadingChildren);
    loaded.expireDeadline();
    await settleContext();
    assert.equal(status.textContent, english.contextUnavailable);
    assert.equal(requests, 1);
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
    await settleContext();
    assert.equal(requests, 1);
});

test("a matching commit does not hide a genuinely unresolvable block: only one requery is allowed", async () => {
    let requests = 0;
    const loaded = loadPlugin(german, async () => {
        requests++;
        return {code: 0, data: {rootID: "invalid"}};
    });
    const {status} = renderMount(loaded);
    await settleContext();
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
    await settleContext();
    assert.equal(status.textContent, german.contextUnavailable);
    assert.equal(requests, 2);
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
});

test("cleanup, detached and replaced initial renders cannot retry after an insertion commit", async () => {
    for (const action of ["cleanup", "detach", "replace"]) {
        let requests = 0;
        const loaded = loadPlugin(english, async () => {
            requests++;
            return {code: -1};
        });
        const {mount, status, dispose} = renderMount(loaded);
        await settleContext();
        if (action === "cleanup") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        if (action === "cleanup") { // Cleanup cancels immediately, before any further event/deadline.
            assert.equal(loaded.plugin.eventBus.listeners.size, 0);
            assert.equal(loaded.deadlines.size, 0);
        }
        loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
        await settleContext();
        assert.equal(requests, 1);
        assert.equal(status.textContent, english.loadingChildren);
        assert.equal(loaded.plugin.eventBus.listeners.size, 0);
        assert.equal(loaded.deadlines.size, 0);
    }
});

test("cleanup during the post-commit metadata request prevents loading children", async () => {
    let second;
    let requests = 0;
    const loaded = loadPlugin(english, () => {
        requests++;
        return requests === 1 ? {code: -1} : new Promise(resolve => second = resolve);
    });
    const {status, dispose} = renderMount(loaded);
    await settleContext();
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
    await settleContext();
    dispose();
    second({code: 0, data: {rootID: ROOT_A}});
    await settleContext();
    assert.equal(requests, 2);
    assert.equal(status.textContent, english.loadingChildren);
});

test("initial commit watches remain isolated for two blocks/documents and duplicate editor copies", async () => {
    const committed = new Set();
    const opened = [];
    const metadataCalls = [];
    const loaded = loadPlugin(english, async (url, body) => {
        if (url.endsWith("getBlockInfo")) {
            metadataCalls.push(body.id);
            if (!committed.has(body.id)) return {code: -1};
        }
        return kernelResponse(url, body);
    }, {openTab: async options => opened.push(options.doc.id)});
    const instances = [renderMount(loaded, BLOCK_A), renderMount(loaded, BLOCK_B), renderMount(loaded, BLOCK_A)];
    await settleContext();
    committed.add(BLOCK_B);
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_B));
    await settleContext();
    assert.equal(cards(instances[0].mount).length, 0);
    assert.equal(cards(instances[1].mount)[0].textContent, "Other");
    assert.equal(cards(instances[2].mount).length, 0);
    instances[0].dispose();
    committed.add(BLOCK_A);
    loaded.plugin.eventBus.emit(insertionCommitted(BLOCK_A));
    await settleContext();
    assert.equal(instances[0].mount.children.length, 0);
    assert.equal(cards(instances[2].mount)[1].textContent, "First");
    cards(instances[1].mount)[0].click();
    cards(instances[2].mount)[1].click();
    await settleContext();
    assert.deepEqual(opened, [CHILD_B1, CHILD_A1]);
    assert.deepEqual(metadataCalls, [BLOCK_A, BLOCK_B, BLOCK_A, BLOCK_B, BLOCK_A]);
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
});

test("invalid or already stale block identities never start a commit watch or API request", async () => {
    const loaded = loadPlugin();
    for (const [id, current] of [["invalid", true], [BLOCK_A, false]]) {
        const context = loaded.context.startContainingDocumentResolution(id, loaded.plugin.eventBus, () => current);
        assert.equal(await context.result, null);
        context.cancel();
    }
    assert.equal(loaded.plugin.eventBus.listeners.size, 0);
    assert.equal(loaded.deadlines.size, 0);
});

// Trees model the current getBlockDOM/Lute content contract, not editor instances.
const textNode = textContent => ({nodeType: 3, textContent});
function previewNode(tag, attributes = {}, ...children) {
    const node = element(tag, {});
    node.attributes = attributes;
    node.append(...children.filter(child => child.nodeType === 1));
    Object.defineProperty(node, "childNodes", {value: children});
    return node;
}
const paragraph = (...content) =>
    previewNode(
        "div",
        {"data-type": "NodeParagraph"},
        previewNode("div", {contenteditable: "true"}, ...content),
        previewNode("div", {class: "protyle-attr"}, textNode("Technical attributes are not prose")),
    );
const contentImage = source =>
    previewNode(
        "span",
        {"data-type": "img"},
        previewNode("img", {src: source, "data-src": source, onerror: "untrustedHandler()"}),
        previewNode("span", {class: "protyle-action__title"}, textNode("Distinct caption must be skipped")),
    );
const previewFragment = (...children) => ({children});
const plainPreview = result => JSON.parse(JSON.stringify(result));
const mediaPart = card => card.children.find(child => child.className.split(" ").includes("child-gallery__media"));
const imagePart = card => mediaPart(card)?.children.find(child => child.className === "child-gallery__image");
const fallbackPart = card => {
    const media = mediaPart(card);
    return media?.getAttribute("data-media-state") === "fallback" ? media : undefined;
};
const descriptionPart = card => card.children.find(child => child.className === "child-gallery__description");
const titlePart = card => card.children.find(child => child.className === "child-gallery__title");
const previewResponse = (id, dom) => ({code: 0, data: {id, dom}});

for (
    const [name, hasImage, hasDescription] of [
        ["image and paragraph", true, true],
        ["image only", true, false],
        ["paragraph only", false, true],
        ["neither", false, false],
    ]
) {
    test(`preview extraction: ${name} has independent fields and excludes image captions`, () => {
        const {preview} = loadPlugin();
        const fragment = previewFragment(
            paragraph(...(hasImage ? [contentImage("assets/example-photo.png")] : [textNode("\u200b \n \t")])),
            paragraph(...(hasDescription ? [textNode("  First \n normal\t paragraph.  ")] : [])),
        );
        assert.deepEqual(plainPreview(preview.extractDocumentPreview(fragment, "http://siyuan.example.org/")), {
            ...(hasImage ? {image: "http://siyuan.example.org/assets/example-photo.png"} : {}),
            ...(hasDescription ? {description: "First normal paragraph."} : {}),
        });
    });
}

test("preview skips headings, lists, tables, code/math/custom/HTML/embed and distinctly marked structural paragraphs", () => {
    const {preview} = loadPlugin();
    const excluded = [
        "NodeHeading",
        "NodeList",
        "NodeListItem",
        "NodeTable",
        "NodeCodeBlock",
        "NodeMathBlock",
        "NodeBlockQueryEmbed",
        "NodeCustomBlock",
        "NodeHTMLBlock",
        "NodeAttributeView",
    ];
    const fragment = previewFragment(
        ...excluded.map(type => previewNode("div", {"data-type": type}, paragraph(textNode("Unsuitable description")))),
        previewNode(
            "div",
            {"data-type": "NodeParagraph", "tabs-title": "true"},
            previewNode("div", {contenteditable: "true"}, textNode("Tab title")),
        ),
        previewNode(
            "div",
            {"data-type": "NodeParagraph"},
            previewNode("div", {contenteditable: "true", class: "callout-title"}, textNode("Callout title")),
        ),
        paragraph(
            textNode("Real "),
            previewNode("span", {"data-type": "strong"}, textNode("bold prose")),
            previewNode("br"),
            textNode("continues."),
        ),
        paragraph(textNode("Later prose is not selected")),
    );
    assert.deepEqual(plainPreview(preview.extractDocumentPreview(fragment, "https://siyuan.example.org/")), {
        description: "Real bold prose continues.",
    });
});

test("preview selects first suitable content image, ignoring emojis/UI, bad sources, non-image links and technical blocks", () => {
    const {preview} = loadPlugin();
    const invalid = [
        "",
        "javascript:alert(1)",
        "file:///tmp/example-project/image.png",
        "blob:https://example.com/id",
        "data:text/html;base64,PHNjcmlwdD4=",
        "assets/../api/file/getFile",
        "assets/not-an-image.pdf",
        "/api/icon/getDynamicIcon?type=1",
        "https://example.com/avatars/person.png",
        "https://example.com/document.pdf",
    ];
    const fragment = previewFragment(
        previewNode("div", {"data-type": "NodeHTMLBlock"}, contentImage("https://example.com/not-content.png")),
        paragraph(
            previewNode("span", {"data-type": "emoji"}, previewNode("img", {src: "https://example.com/emoji.png"})),
            previewNode("img", {src: "https://example.com/ui.png"}),
            previewNode("span", {"data-type": "a", "data-href": "https://example.com/link.png"}, textNode("Link")),
        ),
        ...invalid.map(source => paragraph(contentImage(source))),
        paragraph(contentImage("/assets/first content.png")),
        paragraph(contentImage("https://example.com/later.png")),
    );
    assert.equal(
        preview.extractDocumentPreview(fragment, "https://siyuan.example.org/").image,
        "https://siyuan.example.org/assets/first%20content.png",
    );
    for (
        const source of ["https://example.com/image?id=1", "//cdn.example.com/photo.webp", "data:image/png;base64,AA=="]
    ) {
        assert.ok(
            preview.extractDocumentPreview(
                previewFragment(paragraph(contentImage(source))),
                "https://siyuan.example.org/",
            )
                .image,
        );
    }
});

test("preview retains full first paragraph without truncation and uses readable inline text", () => {
    const {preview} = loadPlugin();
    const full = "A long sentence with useful content. ".repeat(40).trim();
    const fragment = previewFragment(paragraph(textNode(full)), paragraph(textNode("Later paragraph")));
    assert.equal(preview.extractDocumentPreview(fragment, "https://siyuan.example.org/").description, full);
});

test("document preview uses one official content request for both fields and returns empty for failed/malformed responses", async () => {
    const fixture = previewFragment(paragraph(contentImage("assets/photo.png")), paragraph(textNode("Normal prose")));
    const requests = [];
    const loaded = loadPlugin(
        english,
        async (...args) => {
            requests.push(args);
            return previewResponse(CHILD_A1, "content fixture");
        },
        {},
        new Map([["content fixture", fixture]]),
    );
    assert.deepEqual(plainPreview(await loaded.preview.resolveDocumentPreview(CHILD_A1, loaded.document)), {
        image: "http://siyuan.example.org/assets/photo.png",
        description: "Normal prose",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0][0], "/api/block/getBlockDOM");
    assert.equal(JSON.stringify(requests[0][1]), JSON.stringify({id: CHILD_A1}));
    assert.equal(requests[0][2], undefined);
    assert.equal(requests[0][3], false);
    assert.deepEqual(plainPreview(await loaded.preview.resolveDocumentPreview("invalid", loaded.document)), {});
    assert.equal(requests.length, 1);
    for (
        const response of [
            null,
            [],
            {},
            {code: -1},
            {code: "0", data: {}},
            {code: 0, data: null},
            {code: 0, data: []},
            previewResponse(CHILD_A2, "content fixture"),
            previewResponse(CHILD_A1, 5),
            previewResponse(CHILD_A1, ""),
            previewResponse(CHILD_A1, "unstructured/malformed content"),
        ]
    ) {
        const failed = loadPlugin(english, async () => response);
        assert.deepEqual(plainPreview(await failed.preview.resolveDocumentPreview(CHILD_A1, failed.document)), {});
    }
    for (
        const request of [() => {
            throw Error("request failure");
        }, async () => {
            throw Error("network failure");
        }]
    ) {
        const failed = loadPlugin(english, request);
        assert.deepEqual(plainPreview(await failed.preview.resolveDocumentPreview(CHILD_A1, failed.document)), {});
    }
});

for (
    const [name, hasImage, hasDescription] of [["both", true, true], ["image only", true, false], [
        "description only",
        false,
        true,
    ], ["title only", false, false]]
) {
    test(`preview card rendering: ${name}, same exact-ID navigation and independent regions`, async () => {
        const opened = [];
        const requests = [];
        const fragment = previewFragment(
            paragraph(...(hasImage ? [contentImage("assets/photo.png")] : [])),
            paragraph(...(hasDescription ? [textNode("Full normal prose")] : [])),
        );
        const loaded = loadPlugin(
            english,
            async (url, body) => {
                requests.push({url, body});
                if (url.endsWith("getBlockDOM")) return previewResponse(body.id, "fixture");
                if (url.endsWith("listDocsByPath")) return listing(ROOT_A, [file(ROOT_A, CHILD_A1, "Primary title")]);
                return kernelResponse(url, body);
            },
            {openTab: async options => opened.push(options.doc.id)},
            new Map([["fixture", fragment]]),
        );
        const {mount} = renderMount(loaded);
        await settleContext();
        const card = cards(mount)[0];
        assert.equal(card.tag, "button");
        assert.equal(card.type, "button");
        assert.equal(titlePart(card).textContent, "Primary title");
        assert.equal(Boolean(imagePart(card)), hasImage);
        assert.equal(Boolean(fallbackPart(card)), !hasImage);
        assert.equal(Boolean(descriptionPart(card)), hasDescription);
        if (hasImage) {
            assert.equal(imagePart(card).src, "http://siyuan.example.org/assets/photo.png");
            assert.equal(imagePart(card).alt, "");
            assert.equal(imagePart(card).tag, "img");
            assert.equal(imagePart(card).parentElement, mediaPart(card));
            assert.equal(mediaPart(card).parentElement, card);
            assert.equal(mediaPart(card).getAttribute("data-media-state"), "loading");
        }
        if (hasDescription) assert.equal(descriptionPart(card).textContent, "Full normal prose");
        assert.equal(requests.filter(request => request.url.endsWith("getBlockDOM")).length, 1);
        card.click();
        await settleContext();
        assert.deepEqual(opened, [CHILD_A1]);
    });
}

test("cover parameters are stable across instances with supported palettes and variation within each palette", () => {
    const first = loadPlugin().fallback;
    const second = loadPlugin().fallback;
    assert.ok(first.FALLBACK_PALETTE_COUNT >= 12 && first.FALLBACK_PALETTE_COUNT <= 16);
    const palettes = new Map();
    for (let index = 0; index < 512; index++) {
        const id = `20000101000004-${index.toString(36).padStart(7, "0")}`;
        const appearance = plainPreview(first.fallbackCoverAppearance(id));
        assert.deepEqual(appearance, plainPreview(second.fallbackCoverAppearance(id)));
        const {palette, angle, stop} = appearance;
        assert.ok(Number.isInteger(palette) && palette >= 1 && palette <= first.FALLBACK_PALETTE_COUNT);
        assert.ok(Number.isInteger(angle) && angle >= 0 && angle < 360);
        assert.ok(Number.isInteger(stop) && stop >= 35 && stop <= 65);
        if (!palettes.has(palette)) palettes.set(palette, {angles: new Set(), stops: new Set()});
        palettes.get(palette).angles.add(angle);
        palettes.get(palette).stops.add(stop);
    }
    assert.equal(palettes.size, first.FALLBACK_PALETTE_COUNT);
    for (const {angles, stops} of palettes.values()) {
        assert.ok(angles.size > 1 && stops.size > 1);
    }
    const helper = readFileSync(new URL("../src/fallback.ts", import.meta.url), "utf8");
    assert.ok(!/Math\.random|localStorage|sessionStorage|fetch|setItem/.test(helper));
});

const coverAppearance = cover => ({
    palette: Number(cover.getAttribute("data-cover-palette")),
    angle: Number.parseInt(cover.style.getPropertyValue("--child-gallery-cover-angle"), 10),
    stop: Number.parseInt(cover.style.getPropertyValue("--child-gallery-cover-stop"), 10),
});

test("no-image covers stay decorative and depend on ID rather than title or gallery instance", async () => {
    const appearances = [];
    for (const title of ["Original title", "Renamed <document>"]) {
        const loaded = loadPlugin(english, (url, body) => {
            if (url.endsWith("listDocsByPath")) return listing(ROOT_A, [file(ROOT_A, CHILD_A1, title)]);
            return kernelResponse(url, body);
        });
        const {mount} = renderMount(loaded);
        await settleContext();
        const card = cards(mount)[0];
        const cover = fallbackPart(card);
        assert.equal(imagePart(card), undefined);
        assert.equal(cover.tag, "span");
        assert.equal(cover.getAttribute("aria-hidden"), "true");
        assert.equal(cover.getAttribute("tabindex"), null);
        assert.equal(cover.getAttribute("role"), null);
        assert.equal(cover.textContent, "");
        assert.equal(cover.src, undefined);
        assert.deepEqual(Object.keys(cover.listeners), []);
        assert.ok(cover.className.includes("child-gallery__media"));
        assert.equal(titlePart(card).textContent, title);
        appearances.push(coverAppearance(cover));
        assert.deepEqual(appearances.at(-1), plainPreview(loaded.fallback.fallbackCoverAppearance(CHILD_A1)));
        assert.equal(cover.getAttribute("data-cover-variant"), null);
    }
    assert.deepEqual(appearances[0], appearances[1]);
});

test("failed, malformed and empty previews produce covers only with image display enabled", async () => {
    for (const outcome of ["failed", "malformed", "empty", "throw"]) {
        for (const showImage of [true, false]) {
            const loaded = loadPlugin(english, (url, body) => {
                if (!url.endsWith("getBlockDOM")) return kernelResponse(url, body);
                if (outcome === "throw") throw Error("Preview unavailable");
                if (outcome === "failed") return {code: -1};
                if (outcome === "malformed") return {code: 0, data: {id: body.id, dom: []}};
                return previewResponse(body.id, "");
            });
            const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, showImage});
            await settleContext();
            for (const card of cards(mount)) {
                assert.equal(imagePart(card), undefined);
                assert.equal(Boolean(fallbackPart(card)), showImage);
                assert.equal(descriptionPart(card), undefined);
                assert.ok(titlePart(card).textContent);
            }
        }
    }
});

test("media geometry is shared by images/covers across stacked, horizontal and nested cards", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    assert.match(css, /&__media\s*\{[^}]*width:\s*100%;[^}]*height:\s*8rem/s);
    assert.match(css, /\.child-gallery__media\s*\{[^}]*width:\s*min\(8rem, 32cqw\);[^}]*min-height:\s*8rem/s);
    assert.match(css, /\.child-gallery__media ~ \.child-gallery__title/);
    assert.match(css, /\.child-gallery__media ~ \.child-gallery__description/);
    assert.match(css, /\.child-gallery__nested\s*\{[^]*?\.child-gallery__media\s*\{\s*height:\s*6rem/s);
    assert.match(css, /\.child-gallery__nested \.child-gallery__media\s*\{[^}]*min-height:\s*6rem/s);
    const paletteCount = loadPlugin().fallback.FALLBACK_PALETTE_COUNT;
    const paletteBlock = css.slice(css.indexOf("$palettes:"), css.indexOf("@for $palette"));
    assert.equal([...paletteBlock.matchAll(/\(#[a-f0-9]{6}, #[a-f0-9]{6}, #[a-f0-9]{6}\)/g)].length, paletteCount);
    assert.match(css, /data-cover-palette/);
    assert.match(css, /var\(--child-gallery-cover-angle\)/);
    assert.match(css, /var\(--child-gallery-cover-stop\)/);
    assert.match(css, /var\(--b3-theme-surface\)/);
    assert.ok(!/data-cover-variant|radial-gradient|repeating-linear-gradient|circle|ellipse/.test(css));
    assert.ok(!css.includes("url(") && !css.includes("animation:"));
});

test("horizontal shared media stays top-aligned at 8rem/6rem when card text grows", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const regular = css.match(
        /@container \(min-width: 18rem\)\s*\{\s*\.child-gallery\[data-orientation="horizontal"\] \.child-gallery__media\s*\{([^}]+)\}/,
    )[1];
    const nested = css.match(
        /\.child-gallery\[data-orientation="horizontal"\] \.child-gallery__nested \.child-gallery__media\s*\{([^}]+)\}/,
    )[1];
    assert.match(regular, /grid-column:\s*1;/);
    assert.match(regular, /grid-row:\s*1 \/ span 2;/);
    assert.match(regular, /width:\s*min\(8rem, 32cqw\);/);
    assert.match(regular, /height:\s*8rem;/);
    assert.match(regular, /align-self:\s*start;/);
    assert.match(nested, /width:\s*min\(6rem, 32cqw\);/);
    assert.match(nested, /height:\s*6rem;/);
    assert.ok(!/height:\s*(100%|auto)|align-self:\s*stretch/.test(regular + nested));
    assert.match(css, /&__media\s*\{[^}]*height:\s*8rem;/);
    assert.match(css, /\.child-gallery__nested\s*\{[^]*?\.child-gallery__media\s*\{\s*height:\s*6rem;/);
    assert.match(css, /&__image\s*\{[^}]*object-fit:\s*cover;/);
    assert.match(css, /\.child-gallery__media ~ \.child-gallery__title\s*\{\s*grid-column:\s*2;\s*grid-row:\s*1;/);
    assert.match(
        css,
        /\.child-gallery__media ~ \.child-gallery__description\s*\{\s*grid-column:\s*2;\s*grid-row:\s*2;/,
    );
});

test("preview descriptions use CSS three-line clamping and image region uses cover, without string truncation", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    assert.match(css, /&__description\s*\{[^}]*-webkit-line-clamp:\s*3/s);
    assert.match(css, /&__image\s*\{[^}]*object-fit:\s*cover/s);
});

test("progressive previews preserve native child order, publish to exact cards and isolate one failed child", async () => {
    const pending = new Map();
    const fragments = new Map([["first", previewFragment(paragraph(textNode("First preview")))], [
        "second",
        previewFragment(paragraph(textNode("Second preview"))),
    ]]);
    const loaded = loadPlugin(
        english,
        (url, body) =>
            url.endsWith("getBlockDOM") ?
                new Promise(resolve => pending.set(body.id, resolve)) :
                kernelResponse(url, body),
        {},
        fragments,
    );
    const {mount, status} = renderMount(loaded);
    await settleContext();
    const original = [...cards(mount)];
    assert.deepEqual(original.map(card => titlePart(card).textContent), ["Second & <title>.sy", "First"]);
    assert.equal(status.textContent, ""); // Title/navigation publication doesn't wait for previews.
    assert.ok(original.every(card => !imagePart(card) && !fallbackPart(card)));
    pending.get(CHILD_A1)(previewResponse(CHILD_A1, "first"));
    await settleContext();
    assert.equal(descriptionPart(original[1]).textContent, "First preview");
    assert.equal(descriptionPart(original[0]), undefined);
    assert.ok(!fallbackPart(original[0]));
    assert.ok(fallbackPart(original[1]));
    pending.get(CHILD_A2)({code: -1});
    await settleContext();
    assert.deepEqual(cards(mount), original);
    assert.equal(titlePart(original[0]).textContent, "Second & <title>.sy");
    assert.equal(descriptionPart(original[0]), undefined);
    assert.ok(fallbackPart(original[0]));
    assert.equal(status.textContent, "");
});

test("untrusted preview text stays literal and only validated image sources reach new elements", async () => {
    const dangerous = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const fragment = previewFragment(
        paragraph(contentImage("javascript:alert(1)")),
        paragraph(textNode(dangerous), previewNode("script", {}, textNode("Must not be extracted"))),
    );
    const loaded = loadPlugin(
        english,
        async (url, body) => {
            if (url.endsWith("getBlockDOM")) return previewResponse(body.id, "fixture");
            if (url.endsWith("listDocsByPath")) return listing(ROOT_A, [file(ROOT_A, CHILD_A1, dangerous)]);
            return kernelResponse(url, body);
        },
        {},
        new Map([["fixture", fragment]]),
    );
    const {mount} = renderMount(loaded);
    await settleContext();
    const card = cards(mount)[0];
    assert.equal(titlePart(card).textContent, dangerous);
    assert.equal(descriptionPart(card).textContent, dangerous);
    assert.equal(imagePart(card), undefined);
    assert.deepEqual(card.children.map(child => child.tag), ["span", "span", "span"]);
    assert.equal(fallbackPart(card).textContent, "");
});

test("failed browser image load replaces its image with the same deterministic cover and keeps content/navigation", async () => {
    const opened = [];
    const fragment = previewFragment(paragraph(contentImage("assets/photo.png")), paragraph(textNode("Prose remains")));
    const loaded = loadPlugin(
        english,
        (url, body) => url.endsWith("getBlockDOM") ? previewResponse(body.id, "fixture") : kernelResponse(url, body),
        {openTab: async options => opened.push(options.doc.id)},
        new Map([["fixture", fragment]]),
    );
    const {mount} = renderMount(loaded);
    await settleContext();
    const card = cards(mount)[0];
    const image = imagePart(card);
    assert.equal(image.getAttribute("onerror"), null);
    assert.equal(fallbackPart(card), undefined);
    image.listeners.error();
    assert.equal(imagePart(card), undefined);
    assert.deepEqual(
        coverAppearance(fallbackPart(card)),
        plainPreview(loaded.fallback.fallbackCoverAppearance(CHILD_A2)),
    );
    image.listeners.error(); // A repeated event on the removed image must not add another cover.
    assert.equal(card.children.filter(child => child === fallbackPart(card)).length, 1);
    assert.equal(card.children.length, 3);
    assert.equal(descriptionPart(card).textContent, "Prose remains");
    card.click();
    await settleContext();
    assert.deepEqual(opened, [CHILD_A2]);
});

test("preview flags control independent fields and skip content requests when both are disabled", async () => {
    for (const [showImage, showDescription] of [[true, false], [false, true], [false, false]]) {
        let calls = 0;
        const fragment = previewFragment(paragraph(contentImage("assets/photo.png")), paragraph(textNode("Prose")));
        const loaded = loadPlugin(
            english,
            (url, body) => {
                if (url.endsWith("getBlockDOM")) {
                    calls++;
                    return previewResponse(body.id, "fixture");
                }
                return kernelResponse(url, body);
            },
            {},
            new Map([["fixture", fragment]]),
        );
        const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, showImage, showDescription});
        await settleContext();
        assert.equal(Boolean(imagePart(cards(mount)[0])), showImage);
        assert.equal(fallbackPart(cards(mount)[0]), undefined);
        assert.equal(Boolean(descriptionPart(cards(mount)[0])), showDescription);
        assert.equal(calls, showImage || showDescription ? 2 : 0);
    }
});

test("late image errors cannot publish covers to disposed, detached, replaced or reparented cards", async () => {
    for (const action of ["dispose", "detach", "replace", "reparent", "depth"]) {
        const fragment = previewFragment(paragraph(contentImage("assets/photo.png")));
        const loaded = loadPlugin(
            english,
            (url, body) =>
                url.endsWith("getBlockDOM") ? previewResponse(body.id, "fixture") : kernelResponse(url, body),
            {},
            new Map([["fixture", fragment]]),
        );
        const {mount, dispose} = renderMount(loaded, BLOCK_A, loaded.config.DEFAULT_CONFIG, () => true);
        await settleContext();
        const card = cards(mount)[0];
        const image = imagePart(card);
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(element("successor", loaded.document));
        if (action === "reparent") mount.children[0].append(card);
        if (action === "depth") openSettings(loaded, mount).items[2].submenu[1].click();
        image.listeners.error();
        assert.equal(fallbackPart(card), undefined);
        assert.equal(imagePart(card), image);
        dispose();
    }
});

test("stale preview results cannot enrich disposed, detached, replaced or successor renders", async () => {
    for (const action of ["dispose", "detach", "replace", "rerender"]) {
        const pending = [];
        const fragment = previewFragment(paragraph(textNode("Old preview")));
        const loaded = loadPlugin(
            english,
            (url, body) =>
                url.endsWith("getBlockDOM") ?
                    new Promise(resolve => pending.push({id: body.id, resolve})) :
                    kernelResponse(url, body),
            {},
            new Map([["fixture", fragment]]),
        );
        const {mount, dispose} = renderMount(loaded);
        await settleContext();
        const old = [...cards(mount)];
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        if (action === "rerender") {
            loaded.plugin.customBlockRenders["child-gallery"].render({
                element: mount,
                content: JSON.stringify(loaded.config.DEFAULT_CONFIG),
            });
        }
        for (const request of pending.slice(0, 2)) request.resolve(previewResponse(request.id, "fixture"));
        await settleContext();
        assert.ok(old.every(card => !descriptionPart(card)));
        if (action === "rerender") assert.ok(cards(mount).every(card => !descriptionPart(card)));
        dispose();
    }
});

test("preview results remain local to simultaneous galleries, editor copies and child identities", async () => {
    const pending = [];
    const fragment = description => previewFragment(paragraph(textNode(description)));
    const loaded = loadPlugin(
        english,
        (url, body) =>
            url.endsWith("getBlockDOM") ?
                new Promise(resolve => pending.push({id: body.id, resolve})) :
                kernelResponse(url, body),
        {},
        new Map([["A", fragment("A prose")], ["B", fragment("B prose")]]),
    );
    const instances = [renderMount(loaded, BLOCK_A), renderMount(loaded, BLOCK_B), renderMount(loaded, BLOCK_A)];
    await settleContext();
    for (const request of pending.filter(request => request.id === CHILD_B1)) {
        request.resolve(previewResponse(request.id, "B"));
    }
    await settleContext();
    assert.equal(descriptionPart(cards(instances[1].mount)[0]).textContent, "B prose");
    assert.ok(cards(instances[0].mount).every(card => !descriptionPart(card)));
    for (const request of pending.filter(request => request.id !== CHILD_B1)) {
        request.resolve(previewResponse(request.id, "A"));
    }
    await settleContext();
    for (const index of [0, 2]) {
        assert.ok(cards(instances[index].mount).every(card => descriptionPart(card).textContent === "A prose"));
    }
    assert.equal(descriptionPart(cards(instances[1].mount)[0]).textContent, "B prose");
});

const settingsButton = mount => mount.children[0].children[0].children.find(child => child.tag === "button");
function openSettings(loaded, mount) {
    settingsButton(mount).click();
    return loaded.menus.at(-1);
}

test("layout defaults, optional version-1 fields and invalid layout values render safely without migration", () => {
    const {config} = loadPlugin();
    for (
        const input of [
            {version: 1, source: "children"},
            {...config.DEFAULT_CONFIG, orientation: "diagonal", columns: 17},
            {...config.DEFAULT_CONFIG, orientation: null, columns: "2"},
        ]
    ) {
        const parsed = config.parseConfig(JSON.stringify(input));
        assert.equal(parsed.orientation, "vertical");
        assert.equal(parsed.columns, "auto");
        assert.equal(parsed.depth, 1);
        assert.equal(parsed.showImage, true);
        assert.equal(parsed.showDescription, true);
    }
    assert.equal(config.updateLayoutConfig('{"version":2,"source":"children"}', {columns: 2}), undefined);
    assert.equal(config.updateLayoutConfig(JSON.stringify(config.DEFAULT_CONFIG), {columns: 9}), undefined);
    assert.equal(config.updateLayoutConfig(JSON.stringify(config.DEFAULT_CONFIG), {depth: 2}), undefined);
    assert.equal(config.updateLayoutConfig(JSON.stringify(config.DEFAULT_CONFIG), {columns: undefined}), undefined);
    assert.equal(
        config.updateLayoutConfig(JSON.stringify(config.DEFAULT_CONFIG), {orientation: "diagonal"}),
        undefined,
    );
});

for (const orientation of ["vertical", "horizontal"]) {
    for (const columns of ["auto", 1, 2, 3, 4]) {
        test(`persisted ${orientation}/${columns} applies to its own gallery layout state`, async () => {
            const loaded = loadPlugin(english, kernelResponse);
            const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, orientation, columns});
            await settleContext();
            assert.equal(mount.children[0].getAttribute("data-orientation"), orientation);
            assert.equal(mount.children[0].getAttribute("data-columns"), String(columns));
            assert.equal(cards(mount).length, 2);
        });
    }
}

test("native settings menu is localized, keyboard reachable, anchored and offers validated depths 1–3", async () => {
    for (const messages of [english, german]) {
        const saved = [];
        const loaded = loadPlugin(messages, kernelResponse);
        const {mount} = renderMount(loaded, BLOCK_A, loaded.config.DEFAULT_CONFIG, content => {
            saved.push(content);
            return true;
        });
        await settleContext();
        const button = settingsButton(mount);
        assert.equal(button.tag, "button");
        assert.equal(button.type, "button");
        assert.equal(button.getAttribute("aria-label"), messages.gallerySettings);
        assert.equal(button.title, messages.gallerySettings);
        assert.equal(button.getAttribute("aria-haspopup"), "menu");
        assert.ok(button.fixedHTML.includes("#iconSettings"));
        const menu = openSettings(loaded, mount);
        assert.deepEqual(plainPreview(menu.position), {x: 700, y: 150, isLeft: true});
        assert.equal(button.getAttribute("aria-expanded"), "true");
        assert.deepEqual(menu.items.map(item => item.label), [
            messages.cardLayout,
            messages.columns,
            messages.depth,
            messages.showPreviews,
        ]);
        assert.equal(menu.items[0].submenu[0].checked, true);
        assert.equal(menu.items[1].submenu[0].checked, true);
        assert.equal(menu.items[3].checked, true);
        assert.equal(menu.items[3].label, messages === english ? "Show previews" : "Vorschauen anzeigen");
        const depths = menu.items[2].submenu;
        assert.equal(depths[0].checked, true);
        assert.equal(depths[0].disabled, undefined);
        assert.ok(depths.every(option => option.disabled === undefined && typeof option.click === "function"));
        assert.deepEqual(saved, []);
        menu.close();
        assert.equal(button.getAttribute("aria-expanded"), "false");
    }
});

test("localized preview toggle reads true/false/default and persists only showImage through the owning callback", async () => {
    for (const messages of [english, german]) {
        for (const initial of [undefined, true, false]) {
            const saved = [];
            const loaded = loadPlugin(messages, kernelResponse);
            const original = {
                version: 1,
                source: "children",
                orientation: "horizontal",
                columns: 2,
                depth: 1,
                showDescription: false,
                extra: {literal: "<preserve>"},
                ...(initial === undefined ? {} : {showImage: initial}),
            };
            const current = initial ?? true;
            const {mount} = renderMount(loaded, BLOCK_A, original, content => {
                saved.push(JSON.parse(content));
                return true;
            });
            const other = renderMount(loaded, BLOCK_B, loaded.config.DEFAULT_CONFIG, () => {
                assert.fail("Must not write another gallery");
            });
            await settleContext();
            let menu = openSettings(loaded, mount);
            assert.equal(menu.items[3].label, messages.showPreviews);
            assert.equal(menu.items[3].checked, current);
            assert.deepEqual(saved, []); // Merely opening never writes optional defaults.
            menu.items[3].click();
            assert.deepEqual(saved[0], {...original, showImage: !current});
            menu.close();
            menu = openSettings(loaded, mount);
            assert.equal(menu.items[3].checked, !current);
            assert.equal(menu.items[0].submenu[1].checked, true);
            assert.equal(menu.items[1].submenu[2].checked, true);
            assert.equal(menu.items[2].submenu[0].checked, true);
            menu.items[3].click();
            assert.deepEqual(saved[1], {...original, showImage: current});
            menu.close();
            assert.equal(openSettings(loaded, other.mount).items[3].checked, true);
            // Model the host's normal rerender from persisted content; no separate refresh path.
            for (const configuration of saved) {
                const reopened = renderMount(loaded, BLOCK_A, configuration);
                await settleContext();
                assert.ok(
                    cards(reopened.mount).every(card =>
                        !imagePart(card) && Boolean(fallbackPart(card)) === configuration.showImage &&
                        !descriptionPart(card)
                    ),
                );
                reopened.dispose();
            }
            assert.equal(loaded.config.parseConfig(JSON.stringify(original)).showImage, current);
        }
    }
});

test("showImage serialization accepts only one boolean edit and retains the version-1 schema/default", () => {
    const {config} = loadPlugin();
    const original = {...config.DEFAULT_CONFIG, depth: 3, extra: {literal: "keep"}};
    for (const showImage of [true, false]) {
        const next = JSON.parse(config.updateGalleryConfig(JSON.stringify(original), {showImage}));
        assert.deepEqual(next, {...original, showImage});
        assert.equal(config.parseConfig(JSON.stringify(next)).showImage, showImage);
    }
    for (
        const patch of [{showImage: undefined}, {showImage: null}, {showImage: "false"}, {showImage: 0}, {
            showImage: false,
            depth: 2,
        }]
    ) {
        assert.equal(config.updateGalleryConfig(JSON.stringify(original), patch), undefined);
    }
    assert.equal(config.updateGalleryConfig(JSON.stringify({...original, version: 2}), {showImage: false}), undefined);
    assert.equal(config.updateLayoutConfig(JSON.stringify(original), {showImage: false}), undefined);
    assert.equal(config.DEFAULT_CONFIG.showImage, true);
    assert.equal(config.parseConfig('{"version":1,"source":"children"}').showImage, true);
});

test("preview toggle retains existing refused-write and stale-menu guards", async () => {
    for (const action of ["dispose", "detach", "replace", "supersede", "refuse", "throw"]) {
        let writes = 0;
        const loaded = loadPlugin(english, kernelResponse);
        const {mount, dispose, status} = renderMount(loaded, BLOCK_A, loaded.config.DEFAULT_CONFIG, () => {
            writes++;
            if (action === "throw") throw Error("Read-only");
            return false;
        });
        await settleContext();
        const menu = openSettings(loaded, mount);
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        if (action === "supersede") {
            const other = renderMount(loaded, BLOCK_B, loaded.config.DEFAULT_CONFIG, () => true);
            openSettings(loaded, other.mount);
        }
        menu.items[3].click();
        assert.equal(writes, ["refuse", "throw"].includes(action) ? 1 : 0);
        if (writes) {
            assert.equal(status.textContent, english.settingsUnavailable);
            menu.close();
            assert.equal(openSettings(loaded, mount).items[3].checked, true);
        }
        dispose();
    }
});

test("layout edits persist only the selected field and retain unknown configuration plus preview flags", async () => {
    const saved = [];
    const loaded = loadPlugin(english, kernelResponse);
    const original = {...loaded.config.DEFAULT_CONFIG, showImage: false, futureOption: {literal: "<keep>"}};
    const {mount} = renderMount(loaded, BLOCK_A, original, content => {
        saved.push(JSON.parse(content));
        return true;
    });
    await settleContext();
    const originalCards = [...cards(mount)];
    let menu = openSettings(loaded, mount);
    menu.items[0].submenu[1].click();
    assert.deepEqual(saved[0], {...original, orientation: "horizontal"});
    assert.equal(mount.children[0].getAttribute("data-orientation"), "horizontal");
    assert.deepEqual(cards(mount), originalCards);
    menu.close();
    menu = openSettings(loaded, mount);
    menu.items[1].submenu[3].click();
    assert.deepEqual(saved[1], {...original, orientation: "horizontal", columns: 3});
    assert.equal(mount.children[0].getAttribute("data-columns"), "3");
    assert.ok(!("childIds" in saved[1]) && !("preview" in saved[1]) && !("rootID" in saved[1]));
    assert.equal(
        loaded.config.updateLayoutConfig('{"version":1,"source":"children","extra":7}', {columns: 2}),
        '{\n  "version": 1,\n  "source": "children",\n  "extra": 7,\n  "columns": 2\n}',
    );
});

test("settings isolate galleries/editor copies and stale cleanup cannot close another gallery's shared menu", async () => {
    const loaded = loadPlugin(english, kernelResponse);
    const saved = [[], [], []];
    const instances = [BLOCK_A, BLOCK_B, BLOCK_A].map((id, i) =>
        renderMount(loaded, id, loaded.config.DEFAULT_CONFIG, content => {
            saved[i].push(JSON.parse(content));
            return true;
        })
    );
    await settleContext();
    const menuA = openSettings(loaded, instances[0].mount);
    menuA.items[0].submenu[1].click();
    assert.equal(saved[0][0].orientation, "horizontal");
    assert.deepEqual(saved.slice(1), [[], []]);
    assert.equal(instances[1].mount.children[0].getAttribute("data-orientation"), "vertical");
    assert.equal(instances[2].mount.children[0].getAttribute("data-orientation"), "vertical");
    const menuB = openSettings(loaded, instances[1].mount);
    assert.equal(menuA.closed, true);
    instances[0].dispose();
    assert.equal(menuB.closed, undefined);
    menuA.items[1].submenu[4].click();
    assert.equal(saved[0].length, 1);
    menuB.items[1].submenu[2].click();
    assert.equal(saved[1][0].columns, 2);
    assert.deepEqual(saved[2], []);
    instances[1].dispose();
    assert.equal(menuB.closed, true);
});

test("stale, detached, replaced, refused or throwing configuration writes remain safe", async () => {
    for (const action of ["dispose", "detach", "replace", "refuse", "throw"]) {
        let writes = 0;
        const loaded = loadPlugin(english, kernelResponse);
        const {mount, dispose, status} = renderMount(loaded, BLOCK_A, loaded.config.DEFAULT_CONFIG, () => {
            writes++;
            if (action === "throw") throw Error("read-only");
            return false;
        });
        await settleContext();
        const gallery = mount.children[0];
        const menu = openSettings(loaded, mount);
        if (action === "dispose") dispose();
        if (action === "detach") mount.parent.connected = false;
        if (action === "replace") mount.replaceChildren(loaded.document.createElement("div"));
        menu.items[0].submenu[1].click();
        assert.equal(writes, ["refuse", "throw"].includes(action) ? 1 : 0);
        assert.equal(gallery.getAttribute("data-orientation"), "vertical");
        if (writes) assert.equal(status.textContent, english.settingsUnavailable);
        dispose();
    }
});

test("horizontal four-way preview cards preserve title/navigation and fill missing images only", async () => {
    for (const [hasImage, hasDescription] of [[true, true], [false, true], [true, false], [false, false]]) {
        const opened = [];
        const fragment = previewFragment(
            paragraph(...(hasImage ? [contentImage("assets/photo.png")] : [])),
            paragraph(...(hasDescription ? [textNode("Normal prose")] : [])),
        );
        const loaded = loadPlugin(
            english,
            (url, body) =>
                url.endsWith("getBlockDOM") ? previewResponse(body.id, "fixture") : kernelResponse(url, body),
            {openTab: async options => opened.push(options.doc.id)},
            new Map([["fixture", fragment]]),
        );
        const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, orientation: "horizontal"});
        await settleContext();
        const card = cards(mount)[0];
        assert.equal(Boolean(imagePart(card)), hasImage);
        assert.equal(Boolean(fallbackPart(card)), !hasImage);
        assert.equal(Boolean(descriptionPart(card)), hasDescription);
        assert.equal(card.tag, "button");
        assert.ok(titlePart(card).textContent);
        card.click();
        await settleContext();
        assert.deepEqual(opened, [CHILD_A2]);
    }
});

test("CSS handles row stretch, bounded horizontal images and responsive preferences without resize listeners", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    assert.match(css, /align-items:\s*stretch/);
    assert.match(css, /@for \$columns from 1 through 4/);
    assert.match(css, /repeat\(auto-fill, minmax\(min\(100%, max\(12rem/);
    assert.match(css, /@container \(min-width: 18rem\)/);
    assert.match(css, /width:\s*min\(8rem, 32cqw\)/);
});

test("localized menu labels are escaped rather than interpreted as HTML", async () => {
    const loaded = loadPlugin({...english, cardLayout: '<img src=x onerror="bad()">'}, kernelResponse);
    const {mount} = renderMount(loaded);
    await settleContext();
    const menu = openSettings(loaded, mount);
    assert.ok(menu.items[0].label.startsWith("&lt;img"));
    assert.ok(!menu.items[0].label.includes("<img"));
});

test("legacy optional fields render with defaults and never write without a settings action", async () => {
    const loaded = loadPlugin(english, kernelResponse);
    const {mount} = renderMount(loaded, BLOCK_A, {version: 1, source: "children"});
    await settleContext();
    assert.equal(cards(mount).length, 2);
    assert.equal(mount.children[0].getAttribute("data-orientation"), "vertical");
    assert.equal(mount.children[0].getAttribute("data-columns"), "auto");
    assert.equal(openSettings(loaded, mount).items[2].submenu[0].checked, true);
});

test("mobile settings use the public native fullscreen menu instead of desktop positioning", async () => {
    const loaded = loadPlugin(english, kernelResponse, {getFrontend: () => "browser-mobile"});
    const {mount} = renderMount(loaded);
    await settleContext();
    const menu = openSettings(loaded, mount);
    assert.equal(menu.fullscreenCalled, true);
    assert.equal(menu.position, undefined);
});

// Small canonical hierarchy fixture: deliberately non-alphabetic native sibling order and a fourth level.
const hierarchyId = index => `20000101000005-${index.toString(36).padStart(7, "0")}`;
function hierarchyFixture() {
    const paths = new Map([[ROOT_A, pathFor(ROOT_A)], [ROOT_B, pathFor(ROOT_B)]]);
    const branches = new Map([
        [ROOT_A, [[1, "A"], [2, "B"], [3, "C"]]],
        [hierarchyId(1), [[4, "A2"], [5, "A1"]]],
        [hierarchyId(5), [[6, "A1b"], [7, "A1a"]]],
        [hierarchyId(2), [[8, "B1"]]],
        [hierarchyId(7), [[9, "Beyond depth 3"]]],
        [ROOT_B, [[10, "Other"]]],
    ]);
    for (const [parent, children] of branches) {
        for (const [index] of children) {
            paths.set(hierarchyId(index), `${paths.get(parent).slice(0, -3)}/${hierarchyId(index)}.sy`);
        }
    }
    const requests = [];
    function answer(url, body) {
        if (url.endsWith("getBlockInfo")) return {code: 0, data: {rootID: body.id === BLOCK_B ? ROOT_B : ROOT_A}};
        if (url.endsWith("getPathByID")) return {code: 0, data: {notebook: NOTEBOOK, path: paths.get(body.id)}};
        if (url.endsWith("getBlockDOM")) return previewResponse(body.id, body.id);
        const parent = [...paths].find(([, path]) => path === body.path)?.[0];
        assert.ok(parent, "Only validated known child paths may be followed");
        return {
            code: 0,
            data: {
                box: NOTEBOOK,
                path: body.path,
                files: (branches.get(parent) ?? []).map(([index, name]) => ({
                    id: hierarchyId(index),
                    name,
                    path: paths.get(hierarchyId(index)),
                })),
            },
        };
    }
    const fetch = (url, body, ...options) => {
        requests.push([url, body, ...options]);
        return answer(url, body);
    };
    return {paths, branches, requests, answer, fetch};
}
function descendantCards(mount) {
    const found = [];
    function visit(node) {
        if (node.className === "child-gallery__card") found.push(node);
        node.children?.forEach(visit);
    }
    visit(mount);
    return found;
}
const hierarchyTitles = mount => descendantCards(mount).map(card => titlePart(card).textContent);
const expectedHierarchy = [
    ["A", "B", "C"],
    ["A", "A2", "A1", "B", "B1", "C"],
    ["A", "A2", "A1", "A1b", "A1a", "B", "B1", "C"],
];
for (const depth of [1, 2, 3]) {
    test(`hierarchy depth ${depth} stops exactly at the boundary, retains order and resolves location only once`, async () => {
        const fixture = hierarchyFixture();
        const loaded = loadPlugin(english, fixture.fetch);
        const nodes = await loaded.children.resolveHierarchy(ROOT_A, depth);
        const flatten = nodes => nodes.flatMap(node => [node.title, ...flatten(node.children)]);
        assert.deepEqual([...flatten(nodes)], expectedHierarchy[depth - 1]);
        assert.equal(fixture.requests.filter(([url]) => url.endsWith("getPathByID")).length, 1);
        const lists = fixture.requests.filter(([url]) => url.endsWith("listDocsByPath"));
        assert.equal(lists.length, [1, 4, 7][depth - 1]);
        assert.ok(
            lists.every(([, body, app, notify]) =>
                body.notebook === NOTEBOOK && body.maxListCount === 0 && !("sort" in body) && !("showHidden" in body) &&
                app === undefined && notify === false
            ),
        );
        assert.ok(!lists.some(([, body]) => body.path === fixture.paths.get(hierarchyId(7))));
        assert.deepEqual(Object.keys(nodes[0]), ["id", "title", "children"]);
        assert.equal(nodes.at(-1).children.length, 0);
    });
}

test("hierarchy validates depth/root before any requests and distinguishes root failure from empty success", async () => {
    const fixture = hierarchyFixture();
    const loaded = loadPlugin(english, fixture.fetch);
    for (const depth of [0, 4, -1, 1.5, "2", undefined, null]) {
        assert.equal(await loaded.children.resolveHierarchy(ROOT_A, depth), null);
    }
    assert.equal(await loaded.children.resolveHierarchy("invalid", 3), null);
    assert.equal(await loaded.children.resolveHierarchy(ROOT_A, 3, () => false), null);
    assert.equal(fixture.requests.length, 0);
    for (const stage of ["getPathByID", "listDocsByPath"]) {
        const failed = loadPlugin(english, (url, body) => url.endsWith(stage) ? {code: -1} : fixture.answer(url, body));
        assert.equal(await failed.children.resolveHierarchy(ROOT_A, 3), null);
    }
    assert.equal(JSON.stringify(await loaded.children.resolveHierarchy(hierarchyId(3), 3)), "[]");
});

for (const failure of ["API", "throw", "path", "notebook", "duplicate", "root-cycle", "malformed"]) {
    test(`deeper ${failure} failure omits only that parent's descendants without following unsafe records`, async () => {
        const fixture = hierarchyFixture();
        const loaded = loadPlugin(english, (url, body) => {
            fixture.requests.push([url, body]);
            const result = fixture.answer(url, body);
            if (!url.endsWith("listDocsByPath") || body.path !== fixture.paths.get(hierarchyId(1))) return result;
            if (failure === "API") return {code: -1};
            if (failure === "throw") throw new Error("Raw branch error");
            if (failure === "path") result.data.files[0].path = `/unrelated/${hierarchyId(4)}.sy`;
            if (failure === "notebook") result.data.box = ROOT_B;
            if (failure === "duplicate") result.data.files.push(result.data.files[0]);
            if (failure === "root-cycle") {
                result.data.files = [{id: ROOT_A, name: "Cycle", path: `${body.path.slice(0, -3)}/${ROOT_A}.sy`}];
            }
            if (failure === "malformed") result.data.files = null;
            return result;
        });
        const nodes = await loaded.children.resolveHierarchy(ROOT_A, 3);
        assert.deepEqual([...nodes.map(node => node.title)], ["A", "B", "C"]);
        assert.equal(nodes[0].children.length, 0);
        assert.equal(nodes[1].children[0].title, "B1");
        assert.ok(!fixture.requests.some(([, body]) => body.path === fixture.paths.get(hierarchyId(5))));
    });
}

test("out-of-order discovery preserves every native sibling position", async () => {
    const fixture = hierarchyFixture();
    const pending = [];
    const loaded = loadPlugin(english, (url, body) => {
        const result = fixture.answer(url, body);
        return url.endsWith("listDocsByPath") && body.path !== pathFor(ROOT_A) ?
            new Promise(resolve => pending.push(() => resolve(result))) :
            result;
    });
    const operation = loaded.children.resolveHierarchy(ROOT_A, 3);
    await settleContext();
    assert.equal(pending.length, 3);
    pending.splice(0).reverse().forEach(resolve => resolve());
    await settleContext();
    pending.splice(0).reverse().forEach(resolve => resolve());
    const nodes = await operation;
    assert.deepEqual([...nodes[0].children.map(node => node.title)], ["A2", "A1"]);
    assert.deepEqual([...nodes[0].children[1].children.map(node => node.title)], ["A1b", "A1a"]);
});

test("discovery concurrency is at most four locally and independent operations each progress", async () => {
    const fixture = hierarchyFixture();
    fixture.branches.set(ROOT_A, Array.from({length: 9}, (_, i) => [20 + i, `Child ${i}`]));
    for (let i = 20; i < 29; i++) fixture.paths.set(hierarchyId(i), `/${ROOT_A}/${hierarchyId(i)}.sy`);
    const pending = [[], []];
    const active = [0, 0];
    const maxima = [0, 0];
    const operations = [0, 1].map(instance => {
        const loaded = loadPlugin(english, (url, body) => {
            const result = fixture.answer(url, body);
            if (!url.endsWith("listDocsByPath") || body.path === pathFor(ROOT_A)) return result;
            active[instance]++;
            maxima[instance] = Math.max(maxima[instance], active[instance]);
            return new Promise(resolve =>
                pending[instance].push(() => {
                    active[instance]--;
                    resolve(result);
                })
            );
        });
        return loaded.children.resolveHierarchy(ROOT_A, 2);
    });
    await settleContext();
    assert.deepEqual(active, [4, 4]);
    while (pending.some(queue => queue.length)) {
        pending.forEach(queue => queue.splice(0).reverse().forEach(resolve => resolve()));
        await settleContext();
    }
    const [a, b] = await Promise.all(operations);
    assert.deepEqual(maxima, [4, 4]);
    a[0].title = "Only A";
    assert.equal(b[0].title, "Child 0");
});

for (const depth of [2, 3]) {
    for (const orientation of ["vertical", "horizontal"]) {
        test(`grouped depth ${depth}/${orientation} has semantic preorder, shared layout, no repeated headings or empty lists`, async () => {
            const fixture = hierarchyFixture();
            const opened = [];
            const fragments = new Map(
                [...fixture.paths].map(([id]) => [id, previewFragment(paragraph(textNode(`Preview ${id}`)))]),
            );
            const loaded = loadPlugin(
                english,
                fixture.fetch,
                {openTab: options => opened.push(options.doc.id)},
                fragments,
            );
            const {mount} = renderMount(loaded, BLOCK_A, {
                ...loaded.config.DEFAULT_CONFIG,
                depth,
                orientation,
                columns: 2,
            });
            await settleContext();
            assert.deepEqual(hierarchyTitles(mount), expectedHierarchy[depth - 1]);
            assert.equal(mount.children[0].getAttribute("data-orientation"), orientation);
            assert.equal(mount.children[0].getAttribute("data-columns"), "2");
            const group = mount.children[0].children[2];
            assert.equal(group.tag, "ul");
            assert.equal(group.getAttribute("role"), "list");
            assert.equal(group.getAttribute("data-level"), "1");
            assert.equal(group.children[0].tag, "li");
            const nested = group.children[0].children[1];
            assert.equal(nested.tag, "ul");
            assert.equal(nested.getAttribute("data-level"), "2");
            assert.ok(nested.className.includes("child-gallery__nested"));
            assert.equal(group.children.at(-1).children.length, 1);
            const buttons = descendantCards(mount);
            assert.ok(
                buttons.every(card =>
                    card.tag === "button" && card.type === "button" && !card.getAttribute("tabindex") &&
                    !card.listeners.keydown
                ),
            );
            const ids = expectedHierarchy[depth - 1].map(title =>
                [...fixture.branches.values()].flat().find(([, name]) => name === title)[0]
            ).map(hierarchyId);
            buttons.forEach((card, index) => {
                assert.equal(descriptionPart(card).textContent, `Preview ${ids[index]}`);
                card.click();
            });
            await settleContext();
            assert.deepEqual(opened, ids);
            assert.equal(buttons.filter(card => titlePart(card).textContent === "A").length, 1);
            assert.equal(group.textContent.includes("Children"), false);
            assert.equal(group.textContent.includes("Unterseiten"), false);
        });
    }
}

test("previews wait for the last descendant listing and the complete title hierarchy", async () => {
    const fixture = hierarchyFixture();
    let finishListing;
    let previewReads = 0;
    let mount;
    const loaded = loadPlugin(english, (url, body) => {
        if (url.endsWith("listDocsByPath") && body.path === fixture.paths.get(hierarchyId(5))) {
            return new Promise(resolve => {
                finishListing = () => resolve(fixture.answer(url, body));
            });
        }
        if (url.endsWith("getBlockDOM")) {
            previewReads++;
            assert.deepEqual(hierarchyTitles(mount), expectedHierarchy[2]);
        }
        return fixture.fetch(url, body);
    });
    ({mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3}));
    await settleContext();
    assert.equal(typeof finishListing, "function");
    assert.equal(previewReads, 0);
    assert.deepEqual(hierarchyTitles(mount), []);
    finishListing();
    await settleContext();
    assert.equal(previewReads, expectedHierarchy[2].length);
    assert.deepEqual(hierarchyTitles(mount), expectedHierarchy[2]);
});

test("hierarchical descendant preview failure preserves parent/children and every navigable card", async () => {
    const fixture = hierarchyFixture();
    const loaded = loadPlugin(
        english,
        (url, body) =>
            url.endsWith("getBlockDOM") && body.id === hierarchyId(5) ? {code: -1} : fixture.answer(url, body),
    );
    const {mount, status} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3});
    await settleContext();
    assert.deepEqual(hierarchyTitles(mount), expectedHierarchy[2]);
    assert.equal(status.textContent, "");
    const failed = descendantCards(mount).find(card => titlePart(card).textContent === "A1");
    assert.equal(failed.children.length, 2);
    assert.ok(fallbackPart(failed));
});

test("preview queue limits to four and reversed completions never reorder cards or assignments", async () => {
    const fixture = hierarchyFixture();
    const pending = new Map();
    const fragments = new Map([...fixture.paths].map(([id]) => [id, previewFragment(paragraph(textNode(id)))]));
    let active = 0;
    let maximum = 0;
    const loaded = loadPlugin(
        english,
        (url, body) => {
            if (!url.endsWith("getBlockDOM")) return fixture.answer(url, body);
            active++;
            maximum = Math.max(maximum, active);
            return new Promise(resolve =>
                pending.set(body.id, () => {
                    active--;
                    resolve(previewResponse(body.id, body.id));
                })
            );
        },
        {},
        fragments,
    );
    const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3});
    await settleContext();
    const original = descendantCards(mount);
    assert.equal(active, 4);
    assert.deepEqual(hierarchyTitles(mount), expectedHierarchy[2]);
    while (pending.size) {
        const batch = [...pending.values()];
        pending.clear();
        batch.reverse().forEach(resolve => resolve());
        await settleContext();
    }
    assert.equal(maximum, 4);
    assert.deepEqual(descendantCards(mount), original);
    assert.deepEqual(
        original.map(card => descriptionPart(card).textContent),
        [1, 4, 5, 6, 7, 2, 8, 3].map(hierarchyId),
    );
});

for (const stage of ["discovery", "preview"]) {
    for (const invalidation of ["cleanup", "detach", "replace"]) {
        test(`stale ${stage}/${invalidation} suppresses publication/queued starts and preserves another depth-1 gallery`, async () => {
            const fixture = hierarchyFixture();
            const pending = [];
            let starts = 0;
            const loaded = loadPlugin(english, (url, body) => {
                const result = fixture.answer(url, body);
                const hold = stage === "discovery" ?
                    url.endsWith("listDocsByPath") && body.path !== pathFor(ROOT_A) && body.path !== pathFor(ROOT_B) :
                    url.endsWith("getBlockDOM") && body.id !== hierarchyId(10);
                if (!hold) return result;
                starts++;
                return new Promise(resolve => pending.push(() => resolve(result)));
            });
            const a = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3});
            const b = renderMount(loaded, BLOCK_B);
            await settleContext();
            const old = descendantCards(a.mount);
            if (invalidation === "cleanup") a.dispose();
            if (invalidation === "detach") a.mount.connected = false;
            if (invalidation === "replace") a.mount.replaceChildren(element("successor", loaded.document));
            const count = starts;
            pending.splice(0).forEach(resolve => resolve());
            await settleContext();
            assert.equal(starts, count);
            assert.deepEqual(hierarchyTitles(b.mount), ["Other"]);
            assert.ok(old.every(card => card.children.length === 1));
            if (stage === "discovery") assert.equal(hierarchyTitles(a.mount).length, 0);
        });
    }
}

test("targeted depth serialization preserves every other field, rejects invalid/future/multiple edits", () => {
    const {config} = loadPlugin();
    const original = {
        ...config.DEFAULT_CONFIG,
        columns: 3,
        orientation: "horizontal",
        showImage: false,
        extra: {literal: "keep"},
    };
    for (const depth of [1, 2, 3]) {
        assert.deepEqual(JSON.parse(config.updateGalleryConfig(JSON.stringify(original), {depth})), {
            ...original,
            depth,
        });
    }
    for (
        const patch of [
            {depth: 0},
            {depth: 4},
            {depth: "2"},
            {depth: undefined},
            {depth: 2, columns: 1},
            {extra: 1},
            {},
        ]
    ) assert.equal(config.updateGalleryConfig(JSON.stringify(original), patch), undefined);
    assert.equal(config.updateGalleryConfig(JSON.stringify({...original, version: 2}), {depth: 2}), undefined);
});

test("nested CSS inherits responsive preferences without dense placement, fixed heights or width listeners", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    assert.match(css, /\[data-columns="#\{\$columns\}"\] \.child-gallery__grid/);
    assert.match(css, /border-inline-start:\s*1px/);
    assert.match(css, /padding-inline-start:\s*min\(8px, 2cqw\)/);
    assert.match(css, /\.child-gallery__branch[\s\S]*?flex-direction:\s*column/);
    assert.ok(!/grid-auto-flow:\s*dense|\border:\s*\d/.test(css));
});

test("descendants reuse all four image/paragraph fallbacks and both disabled flags skip content reads", async () => {
    const fixture = hierarchyFixture();
    const fragments = new Map([
        [hierarchyId(1), previewFragment(paragraph(contentImage("assets/a.png"), textNode("Text A")))],
        [hierarchyId(5), previewFragment(paragraph(textNode("Text A1")))],
        [hierarchyId(6), previewFragment(paragraph(contentImage("assets/deep.png")))],
    ]);
    const loaded = loadPlugin(english, fixture.fetch, {}, fragments);
    const {mount} = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3});
    await settleContext();
    const byTitle = new Map(descendantCards(mount).map(card => [titlePart(card).textContent, card]));
    assert.ok(imagePart(byTitle.get("A")));
    assert.equal(descriptionPart(byTitle.get("A")).textContent, "Text A");
    assert.equal(imagePart(byTitle.get("A1")), undefined);
    assert.equal(descriptionPart(byTitle.get("A1")).textContent, "Text A1");
    assert.ok(imagePart(byTitle.get("A1b")));
    assert.equal(descriptionPart(byTitle.get("A1b")), undefined);
    assert.equal(byTitle.get("A1a").children.length, 2);
    assert.ok(fallbackPart(byTitle.get("A1")));
    assert.ok(fallbackPart(byTitle.get("A1a")));
    assert.equal(fallbackPart(byTitle.get("A")), undefined);
    assert.equal(fallbackPart(byTitle.get("A1b")), undefined);
    const titleOnly = loadPlugin(english, fixture.fetch);
    const before = fixture.requests.length;
    const b = renderMount(titleOnly, BLOCK_A, {
        ...titleOnly.config.DEFAULT_CONFIG,
        depth: 3,
        showImage: false,
        showDescription: false,
    });
    await settleContext();
    assert.deepEqual(hierarchyTitles(b.mount), expectedHierarchy[2]);
    assert.ok(!fixture.requests.slice(before).some(([url]) => url.endsWith("getBlockDOM")));
});

test("depth-3 cleanup does not stop a simultaneous depth-1 preview queue or its assignments", async () => {
    const fixture = hierarchyFixture();
    const pending = new Map();
    const fragments = new Map([...fixture.paths].map(([id]) => [id, previewFragment(paragraph(textNode(id)))]));
    const loaded = loadPlugin(
        english,
        (url, body) =>
            url.endsWith("getBlockDOM") ?
                new Promise(resolve => pending.set(body.id, resolve)) :
                fixture.answer(url, body),
        {},
        fragments,
    );
    const a = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3});
    const b = renderMount(loaded, BLOCK_B);
    await settleContext();
    assert.equal(pending.size, 5); // Four A workers plus the independent one-node B render.
    a.dispose();
    for (const [id, resolve] of pending) resolve(previewResponse(id, id));
    await settleContext();
    assert.equal(descriptionPart(descendantCards(b.mount)[0]).textContent, hierarchyId(10));
    assert.equal(descendantCards(a.mount).length, 0);
    assert.equal(pending.size, 5); // No further A preview work started.
});

test("depth menu persists only A's selected depth, preserves B and leaves rebuilding to the host", async () => {
    const fixture = hierarchyFixture();
    const loaded = loadPlugin(english, fixture.fetch);
    const saved = [[], []];
    const original = {
        ...loaded.config.DEFAULT_CONFIG,
        orientation: "horizontal",
        columns: 2,
        showDescription: false,
        extra: {keep: true},
    };
    const a = renderMount(loaded, BLOCK_A, original, content => {
        saved[0].push(JSON.parse(content));
        return true;
    });
    const b = renderMount(loaded, BLOCK_B, loaded.config.DEFAULT_CONFIG, content => {
        saved[1].push(JSON.parse(content));
        return true;
    });
    await settleContext();
    const before = fixture.requests.length;
    const menu = openSettings(loaded, a.mount);
    menu.items[2].submenu[2].click();
    assert.deepEqual(saved, [[{...original, depth: 3}], []]);
    assert.deepEqual(hierarchyTitles(b.mount), ["Other"]);
    assert.deepEqual(hierarchyTitles(a.mount), ["A", "B", "C"]); // No speculative local replacement before host rerender.
    await settleContext();
    assert.equal(fixture.requests.length, before);
    a.dispose();
    const successor = renderMount(loaded, BLOCK_A, saved[0][0]);
    await settleContext();
    assert.deepEqual(hierarchyTitles(successor.mount), expectedHierarchy[2]);
    assert.deepEqual(hierarchyTitles(b.mount), ["Other"]);
    const checked = openSettings(loaded, successor.mount).items[2].submenu;
    assert.equal(checked[2].checked, true);
    assert.equal(checked[0].checked, false);
});

for (const refusal of ["false", "throw", "stale"]) {
    test(`depth ${refusal} write preserves saved config and active discovery`, async () => {
        const fixture = hierarchyFixture();
        let writes = 0;
        const loaded = loadPlugin(english, fixture.fetch);
        const a = renderMount(loaded, BLOCK_A, loaded.config.DEFAULT_CONFIG, () => {
            writes++;
            if (refusal === "throw") throw new Error("Raw save error");
            return false;
        });
        await settleContext();
        const menu = openSettings(loaded, a.mount);
        if (refusal === "stale") a.dispose();
        menu.items[2].submenu[1].click();
        assert.equal(writes, refusal === "stale" ? 0 : 1);
        if (refusal !== "stale") {
            assert.deepEqual(hierarchyTitles(a.mount), ["A", "B", "C"]);
            assert.equal(a.status.textContent, english.settingsUnavailable);
            assert.equal(openSettings(loaded, a.mount).items[2].submenu[0].checked, true);
        }
    });
}

test("accepted depth change stops the old queued preview work before host disposal", async () => {
    const fixture = hierarchyFixture();
    const pending = [];
    let starts = 0;
    const loaded = loadPlugin(english, (url, body) => {
        if (!url.endsWith("getBlockDOM")) return fixture.answer(url, body);
        starts++;
        return new Promise(resolve => pending.push(() => resolve(previewResponse(body.id, body.id))));
    });
    const a = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, depth: 3}, () => true);
    await settleContext();
    assert.equal(starts, 4);
    openSettings(loaded, a.mount).items[2].submenu[0].click();
    pending.forEach(resolve => resolve());
    await settleContext();
    assert.equal(starts, 4);
    assert.deepEqual(hierarchyTitles(a.mount), expectedHierarchy[2]);
    assert.ok(descendantCards(a.mount).every(card => card.children.length === 1));
});

async function renderImageSource(source = "assets/photo.png", config = {}) {
    const fragment = previewFragment(paragraph(contentImage(source)), paragraph(textNode("Description stays")));
    const loaded = loadPlugin(
        english,
        (url, body) => url.endsWith("getBlockDOM") ? previewResponse(body.id, "fixture") : kernelResponse(url, body),
        {},
        new Map([["fixture", fragment]]),
    );
    const rendered = renderMount(loaded, BLOCK_A, {...loaded.config.DEFAULT_CONFIG, ...config}, () => true);
    await settleContext();
    const card = cards(rendered.mount)[0];
    return {...rendered, loaded, card, media: mediaPart(card), image: imagePart(card)};
}

function finishImage(fixture, naturalWidth, naturalHeight, width = 128, height = 128) {
    fixture.image.naturalWidth = naturalWidth;
    fixture.image.naturalHeight = naturalHeight;
    fixture.media.clientWidth = width;
    fixture.media.clientHeight = height;
    fixture.image.listeners.load();
}

for (
    const [naturalWidth, naturalHeight, width, height, expected] of [
        [1024, 768, 320, 128, "cover"],
        [100, 100, 150, 150, "cover"],
        [100, 100, 151, 150, "contained"],
        [200, 80, 200, 121, "contained"],
        [32, 32, 320, 128, "contained"],
        [240, 160, 600, 128, "contained"],
        [0, 100, 320, 128, "cover"],
        [100, 0, 320, 128, "cover"],
        [100, 100, 0, 128, "cover"],
        [100, 100, 128, 0, "cover"],
    ]
) {
    test(`adaptive raster ${naturalWidth}x${naturalHeight} in ${width}x${height} is ${expected}`, async () => {
        const fixture = await renderImageSource();
        const {card, media, image, loaded} = fixture;
        assert.equal(media.parentElement, card);
        assert.equal(image.parentElement, media);
        assert.equal(media.getAttribute("aria-hidden"), "true");
        assert.equal(media.getAttribute("data-media-state"), "loading");
        assert.equal(image.handlersBeforeSource, true);
        assert.equal(image.loading, "lazy");
        assert.equal(image.alt, "");
        assert.equal(card.children.filter(child => child === media).length, 1);
        finishImage(fixture, naturalWidth, naturalHeight, width, height);
        assert.equal(media.getAttribute("data-media-state"), expected);
        assert.equal(imagePart(card), image); // Valid small images are retained.
        assert.equal(descriptionPart(card).textContent, "Description stays");
        assert.deepEqual(coverAppearance(media), plainPreview(loaded.fallback.fallbackCoverAppearance(CHILD_A2)));
        const writes = media.attributeWrites.length;
        image.listeners.load(); // Cache/load duplicates must not repeat classification or observation.
        assert.equal(media.attributeWrites.length, writes);
        assert.equal(loaded.observers.length, 1);
        fixture.dispose();
        assert.equal(loaded.observers[0].disconnected, true);
    });
}

for (
    const source of [
        "assets/a.PNG",
        "assets/a.jpg",
        "assets/a.jpeg",
        "assets/a.gif",
        "assets/a.webp",
        "assets/a.avif",
        "assets/a.bmp",
        "assets/a.tif",
        "assets/a.tiff",
        "https://example.test/photo.PNG?download=1#fragment",
        "//example.test/photo.webp",
        ...["png", "jpeg", "gif", "webp", "avif"].map(type => `data:image/${type};base64,AA==`),
    ]
) {
    test(`recognized raster source is adaptive: ${source}`, async () => {
        const fixture = await renderImageSource(source);
        assert.equal(fixture.media.getAttribute("data-media-state"), "loading");
        finishImage(fixture, 16, 16);
        assert.equal(fixture.media.getAttribute("data-media-state"), "contained");
        fixture.dispose();
    });
}

for (
    const source of [
        "assets/a.svg",
        "https://example.test/a.SVG?x=1",
        "https://example.test/image",
        "//example.test/image?type=png",
    ]
) {
    test(`SVG/unknown source stays immediately visible cover: ${source}`, async () => {
        const fixture = await renderImageSource(source);
        assert.equal(fixture.media.getAttribute("data-media-state"), "cover");
        finishImage(fixture, 1, 1);
        assert.equal(fixture.media.getAttribute("data-media-state"), "cover");
        assert.equal(fixture.loaded.observers.length, 0);
        fixture.dispose();
    });
}

test("resize reclassifies loaded raster both ways without changing wrapper geometry or rewriting unchanged state", async () => {
    const fixture = await renderImageSource();
    finishImage(fixture, 100, 100);
    const observer = fixture.loaded.observers[0];
    assert.equal(observer.target, fixture.media);
    assert.equal(fixture.media.getAttribute("data-media-state"), "cover");
    observer.emit(151, 128);
    assert.equal(fixture.media.getAttribute("data-media-state"), "contained");
    const writes = fixture.media.attributeWrites.length;
    observer.emit(200, 128);
    observer.emit(200, 128);
    observer.emit(0, 0);
    assert.equal(fixture.media.attributeWrites.length, writes);
    observer.emit(150, 128);
    assert.equal(fixture.media.getAttribute("data-media-state"), "cover");
    assert.equal(imagePart(fixture.card), fixture.image);
    fixture.dispose();
});

test("zero initial media measurement is cover until a positive resize measurement becomes available", async () => {
    const fixture = await renderImageSource();
    finishImage(fixture, 32, 32, 0, 0);
    assert.equal(fixture.media.getAttribute("data-media-state"), "cover");
    fixture.loaded.observers[0].emit(128, 128);
    assert.equal(fixture.media.getAttribute("data-media-state"), "contained");
    fixture.dispose();
});

test("image failure retains exactly the same gradient wrapper and disconnects its observer", async () => {
    const fixture = await renderImageSource();
    finishImage(fixture, 16, 16);
    const appearance = coverAppearance(fixture.media);
    fixture.image.listeners.error();
    assert.equal(mediaPart(fixture.card), fixture.media);
    assert.equal(fallbackPart(fixture.card), fixture.media);
    assert.equal(imagePart(fixture.card), undefined);
    assert.deepEqual(coverAppearance(fixture.media), appearance);
    assert.equal(fixture.loaded.observers[0].disconnected, true);
    const writes = fixture.media.attributeWrites.length;
    fixture.image.listeners.error();
    fixture.image.listeners.load();
    fixture.loaded.observers[0].emit(320, 128);
    assert.equal(fixture.media.attributeWrites.length, writes);
    assert.equal(fixture.card.children.filter(child => child === fixture.media).length, 1);
    fixture.dispose();
});

for (const action of ["dispose", "detach", "replace", "card", "container", "wrapper", "image", "depth", "hide"]) {
    for (const completed of [false, true]) {
        test(`late media events leave ${action} state untouched (loaded=${completed})`, async () => {
            const fixture = await renderImageSource();
            const {loaded, mount, card, media, image} = fixture;
            if (completed) finishImage(fixture, 100, 100);
            if (action === "dispose") fixture.dispose();
            if (action === "detach") mount.parent.connected = false;
            if (action === "replace") mount.replaceChildren(element("successor", loaded.document));
            if (action === "card") mount.children[0].append(card);
            if (action === "container") mount.append(card.parentElement);
            if (action === "wrapper") card.parentElement.append(media);
            if (action === "image") card.append(image);
            if (action === "depth") openSettings(loaded, mount).items[2].submenu[1].click();
            if (action === "hide") openSettings(loaded, mount).items[3].click();
            const writes = media.attributeWrites.length;
            const parent = image.parentElement;
            image.naturalWidth = 16;
            image.naturalHeight = 16;
            image.listeners.load();
            image.listeners.error();
            loaded.observers[0]?.emit(320, 128);
            assert.equal(media.attributeWrites.length, writes);
            assert.equal(image.parentElement, parent);
            if (completed) assert.equal(loaded.observers[0].disconnected, true);
            else assert.equal(loaded.observers.length, 0);
            fixture.dispose();
        });
    }
}

test("text-only and gradient-only media create no resize observers", async () => {
    for (const source of [undefined, "assets/photo.png"]) {
        const fixture = await renderImageSource(source, {showImage: false});
        assert.equal(mediaPart(fixture.card), undefined);
        assert.equal(imagePart(fixture.card), undefined);
        assert.equal(fixture.loaded.observers.length, 0);
        fixture.dispose();
    }
    const fixture = await renderImageSource("https://example.test/file.pdf");
    assert.equal(fallbackPart(fixture.card), fixture.media);
    assert.equal(fixture.media.children.length, 0);
    assert.equal(fixture.loaded.observers.length, 0);
    fixture.dispose();
});

test("adaptive CSS keeps all geometry on wrappers, hides only pending images and contains without upscaling", () => {
    const css = readFileSync(new URL("../src/index.scss", import.meta.url), "utf8");
    const image = css.match(/&__image\s*\{([^}]+)\}/)[1];
    assert.match(image, /box-sizing:\s*border-box/);
    assert.match(image, /width:\s*100%;/);
    assert.match(image, /height:\s*100%;/);
    assert.match(image, /object-fit:\s*cover;/);
    assert.match(image, /object-position:\s*center;/);
    assert.ok(!/rem|padding|display:\s*none/.test(image));
    assert.match(css, /data-media-state="loading"[^}]*opacity:\s*0;/s);
    assert.match(css, /data-media-state="cover"[^}]*background-image:\s*none;/s);
    assert.match(css, /data-media-state="contained"[^}]*padding:\s*0\.75rem;[^}]*object-fit:\s*scale-down;/s);
    assert.ok(!/animation|transition:/.test(css));
});

test("contained and gradient-only wrappers reuse the exact same child-ID appearance", async () => {
    const contained = await renderImageSource();
    finishImage(contained, 16, 16);
    const fallback = await renderImageSource("https://example.test/file.pdf");
    assert.equal(contained.media.getAttribute("data-media-state"), "contained");
    assert.equal(fallback.media.getAttribute("data-media-state"), "fallback");
    assert.deepEqual(coverAppearance(contained.media), coverAppearance(fallback.media));
    contained.dispose();
    fallback.dispose();
});

test("media observers remain render-local and one cleanup leaves another gallery responsive", async () => {
    const first = await renderImageSource();
    const second = await renderImageSource();
    finishImage(first, 100, 100);
    finishImage(second, 100, 100);
    first.dispose();
    assert.equal(first.loaded.observers[0].disconnected, true);
    assert.equal(second.loaded.observers[0].disconnected, undefined);
    second.loaded.observers[0].emit(200, 128);
    assert.equal(second.media.getAttribute("data-media-state"), "contained");
    second.dispose();
});
