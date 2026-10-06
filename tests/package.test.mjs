import assert from "node:assert/strict";
import {
    mkdtempSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {
    crc32,
    deflateRawSync,
    deflateSync,
} from "node:zlib";
import {
    PACKAGE_FILES,
    README_IMAGES,
    README_MAPPINGS,
    imageTargets,
    validateReadmeImages,
    validateScreenshotPng,
    validateDistribution,
    validatePackage,
    zipFiles,
} from "./package-contract.mjs";

const root = new URL("../", import.meta.url);

// Tiny synthetic ZIP records for failure cases only; production packaging stays in Webpack.
function zip(entries, method = 8) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const [name, bytes] of entries) {
        const filename = Buffer.from(name);
        const data = method === 8 ? deflateRawSync(bytes) : bytes;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50);
        header.writeUInt16LE(20, 4);
        header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(method, 8);
        header.writeUInt32LE(crc32(bytes), 14);
        header.writeUInt32LE(data.length, 18);
        header.writeUInt32LE(bytes.length, 22);
        header.writeUInt16LE(filename.length, 26);
        local.push(header, filename, data);
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02014b50);
        record.writeUInt16LE(20, 4);
        record.writeUInt16LE(20, 6);
        record.writeUInt16LE(0x800, 8);
        record.writeUInt16LE(method, 10);
        record.writeUInt32LE(crc32(bytes), 16);
        record.writeUInt32LE(data.length, 20);
        record.writeUInt32LE(bytes.length, 24);
        record.writeUInt16LE(filename.length, 28);
        record.writeUInt32LE(offset, 42);
        central.push(record, filename);
        offset += header.length + filename.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

function fixture() {
    const canonical = new Set(["package.json", ...Object.values(PACKAGE_FILES).filter(name => name !== null)]);
    const source = new Map([...canonical].map(name => [name, readFileSync(new URL(name, root))]));
    const files = new Map(
        Object.entries(PACKAGE_FILES).map(([name, from]) => [
            name,
            from === null ?
                Buffer.from(name.endsWith(".js") ? "module.exports = {};" : ".example { color: inherit; }") :
                Buffer.from(source.get(from)),
        ]),
    );
    return {files, dist: new Map(files), source, contract: PACKAGE_FILES};
}

const check = (f, options = {}) => validateDistribution({archive: zip([...f.files]), ...f, ...options});
const version = f => JSON.parse(f.source.get("package.json")).version;

function put(f, name, value) {
    const bytes = Buffer.from(value);
    f.files.set(name, bytes);
    f.dist.set(name, bytes);
    const canonical = f.contract[name];
    if (canonical) f.source.set(canonical, bytes);
}

function manifest(f, change) {
    const value = JSON.parse(f.files.get("plugin.json"));
    change(value);
    put(f, "plugin.json", JSON.stringify(value));
}

test("current package contract validates copied assets, exact inventory and version", () => {
    const f = fixture();
    assert.deepEqual(check(f), {inventory: Object.keys(PACKAGE_FILES).sort(), version: version(f)});
});

for (const name of Object.keys(PACKAGE_FILES)) {
    test(`missing required package file fails: ${name}`, () => {
        const f = fixture();
        f.files.delete(name);
        assert.throws(
            () => check(f),
            error => error.message.includes("ZIP inventory mismatch") && error.message.includes(name),
        );
    });
}

for (
    const name of [
        "unexpected.txt",
        ".DS_Store",
        "node_modules/example.js",
        "docs/internal-audit.md",
        "tasks/example.md",
        "package.zip",
        "index.js.map",
        "public-assets/demo/color-study.svg",
        "docs/screenshots/small-study.png",
        "dev-evidence/raw.png",
        "public-assets/screenshots/.gitkeep",
        "docs/screenshots/.gitkeep",
        "README.internal.md",
        "src/icons/icon-child-gallery.svg",
        "icon-child-gallery.svg",
        "docs/screenshots/icon-preview-sheet.png",
    ]
) {
    test(`unexpected runtime file fails: ${name}`, () => {
        const f = fixture();
        f.files.set(name, Buffer.from("Synthetic extra file"));
        assert.throws(() => check(f), /ZIP inventory mismatch/);
    });
}

