// The shell over a real file-backed SQLite store, the example harness and the faux model (no network).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { Effect } from "effect";
import { tallyHarness } from "../src/harnesses/tally.ts";
import { chooseModel, fauxModels, FAUX_MODEL, InvalidModel } from "../src/models.ts";
import { Shell, StoreLocked, StoreMissing } from "../src/shell.ts";

function tempStore(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "galangan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "store", "tally.sqlite");
}

const layer = (store: string, create = false) =>
	Shell.layer({ harness: tallyHarness, choice: { models: fauxModels(), model: FAUX_MODEL }, store, create });

/** Opens the shell on `store`, runs `program`, and closes the Harness again. */
const withShell = <A, E>(store: string, program: Effect.Effect<A, E, Shell>, create = false) =>
	Effect.runPromise(Effect.provide(program, layer(store, create)));

describe("shell", () => {
	it("answers through the harness's tool and keeps its state across a reopen", async (t) => {
		const store = tempStore(t);
		const first = await withShell(store, Effect.gen(function* () {
			const shell = yield* Shell;
			return [
				yield* shell.ask("hello"),
				yield* shell.ask('call tally {"label":"cups"}'),
				yield* shell.ask('call tally {"label":"cups"}'),
				yield* shell.ask('call tally {"label":"plates"}'),
			];
		}), true);
		assert.deepEqual(first, ["ack: hello", "tally: cups = 1", "tally: cups = 2", "tally: plates = 1"]);

		const reopened = await withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}')));
		assert.equal(reopened, "tally: cups = 3");
	});

	it("treats a repeated request ID as one input", async (t) => {
		const store = tempStore(t);
		const answers = await withShell(store, Effect.gen(function* () {
			const shell = yield* Shell;
			const once = yield* shell.ask('call tally {"label":"cups"}', { requestId: "r-1" });
			const again = yield* shell.ask('call tally {"label":"cups"}', { requestId: "r-1" });
			const next = yield* shell.ask('call tally {"label":"cups"}', { requestId: "r-2" });
			return [once, again, next];
		}), true);
		assert.deepEqual(answers, ["tally: cups = 1", "tally: cups = 1", "tally: cups = 2"]);
	});

	it("refuses a missing store unless asked to create it, and creates nothing", async (t) => {
		const store = tempStore(t);
		const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
		assert.ok(error instanceof StoreMissing);
		assert.equal(error.store, store);
		assert.equal(existsSync(store), false);
	});

	it("refuses a second shell on an open store at once, and opens it again after the first closes", async (t) => {
		const store = tempStore(t);
		const second = await withShell(store, Effect.gen(function* () {
			yield* (yield* Shell).ask('call tally {"label":"cups"}');
			const started = Date.now();
			const error = yield* Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store)));
			return { error, ms: Date.now() - started };
		}), true);
		assert.ok(second.error instanceof StoreLocked);
		// chord's default busy timeout would make this about 5 s.
		assert.ok(second.ms < 1000, `refused after ${second.ms} ms`);
		assert.equal(await withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}'))), "tally: cups = 2");
	});
});

describe("chooseModel", () => {
	it("defaults to the faux model", async () => {
		assert.deepEqual((await Effect.runPromise(chooseModel())).model, FAUX_MODEL);
	});

	it("refuses a spec without a provider and model", async () => {
		for (const spec of ["claude", "/m", "anthropic/"]) {
			const error = await Effect.runPromise(Effect.flip(chooseModel(spec)));
			assert.ok(error instanceof InvalidModel, spec);
		}
	});
});
