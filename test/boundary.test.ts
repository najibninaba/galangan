// Examples use the same public entries as standalone harnesses. package.json `exports` blocks "galangan/src/...";
// a relative path into src/ would not be.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { it } from "node:test";

const root = join(import.meta.dirname, "..");
// Static, side-effect, re-export and dynamic imports, in either quote style.
const SPECIFIER = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g;

it("keeps examples off Galangan's internals", () => {
	const examples = join(root, "examples");
	const files = readdirSync(examples, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
	const publicExports = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).exports;
	assert.ok(files.length > 0);
	for (const file of files) {
		const path = join(examples, file);
		for (const [, specifier = ""] of readFileSync(path, "utf8").matchAll(SPECIFIER)) {
			const outside = specifier.startsWith(".") && relative(examples, resolve(path, "..", specifier)).startsWith("..");
			const deep = specifier.startsWith("galangan/") && !Object.hasOwn(publicExports, specifier.replace("galangan", "."));
			assert.ok(!outside && !deep, `${file} imports ${specifier}`);
		}
	}
});

// Tests import both ../src and "galangan" (through tally). Without the galangan-source condition the package name
// resolves to dist/, a second copy whose Shell and error classes fail `instanceof` against src's.
it("resolves galangan to the same src modules the tests import", async () => {
	assert.equal((await import("galangan")).Shell, (await import("../src/shell.ts")).Shell);
	assert.equal((await import("galangan/testing")).fauxModels, (await import("../src/models.ts")).fauxModels);
});