test("duplicate ZIP entries fail", () => {
    assert.throws(
        () => zipFiles(zip([["example.txt", Buffer.from("one")], ["example.txt", Buffer.from("two")]])),
        /Duplicate ZIP entry/,
    );
});

test("STORE and DEFLATE payloads are read with the same verified bytes", () => {
    const entries = [["example.txt", Buffer.from("Synthetic payload")]];
    for (const method of [0, 8]) assert.deepEqual(zipFiles(zip(entries, method)), new Map(entries));
});

for (
    const corruption of [
        "invalid",
        "truncated",
        "directory-signature",
        "directory-bounds",
        "entry-count",
        "local-header",
        "CRC",
        "deflate",
    ]
) {
    test(`ZIP integrity rejects ${corruption}`, () => {
        let bytes = zip([["example.txt", Buffer.from("Synthetic payload")]], corruption === "CRC" ? 0 : 8);
        const end = bytes.length - 22;
        const central = bytes.readUInt32LE(end + 16);
        if (corruption === "invalid") bytes = Buffer.from("Not a ZIP");
        if (corruption === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
        if (corruption === "directory-signature") bytes.writeUInt32LE(0, central);
        if (corruption === "directory-bounds") bytes.writeUInt32LE(central + 1, end + 16);
        if (corruption === "entry-count") {
            bytes.writeUInt16LE(2, end + 8);
            bytes.writeUInt16LE(2, end + 10);
        }
        if (corruption === "local-header") bytes.writeUInt32LE(0, 0);
        if (corruption === "CRC") bytes[30 + Buffer.byteLength("example.txt")] ^= 1;
        if (corruption === "deflate") bytes.fill(255, 30 + Buffer.byteLength("example.txt"), central);
        assert.throws(() => zipFiles(bytes), /ZIP/);
    });
}

test("an outer wrapper directory fails the runtime contract", () => {
    const f = fixture();
    const archive = zip([...f.files].map(([name, bytes]) => [`wrapper/${name}`, bytes]));
    assert.throws(() => check(f, {archive}), /ZIP inventory mismatch/);
});

for (
    const name of [
        "../example.txt",
        "/example.txt",
        "folder/../example.txt",
        "folder\\example.txt",
        "C:/example.txt",
        "folder//example.txt",
    ]
) {
    test(`invalid archive path fails: ${name}`, () => {
        assert.throws(() => zipFiles(zip([[name, Buffer.from("Synthetic payload")]])), /Invalid archive path/);
    });
}

test("dist inventory mismatch fails", () => {
    const f = fixture();
    f.dist.delete("index.js");
    assert.throws(() => check(f), /dist inventory mismatch/);
});

test("dist/ZIP byte mismatch fails", () => {
    const f = fixture();
    f.dist.set("index.js", Buffer.from("module.exports = {changed: true};"));
    assert.throws(() => check(f), /dist\/ZIP bytes differ/);
});

for (const [name, canonical] of Object.entries(PACKAGE_FILES).filter(([, from]) => from !== null)) {
    test(`canonical copied asset mismatch fails: ${name}`, () => {
        const f = fixture();
        f.source.set(canonical, Buffer.concat([f.source.get(canonical), Buffer.from("\n")]));
        assert.throws(() => check(f), /Canonical asset bytes differ/);
    });
}

for (const mode of ["missing-target", "case", "default", "German"]) {
    test(`README mapping fails for ${mode}`, () => {
        const f = fixture();
        manifest(f, value => {
            if (mode === "missing-target") value.readme.default = "Missing.md";
            if (mode === "case") value.readme.default = "readme.md";
            if (mode === "default") delete value.readme.default;
            if (mode === "German") delete value.readme.de;
        });
        assert.throws(() => check(f), /README/);
    });
}

test("broken relative README image fails", () => {
    const f = fixture();
    put(f, "README.md", "![Example](assets/missing.png)");
    assert.throws(() => check(f), /Missing packaged README image/);
});

test("external image URLs, anchors, normal hyperlinks and code examples need no local assets", () => {
    const f = fixture();
    put(
        f,
        "README.md",
        '![Example](https://example.org/image.png "Example") ![Anchor](#example) [Guide](missing.md) `![Code](missing.png)`',
    );
    validateReadmeImages(f.files, ["README.md"]);
});

test("local image resolution supports encoded/angle paths and Markdown reference images", () => {
    const f = fixture();
    const name = "assets/example image.png";
    f.contract = {...PACKAGE_FILES, [name]: "tests/example-image.png"};
    put(f, name, f.files.get("icon.png"));
    put(
        f,
        "README.md",
        '![Inline](assets/example%20image.png)\n![Angle](<assets/example image.png> "Example")\n![Reference][cover]\n\n[cover]: assets/example%20image.png\n',
    );
    validateReadmeImages(f.files, ["README.md"]);
});

test("public documentation contract has exactly four READMEs, three screenshots and fifteen files", () => {
    assert.deepEqual(
        Object.keys(PACKAGE_FILES).sort(),
        [
            "index.js",
            "index.css",
            "plugin.json",
            "icon.png",
            "LICENSE",
            "THIRD_PARTY_NOTICES.md",
            "README.md",
            "README.de-DE.md",
            "README.siyuan.md",
            "README.siyuan.de-DE.md",
            "i18n/en.json",
            "i18n/de.json",
            "docs/screenshots/child-gallery-overview.png",
            "docs/screenshots/child-gallery-hierarchy.png",
            "docs/screenshots/child-gallery-text-only.png",
        ].sort(),
    );
    const f = fixture();
    assert.equal(version(f), "0.1.0");
    assert.deepEqual(JSON.parse(f.files.get("plugin.json")).readme, README_MAPPINGS);
    for (const [name, images] of Object.entries(README_IMAGES)) {
        const text = f.files.get(name).toString("utf8");
        assert.deepEqual(imageTargets(text), images);
        assert.equal(images.length, name.includes(".siyuan") ? 1 : 3);
        if (name.includes(".siyuan")) {
            assert.match(text, /https:\/\/github\.com\/blacknet76\/siyuan-child-gallery/);
            assert.doesNotMatch(text, /pnpm |validate:package/);
            assert.ok(text.length < f.files.get(name.includes("de-DE") ? "README.de-DE.md" : "README.md").length / 2);
        }
    }
});

for (const name of Object.keys(README_IMAGES)) {
    test(`README screenshot roles are enforced: ${name}`, () => {
        const f = fixture();
        put(f, name, "![Wrong role](docs/screenshots/child-gallery-hierarchy.png)");
        assert.throws(() => check(f), /README screenshot roles differ/);
    });
    test(`local image resolution applies to every public README: ${name}`, () => {
        const f = fixture();
        put(f, name, f.files.get(name).toString("utf8") + "\n![Missing](docs/screenshots/missing.png)\n");
        assert.throws(() => check(f), /Missing packaged README image/);
    });
}

test("installed README mapping rejects full manuals and redundant locale keys", () => {
    for (
        const change of [
            value => value.readme.default = "README.md",
            value => value.readme.de = "README.de-DE.md",
            value => value.readme["de-DE"] = "README.siyuan.de-DE.md",
        ]
    ) {
        const f = fixture();
        manifest(f, change);
        assert.throws(() => check(f), /README mappings must select/);
    }
});

test("approved screenshots decode with unchanged dimensions and metadata-free PNG chunks", () => {
    const f = fixture();
    for (
        const [name, dimensions] of [
            ["child-gallery-overview.png", {width: 960, height: 436}],
            ["child-gallery-hierarchy.png", {width: 960, height: 820}],
            ["child-gallery-text-only.png", {width: 860, height: 473}],
        ]
    ) assert.deepEqual(validateScreenshotPng(f.files.get(`docs/screenshots/${name}`), name), dimensions);
});

function pngChunk(name, data) {
    const kind = Buffer.from(name);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([kind, data])));
    return Buffer.concat([size, kind, data, checksum]);
}

