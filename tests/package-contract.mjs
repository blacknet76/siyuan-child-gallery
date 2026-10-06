import assert from "node:assert/strict";
import {
    existsSync,
    readFileSync,
    readdirSync,
} from "node:fs";
import path from "node:path";
import {
    crc32,
    inflateRawSync,
    inflateSync,
} from "node:zlib";
import {privacyIssues} from "./privacy-helpers.mjs";

// The single runtime contract: archive path -> canonical source, or null for generated output.
export const PACKAGE_FILES = Object.freeze({
    "index.js": null,
    "index.css": null,
    "plugin.json": "plugin.json",
    "icon.png": "icon.png",
    "README.md": "README.md",
    "README.de-DE.md": "README.de-DE.md",
    "README.siyuan.md": "README.siyuan.md",
    "README.siyuan.de-DE.md": "README.siyuan.de-DE.md",
    "LICENSE": "LICENSE",
    "THIRD_PARTY_NOTICES.md": "THIRD_PARTY_NOTICES.md",
    "i18n/en.json": "src/i18n/en.json",
    "i18n/de.json": "src/i18n/de.json",
    "docs/screenshots/child-gallery-overview.png": "docs/screenshots/child-gallery-overview.png",
    "docs/screenshots/child-gallery-hierarchy.png": "docs/screenshots/child-gallery-hierarchy.png",
    "docs/screenshots/child-gallery-text-only.png": "docs/screenshots/child-gallery-text-only.png",
});

export const README_MAPPINGS = Object.freeze({default: "README.siyuan.md", de: "README.siyuan.de-DE.md"});
const fullImages = Object.freeze([
    "docs/screenshots/child-gallery-overview.png",
    "docs/screenshots/child-gallery-hierarchy.png",
    "docs/screenshots/child-gallery-text-only.png",
]);
export const README_IMAGES = Object.freeze({
    "README.md": fullImages,
    "README.de-DE.md": fullImages,
    "README.siyuan.md": Object.freeze([fullImages[0]]),
    "README.siyuan.de-DE.md": Object.freeze([fullImages[0]]),
});

// Owned non-interlaced screenshot PNGs: CRCs, decoded scanlines and a metadata-free chunk allowlist.
// No re-encoding, optimization or pixel writes happen here.
export function validateScreenshotPng(bytes, label) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(signature), `Invalid PNG signature: ${label}`);
    const allowed = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);
    const chunks = [];
    const payloads = [];
    let offset = 8;
    while (offset < bytes.length) {
        assert.ok(offset + 12 <= bytes.length, `Truncated PNG chunk: ${label}`);
        const size = bytes.readUInt32BE(offset);
        const end = offset + 8 + size;
        assert.ok(end + 4 <= bytes.length, `Truncated PNG chunk: ${label}`);
        const name = bytes.toString("ascii", offset + 4, offset + 8);
        assert.ok(allowed.has(name), `Unsupported PNG chunk/metadata: ${label}`);
        assert.equal(crc32(bytes.subarray(offset + 4, end)), bytes.readUInt32BE(end), `PNG CRC mismatch: ${label}`);
        const data = bytes.subarray(offset + 8, end);
        chunks.push({name, data});
        if (name === "IDAT") payloads.push(data);
        offset = end + 4;
    }
    assert.equal(chunks[0]?.name, "IHDR", `Missing PNG header: ${label}`);
    assert.equal(chunks.at(-1)?.name, "IEND", `Missing PNG end: ${label}`);
    for (const name of ["IHDR", "PLTE", "tRNS", "IEND"]) {
        assert.ok(chunks.filter(chunk => chunk.name === name).length <= 1, `Duplicate PNG chunk: ${label}`);
    }
    assert.equal(chunks.at(-1).data.length, 0, `Invalid PNG end: ${label}`);
    const header = chunks[0].data;
    assert.equal(header.length, 13, `Invalid PNG header: ${label}`);
    const width = header.readUInt32BE(0);
    const height = header.readUInt32BE(4);
    const depth = header[8];
    const color = header[9];
    assert.ok(width > 0 && height > 0, `Invalid PNG dimensions: ${label}`);
    assert.ok(
        (color === 3 && [1, 2, 4, 8].includes(depth)) || ([2, 6].includes(color) && depth === 8),
        `Unsupported screenshot PNG format: ${label}`,
    );
    assert.deepEqual([...header.subarray(10)], [0, 0, 0], `Unsupported PNG encoding: ${label}`);
    const firstData = chunks.findIndex(chunk => chunk.name === "IDAT");
    assert.ok(firstData > 0 && payloads.length > 0, `Missing PNG image data: ${label}`);
    assert.ok(
        chunks.slice(firstData, -1).every(chunk => chunk.name === "IDAT"),
        `Nonconsecutive PNG image data: ${label}`,
    );
    const palette = chunks.find(chunk => chunk.name === "PLTE")?.data;
    if (color === 3) assert.ok(palette, `Missing PNG palette: ${label}`);
    if (palette) {
        assert.ok(
            palette.length > 0 && palette.length % 3 === 0 && palette.length <= 768 &&
                (color !== 3 || palette.length / 3 <= 2 ** depth),
            `Invalid PNG palette: ${label}`,
        );
    }
    const transparency = chunks.find(chunk => chunk.name === "tRNS")?.data;
    if (transparency) {
        assert.ok(
            (color === 3 && transparency.length > 0 && transparency.length <= palette.length / 3) ||
                (color === 2 && transparency.length === 6),
            `Invalid PNG transparency: ${label}`,
        );
    }
    const channels = color === 3 ? 1 : color === 2 ? 3 : 4;
    const stride = 1 + Math.ceil(width * channels * depth / 8);
    let rows;
    try {
        rows = inflateSync(Buffer.concat(payloads), {maxOutputLength: height * stride + 1});
    } catch {
        throw new Error(`Invalid PNG image data: ${label}`);
    }
    assert.equal(rows.length, height * stride, `PNG decoded size mismatch: ${label}`);
    for (let row = 0; row < height; row++) assert.ok(rows[row * stride] <= 4, `Invalid PNG row filter: ${label}`);
    return {width, height};
}

