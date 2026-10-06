import assert from "node:assert/strict";
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";
import webpack from "webpack";
import configure from "../webpack.config.js";

test("production configuration copies the required notice unchanged into dist", async t => {
    const directory = mkdtempSync(path.join(tmpdir(), "child-gallery-notices-"));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const entry = path.join(directory, "entry.js");
    writeFileSync(entry, "export default {};\n");
    const production = configure(undefined, {mode: "production"});
    // Exercise the real production copy configuration without rewriting repository build outputs.
    const compiler = webpack({
        ...production,
        context: fileURLToPath(new URL("../", import.meta.url)),
        entry: {fixture: entry},
        output: {...production.output, path: directory},
    });
    try {
        const stats = await new Promise((resolve, reject) => {
            compiler.run((error, result) => error ? reject(error) : resolve(result));
        });
        assert.equal(stats.hasErrors(), false, stats.toString({all: false, errors: true}));
        assert.deepEqual(
            readFileSync(path.join(directory, "dist/THIRD_PARTY_NOTICES.md")),
            readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url)),
        );
    } finally {
        await new Promise((resolve, reject) => {
            compiler.close(error => error ? reject(error) : resolve());
        });
    }
});