function screenshotChunks(bytes) {
    const chunks = [];
    for (let offset = 8; offset < bytes.length;) {
        const end = offset + 12 + bytes.readUInt32BE(offset);
        chunks.push(bytes.subarray(offset, end));
        offset = end;
    }
    return chunks;
}

for (const metadata of ["tEXt", "zTXt", "iTXt", "eXIf", "iCCP"]) {
    test(`screenshot metadata is rejected even with matching source/dist/ZIP: ${metadata}`, () => {
        const f = fixture();
        const name = "docs/screenshots/child-gallery-overview.png";
        const bytes = f.files.get(name);
        put(
            f,
            name,
            Buffer.concat([
                bytes.subarray(0, 33),
                pngChunk(metadata, Buffer.from("Synthetic metadata")),
                bytes.subarray(33),
            ]),
        );
        assert.throws(() => check(f), /Unsupported PNG chunk\/metadata/);
    });
}

test("screenshot corruption is rejected independently of ZIP CRC and canonical equality", () => {
    const f = fixture();
    const name = "docs/screenshots/child-gallery-overview.png";
    const original = f.files.get(name);
    for (const mode of ["signature", "CRC", "truncated", "data", "decoded-size", "filter"]) {
        let bytes = Buffer.from(original);
        if (mode === "signature") bytes[0] = 0;
        if (mode === "CRC") bytes[32] ^= 1;
        if (mode === "truncated") bytes = bytes.subarray(0, bytes.length - 1);
        if (["data", "decoded-size", "filter"].includes(mode)) {
            const chunks = screenshotChunks(bytes);
            const rows = Buffer.alloc(436 * 961);
            if (mode === "filter") rows[0] = 5;
            const data = mode === "data" ?
                Buffer.from("Invalid compressed data") :
                deflateSync(mode === "decoded-size" ? Buffer.alloc(1) : rows);
            bytes = Buffer.concat([
                bytes.subarray(0, 8),
                ...chunks.map(chunk => chunk.toString("ascii", 4, 8) === "IDAT" ? pngChunk("IDAT", data) : chunk),
            ]);
        }
        put(f, name, bytes);
        assert.throws(() => check(f), /PNG/);
    }
});