function archivePath(name) {
    assert.ok(
        name && !name.includes("\\") && !name.startsWith("/") && !/^[a-z]:/i.test(name) &&
            name.split("/").every(part => part && part !== "." && part !== ".."),
        "Invalid archive path (absolute, traversal or non-forward-slash path)",
    );
}

// Parse our own single-disk production ZIP, using its central directory and CRCs.
// ZIP64, encryption and compression other than STORE/DEFLATE are outside this build contract.
export function zipFiles(bytes) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 22, "Invalid ZIP data");
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    assert.ok(end >= 0 && end + 22 <= bytes.length, "Missing ZIP end record");
    assert.equal(end + 22 + bytes.readUInt16LE(end + 20), bytes.length, "Invalid ZIP end record");
    assert.equal(bytes.readUInt16LE(end + 4), 0, "Unsupported multi-disk ZIP");
    assert.equal(bytes.readUInt16LE(end + 6), 0, "Unsupported multi-disk ZIP");
    const count = bytes.readUInt16LE(end + 10);
    assert.equal(bytes.readUInt16LE(end + 8), count, "ZIP entry count mismatch");
    const start = bytes.readUInt32LE(end + 16);
    const size = bytes.readUInt32LE(end + 12);
    assert.equal(start + size, end, "Invalid ZIP central directory bounds");
    const files = new Map();
    let offset = start;
    for (let index = 0; index < count; index++) {
        assert.ok(offset + 46 <= end, "Truncated ZIP central directory");
        assert.equal(bytes.readUInt32LE(offset), 0x02014b50, "Invalid ZIP central directory entry");
        const flags = bytes.readUInt16LE(offset + 8);
        const method = bytes.readUInt16LE(offset + 10);
        const checksum = bytes.readUInt32LE(offset + 16);
        const compressedSize = bytes.readUInt32LE(offset + 20);
        const uncompressedSize = bytes.readUInt32LE(offset + 24);
        const nameLength = bytes.readUInt16LE(offset + 28);
        const extraLength = bytes.readUInt16LE(offset + 30);
        const commentLength = bytes.readUInt16LE(offset + 32);
        const localOffset = bytes.readUInt32LE(offset + 42);
        const next = offset + 46 + nameLength + extraLength + commentLength;
        assert.ok(next <= end, "Truncated ZIP central directory entry");
        assert.equal(bytes.readUInt16LE(offset + 34), 0, "Unsupported multi-disk ZIP entry");
        const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
        archivePath(name);
        assert.ok(!files.has(name), `Duplicate ZIP entry: ${name}`);
        assert.ok(!(flags & 1) && (method === 0 || method === 8), `Unsupported ZIP entry: ${name}`);
        assert.ok(localOffset + 30 <= start, `Invalid ZIP local header: ${name}`);
        assert.equal(bytes.readUInt32LE(localOffset), 0x04034b50, `Invalid ZIP local header: ${name}`);
        assert.equal(bytes.readUInt16LE(localOffset + 6), flags, `ZIP header flags differ: ${name}`);
        assert.equal(bytes.readUInt16LE(localOffset + 8), method, `ZIP header methods differ: ${name}`);
        const localNameLength = bytes.readUInt16LE(localOffset + 26);
        const localExtraLength = bytes.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        assert.ok(dataStart + compressedSize <= start, `Truncated ZIP payload: ${name}`);
        assert.equal(
            bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8"),
            name,
            "ZIP local/central filenames differ",
        );
        if (!(flags & 8)) { // A data descriptor lets the central directory carry these values instead.
            assert.equal(bytes.readUInt32LE(localOffset + 14), checksum, `ZIP header CRCs differ: ${name}`);
            assert.equal(bytes.readUInt32LE(localOffset + 18), compressedSize, `ZIP header sizes differ: ${name}`);
            assert.equal(bytes.readUInt32LE(localOffset + 22), uncompressedSize, `ZIP header sizes differ: ${name}`);
        }
        const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
        let data;
        try {
            data = method === 0 ? compressed : inflateRawSync(compressed);
        } catch {
            throw new Error(`Cannot decompress ZIP entry: ${name}`);
        }
        assert.equal(data.length, uncompressedSize, `ZIP payload size mismatch: ${name}`);
        assert.equal(crc32(data), checksum, `ZIP CRC mismatch: ${name}`);
        files.set(name, data);
        offset = next;
    }
    assert.equal(offset, end, "ZIP central directory count/size mismatch");
    return files;
}

