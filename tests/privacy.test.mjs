import assert from "node:assert/strict";
import {
    existsSync,
    readFileSync,
    readdirSync,
} from "node:fs";
import test from "node:test";
import {validateScreenshotPng} from "./package-contract.mjs";
import {
    publicPathIssues,
    sourcePrivacyIssues,
} from "./privacy-helpers.mjs";

const root = new URL("../", import.meta.url);
const development = existsSync(new URL("public-assets/", root));
// Public build/source candidates; exporter tools and demo-only checks stay in DEVELOPMENT.
const rootCandidates = [
    ".gitignore",
    "LICENSE",
    "README.md",
    "README.de-DE.md",
    "README.siyuan.md",
    "README.siyuan.de-DE.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "plugin.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "eslint.config.mjs",
    "dprint.json",
    "webpack.config.js",
    "icon.png",
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
];
const rejectedLocalImage = ["file:", "", "", "tmp", "example-project", "image.png"].join("/");

function lineIssues(file, line) {
    return sourcePrivacyIssues(file, line);
}

function tree(directory) {
    return readdirSync(new URL(`${directory}/`, root), {withFileTypes: true}).flatMap(entry => {
        // Existing ignored OS files in DEVELOPMENT are not export candidates; PUBLIC rejects them.
        if (development && entry.name === ".DS_Store") return [];
        const name = `${directory}/${entry.name}`;
        assert.ok(entry.isFile() || entry.isDirectory(), `Non-regular public candidate: ${name}`);
        return entry.isDirectory() ? tree(name) : [name];
    });
}

test("current public candidates contain no generic environment or credential markers", () => {
    const issues = [];
    for (
        const file of [
            ...rootCandidates,
            ...tree("src"),
            ...tree("tests"),
            ...tree(existsSync(new URL("public-assets/", root)) ? "public-assets" : "docs/screenshots"),
        ]
    ) {
        for (const issue of lineIssues(file, file)) issues.push(`${file}: filename: ${issue}`);
        // Approved screenshots get structural/metadata checks instead of decoding binary bytes as text.
        if (/^(?:public-assets|docs)\/screenshots\/.+\.png$/.test(file)) {
            validateScreenshotPng(readFileSync(new URL(file, root)), file);
            continue;
        }
        // These binary PNG assets are excluded from the textual privacy scan.
        if (file === "icon.png" || file === "public-assets/demo/small-study.png") continue;
        const lines = readFileSync(new URL(file, root), "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
            for (const issue of lineIssues(file, line)) issues.push(`${file}:${index + 1}: ${issue}`);
        });
    }
    assert.deepEqual(issues, []); // Locations/categories only, never print suspect content.
});

test("privacy guards detect synthetic leaks and permit only the exact negative file-URL fixture", () => {
    const samples = [
        ["", "Users", "test-user", "project"].join("/"),
        ["", "home", "test-user", "project"].join("/"),
        ["C:", "Users", "test-user", "project"].join("\\"),
        rejectedLocalImage,
        "192.168." + "0.1",
        "https:" + "//test-user:synthetic-password@example.org/",
        "https://example.org/?" + "token=synthetic-value",
        ["-----BEGIN", "PRIVATE KEY-----"].join(" "),
        "ghp_" + "x".repeat(24),
        "token" + '="synthetic-value-for-testing"',
    ];
    for (const sample of samples) assert.ok(lineIssues("example.txt", sample).length > 0);
    const fixture = `${JSON.stringify(rejectedLocalImage)},`;
    assert.deepEqual(lineIssues("tests/foundation.test.mjs", fixture), []);
    assert.ok(lineIssues("example.txt", fixture).length > 0);
    assert.ok(lineIssues("tests/foundation.test.mjs", `${fixture} // additional content`).length > 0);
    assert.ok(lineIssues("tests/foundation.test.mjs", fixture.replace("image.png", "other.png")).length > 0);
});

test("generic path hygiene rejects local artifacts and permits public source/workflows", () => {
    for (
        const name of [
            ".env",
            ".env.local",
            ".npmrc",
            ".DS_Store",
            "node_modules/a.js",
            "dist/index.js",
            "build/a.js",
            "dev-evidence/capture.png",
            "tools/private.mjs",
            "tasks/status.md",
            "backup.bak",
            "debug.log",
            "package.zip",
        ]
    ) {
        assert.ok(publicPathIssues(name).length > 0);
    }
    for (const name of ["src/index.ts", "src/i18n/en.json", "THIRD_PARTY_NOTICES.md", ".github/workflows/ci.yml"]) {
        assert.deepEqual(publicPathIssues(name), []);
    }
});

test("public metadata and MIT notices retain separate project and third-party identities", () => {
    const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
    const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
    assert.equal(manifest.author, "blacknet76");
    assert.equal(manifest.url, "https://github.com/blacknet76/siyuan-child-gallery");
    assert.equal(pkg.author, "blacknet76");
    assert.equal(pkg.repository.url, `${manifest.url}.git`);
    const license = readFileSync(new URL("LICENSE", root), "utf8");
    assert.deepEqual(license.match(/^Copyright .+$/gm), ["Copyright (c) 2026 blacknet76"]);
    const notices = readFileSync(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");
    for (
        const attribution of [
            "Copyright (c) 2023 SiYuan 思源笔记",
            "Copyright JS Foundation and other contributors",
            "Copyright (c) 2020 Evan Wallace",
        ]
    ) assert.ok(notices.includes(attribution));
    assert.ok(notices.includes("Permission is hereby granted, free of charge"));
});
