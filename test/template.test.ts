// template/ is what a new harness repo copies (BIJAN-152). Its harness is examples/tally and its pins are this
// release's, so a release that changes either without the template hands new repos a stale start. Between releases
// `main` may move ahead of the tag the template pins, so the template only holds at release commits; the README
// says to copy it from the tag.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";

const root = join(import.meta.dirname, "..");
const json = (path: string) => JSON.parse(readFileSync(join(root, path), "utf8"));

it("starts the template from examples/tally as it is now", () => {
	const files = readdirSync(join(root, "examples/tally")).sort();
	assert.deepEqual(readdirSync(join(root, "template/src")).sort(), files);
	for (const file of files) {
		assert.equal(readFileSync(join(root, "template/src", file), "utf8"),
			readFileSync(join(root, "examples/tally", file), "utf8"), `template/src/${file} differs from examples/tally`);
	}
});

it("pins the template to this release's tag and exact peers", () => {
	const own = json("package.json");
	const template = json("template/package.json");
	const { galangan, ...peers } = template.dependencies;
	assert.equal(galangan, `git+https://ampcode.com/@najib/galangan.git#v${own.version}`);
	assert.deepEqual(peers, own.peerDependencies);
	for (const [name, version] of Object.entries(template.devDependencies)) {
		assert.equal(version, own.devDependencies[name], name);
	}
	assert.equal(template.engines.node, own.engines.node);
});

it("type-checks the template with Galangan's compiler options", () => {
	// customConditions points `galangan` at src/ inside this repo only; a harness repo resolves the built package.
	const { customConditions, ...own } = json("tsconfig.json").compilerOptions;
	assert.deepEqual(json("template/tsconfig.json").compilerOptions, own);
});