function inventory(files, expected, label) {
    const missing = expected.filter(name => !files.has(name));
    const unexpected = [...files.keys()].filter(name => !expected.includes(name));
    assert.ok(
        !missing.length && !unexpected.length,
        `${label} inventory mismatch; missing: ${missing.join(", ")}; unexpected: ${unexpected.join(", ")}`,
    );
}

function json(bytes, label) {
    assert.ok(Buffer.isBuffer(bytes), `Missing ${label}`);
    let value;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    } catch {
        throw new Error(`Invalid JSON: ${label}`);
    }
    assert.ok(value && typeof value === "object" && !Array.isArray(value), `Invalid JSON object: ${label}`);
    return value;
}

export function imageTargets(text) {
    // The owned READMEs use Markdown, not arbitrary embedded HTML. Ignore illustrative code samples.
    const markdown = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, "");
    const targets = [...markdown.matchAll(/!\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)]
        .map(match => match[1] ?? match[2]);
    const label = value => value.trim().replace(/\s+/g, " ").toLowerCase();
    const definitions = new Map([...markdown.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>\n]+)>|([^\s]+))/gm)]
        .map(match => [label(match[1]), match[2] ?? match[3]]));
    for (const match of markdown.matchAll(/!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
        const target = definitions.get(label(match[2] || match[1]));
        if (match[2] !== undefined) assert.ok(target, "Missing README image reference definition");
        if (target) targets.push(target);
    }
    return targets;
}

