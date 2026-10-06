import {
    mkdtempSync,
    rmSync,
} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {validatePackage} from "./package-contract.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
let temporary;
try {
    if (args.length > 1 || args.some(arg => arg !== "--build")) {
        throw new Error("Usage: validate-package.mjs [--build]");
    }
    let outputRoot = sourceRoot;
    if (args.includes("--build")) {
        temporary = mkdtempSync(path.join(tmpdir(), "child-gallery-package-"));
        outputRoot = temporary;
        // Existing configuration uses cwd for LICENSE/icon lookup; pin it to the canonical project.
        process.chdir(sourceRoot);
        const [{default: webpack}, {default: configure}] = await Promise.all([
            import("webpack"),
            import("../webpack.config.js"),
        ]);
        const production = configure(undefined, {mode: "production"});
        const compiler = webpack({
            ...production,
            context: sourceRoot,
            output: {...production.output, path: outputRoot},
        });
        try {
            const stats = await new Promise((resolve, reject) => {
                compiler.run((error, result) => error ? reject(error) : resolve(result));
            });
            if (!stats || stats.hasErrors()) {
                throw new Error(stats?.toString({all: false, errors: true}) ?? "Missing build result");
            }
            if (stats.hasWarnings()) process.stderr.write(stats.toString({all: false, warnings: true}) + "\n");
        } finally {
            await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve()));
        }
    }
    const result = validatePackage({sourceRoot, outputRoot, releaseTag: process.env.CHILD_GALLERY_RELEASE_TAG});
    process.stdout.write(
        `Package valid: ${result.inventory.length} files, version ${result.version}${
            temporary ? ", fresh isolated production build" : ""
        }.\n`,
    );
} catch (error) {
    process.stderr.write(`Package validation failed: ${error.message}\n`);
    process.exitCode = 1;
} finally {
    if (temporary) rmSync(temporary, {recursive: true, force: true});
}