test("every approved screenshot requires source/dist/ZIP byte equality", () => {
    for (const name of README_IMAGES["README.md"]) {
        const f = fixture();
        f.dist.set(name, Buffer.concat([f.dist.get(name), Buffer.from([0])]));
        assert.throws(() => check(f), /dist\/ZIP bytes differ/);
        f.dist.set(name, f.files.get(name));
        f.source.set(PACKAGE_FILES[name], Buffer.concat([f.source.get(PACKAGE_FILES[name]), Buffer.from([0])]));
        assert.throws(() => check(f), /Canonical asset bytes differ/);
    }
});

test("all four public READMEs use the independent generic privacy guard", () => {
    for (const name of Object.keys(README_IMAGES)) {
        for (
            const text of [
                "https:" + "//test-user:synthetic-password@example.org/",
                "https://example.org/?" + "token=synthetic-value",
                ["", "Users", "test-user", "project"].join("/"),
            ]
        ) {
            const f = fixture();
            put(f, name, text);
            assert.throws(
                () => check(f),
                /Packaged text privacy failure/,
            );
        }
    }
});

for (const location of ["package.json", "source", "dist", "ZIP"]) {
    test(`version mismatch fails in ${location}`, () => {
        const f = fixture();
        const bytes = location === "package.json" ? f.source.get("package.json") : f.files.get("plugin.json");
        const value = JSON.parse(bytes);
        value.version = `${value.version.split(".").slice(0, 2).join(".")}.${BigInt(value.version.split(".")[2]) + 1n}`;
        const changed = Buffer.from(JSON.stringify(value));
        if (location === "package.json") f.source.set("package.json", changed);
        if (location === "source") f.source.set("plugin.json", changed);
        if (location === "dist") f.dist.set("plugin.json", changed);
        if (location === "ZIP") f.files.set("plugin.json", changed);
        assert.throws(() => check(f), /version mismatch/);
    });
}