export function validateReadmeImages(files, readmes) {
    for (const name of readmes) {
        for (const target of imageTargets(files.get(name).toString("utf8"))) {
            if (/^(?:https?:\/\/|\/\/|#)/i.test(target)) continue;
            let decoded;
            try {
                decoded = decodeURIComponent(target.split(/[?#]/)[0]);
            } catch {
                throw new Error(`Invalid README image reference: ${name}`);
            }
            assert.ok(
                !decoded.startsWith("/") && !decoded.includes("\\") && !/^[a-z][a-z0-9+.-]*:/i.test(decoded),
                `Invalid local README image path: ${name}`,
            );
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), decoded));
            assert.ok(files.has(resolved), `Missing packaged README image: ${name}`);
        }
    }
}

export function validateDistribution(
    {archive, dist, source, contract = PACKAGE_FILES, releaseTag, privacyCheck = privacyIssues},
) {
    const files = zipFiles(archive);
    const expected = Object.keys(contract).sort();
    inventory(files, expected, "ZIP");
    inventory(dist, expected, "dist");
    const pkg = json(source.get("package.json"), "source package.json");
    const manifests = [
        ["source", json(source.get("plugin.json"), "source plugin.json")],
        ["dist", json(dist.get("plugin.json"), "dist plugin.json")],
        ["ZIP", json(files.get("plugin.json"), "ZIP plugin.json")],
    ];
    assert.match(pkg.version ?? "", /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid project version");
    for (const [label, manifest] of manifests) {
        assert.equal(manifest.version, pkg.version, `${label} plugin.json version mismatch`);
    }
    if (releaseTag !== undefined) {
        assert.match(releaseTag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, "Invalid release tag; expected vX.Y.Z");
        assert.equal(releaseTag.slice(1), pkg.version, "Release tag/version mismatch");
    }
    for (const [name, canonical] of Object.entries(contract)) {
        assert.ok(files.get(name).equals(dist.get(name)), `dist/ZIP bytes differ: ${name}`);
        if (canonical !== null) {
            assert.ok(Buffer.isBuffer(source.get(canonical)), `Missing canonical source: ${canonical}`);
            assert.ok(files.get(name).equals(source.get(canonical)), `Canonical asset bytes differ: ${name}`);
        }
    }
    const manifest = manifests[2][1];
    assert.ok(
        manifest.readme && typeof manifest.readme === "object" && !Array.isArray(manifest.readme),
        "Missing README mappings",
    );
    assert.ok(manifest.readme.default && manifest.readme.de, "Default and German README mappings are required");
    assert.deepEqual(manifest.readme, README_MAPPINGS, "README mappings must select the short English/German files");
    for (const name of Object.values(manifest.readme)) {
        assert.ok(typeof name === "string" && files.has(name), "Declared README missing or filename case differs");
    }
    const readmes = expected.filter(name => /(?:^|\/)README[^/]*\.md$/.test(name));
    validateReadmeImages(files, readmes);
    assert.ok(
        files.get("icon.png").subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
        "Invalid icon PNG signature",
    );
    for (const [name, bytes] of files) {
        const filenameIssues = privacyCheck(name);
        assert.equal(filenameIssues.length, 0, `Packaged filename privacy failure: ${name}`);
        if (/\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?)$/i.test(name)) continue;
        const issues = privacyCheck(bytes.toString("utf8"));
        assert.equal(issues.length, 0, `Packaged text privacy failure: ${name}: ${issues.join(", ")}`);
    }
    assert.deepEqual(readmes.sort(), Object.keys(README_IMAGES).sort(), "Expected exactly four public README files");
    for (const [name, images] of Object.entries(README_IMAGES)) {
        assert.deepEqual(
            imageTargets(files.get(name).toString("utf8")),
            images,
            `README screenshot roles differ: ${name}`,
        );
    }
    for (const name of fullImages) validateScreenshotPng(files.get(name), name);
    return {inventory: expected, version: pkg.version};
}

export function validatePackage({sourceRoot, outputRoot = sourceRoot, releaseTag}) {
    const zip = path.join(outputRoot, "package.zip");
    const directory = path.join(outputRoot, "dist");
    assert.ok(existsSync(zip), "Production package.zip is missing; run the production build first");
    assert.ok(existsSync(directory), "Production dist is missing");
    const dist = new Map();
    function readDirectory(relative = "") {
        for (const entry of readdirSync(path.join(directory, relative), {withFileTypes: true})) {
            const name = relative ? `${relative}/${entry.name}` : entry.name;
            assert.ok(entry.isFile() || entry.isDirectory(), "Non-regular dist entry");
            if (entry.isDirectory()) {
                assert.ok(
                    Object.keys(PACKAGE_FILES).some(file => file.startsWith(`${name}/`)),
                    "Unexpected dist directory",
                );
                readDirectory(name);
            } else dist.set(name, readFileSync(path.join(directory, name)));
        }
    }
    readDirectory();
    const canonical = new Set(["package.json", ...Object.values(PACKAGE_FILES).filter(name => name !== null)]);
    const source = new Map([...canonical].map(name => [name, readFileSync(path.join(sourceRoot, name))]));
    return validateDistribution({archive: readFileSync(zip), dist, source, releaseTag});
}