test("optional matching release tag succeeds and ordinary validation needs no tag", () => {
    const f = fixture();
    check(f);
    check(f, {releaseTag: `v${version(f)}`});
});

for (const tag of ["", "1.2.3", "v01.2.3", "v1.2", "v1.2.3-beta", " v1.2.3", "v1.2.3\n"]) {
    test(`invalid release tag format fails: ${JSON.stringify(tag)}`, () => {
        assert.throws(() => check(fixture(), {releaseTag: tag}), /Invalid release tag/);
    });
}

test("release tag/version mismatch fails", () => {
    const f = fixture();
    const [major, minor, patch] = version(f).split(".");
    assert.throws(
        () => check(f, {releaseTag: `v${major}.${minor}.${BigInt(patch) + 1n}`}),
        /Release tag\/version mismatch/,
    );
});

test("invalid PNG signature fails even when source/dist/ZIP agree", () => {
    const f = fixture();
    put(f, "icon.png", "Synthetic non-PNG bytes");
    assert.throws(() => check(f), /Invalid icon PNG signature/);
});

test("packaged profile paths fail the shared privacy guard", () => {
    const f = fixture();
    put(f, "README.md", ["", "Users", "test-user", "example-project"].join("/"));
    assert.throws(() => check(f), /Packaged text privacy failure/);
});

test("packaged secrets use the generic guard without a private comparison dataset", () => {
    for (const value of ["ghp_" + "x".repeat(24), ["-----BEGIN", "PRIVATE KEY-----"].join(" ")]) {
        const f = fixture();
        put(f, "README.md", value);
        assert.throws(
            () => check(f),
            /Packaged text privacy failure/,
        );
    }
});

test("legitimate third-party attribution passes package privacy checks", () => {
    const f = fixture();
    check(f);
    assert.ok(f.files.get("THIRD_PARTY_NOTICES.md").includes(Buffer.from("Copyright (c) 2020 Evan Wallace")));
});

test("GitHub workflows cannot enter the runtime package", () => {
    for (const name of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) {
        const f = fixture();
        f.files.set(name, Buffer.from("name: Synthetic workflow\n"));
        f.dist.set(name, f.files.get(name));
        assert.throws(() => check(f), /ZIP inventory mismatch/);
    }
});

test("real-package entry point requires existing production output", t => {
    const directory = mkdtempSync(path.join(tmpdir(), "child-gallery-package-test-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    assert.throws(() => validatePackage({sourceRoot: directory}), /package.zip is missing/);
    writeFileSync(path.join(directory, "package.zip"), zip([...fixture().files]));
    assert.throws(() => validatePackage({sourceRoot: directory}), /dist is missing/);
});

test("filesystem validation reads the exact dist tree and canonical sources", t => {
    const f = fixture();
    const directory = mkdtempSync(path.join(tmpdir(), "child-gallery-package-test-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    for (const [name, bytes] of [...f.source, ...[...f.dist].map(([name, bytes]) => [`dist/${name}`, bytes])]) {
        const target = path.join(directory, name);
        mkdirSync(path.dirname(target), {recursive: true});
        writeFileSync(target, bytes);
    }
    writeFileSync(path.join(directory, "package.zip"), zip([...f.files]));
    assert.equal(validatePackage({sourceRoot: directory}).version, version(f));
    mkdirSync(path.join(directory, "dist/internal"));
    assert.throws(() => validatePackage({sourceRoot: directory}), /Unexpected dist directory/);
});
