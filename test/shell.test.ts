// The shell over a real file-backed SQLite store, the example harness and the faux model (no network).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { defineExtension } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { tallyHarness } from "../examples/tally/tally.ts";
import { chooseModel, chooseThinking, fauxModels, FAUX_MODEL, InvalidModel } from "../src/models.ts";
import { Shell, StoreBackupFailed, StoreIncompatible, StoreLocked, StoreMissing, WRITER } from "../src/shell.ts";

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

	it("applies model and effort changes to an existing root before its next generation", async (t) => {
		const store = tempStore(t);
		await withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}')), true);
		const faux = fauxProvider({ models: [{ id: "replacement", reasoning: true }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([(context, options, _state, model) => {
			assert.equal(model.id, "replacement");
			assert.equal(options?.reasoning, "high");
			assert.ok(context.messages.some((message) => message.role === "toolResult"));
			return fauxAssistantMessage("new model, preserved history");
		}]);
		await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("hello again")), Shell.layer({
			harness: tallyHarness, store,
			choice: { models, model: { provider: "faux", modelId: "replacement" }, thinkingLevel: "high" },
		})));
		// Changing effort alone must also replace the persisted value, not just print a new banner.
		faux.setResponses([(_context, options) => {
			assert.equal(options?.reasoning, "low");
			return fauxAssistantMessage("lower effort");
		}]);
		const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("one more")), Shell.layer({
			harness: tallyHarness, store,
			choice: { models, model: { provider: "faux", modelId: "replacement" }, thinkingLevel: "low" },
		})));
		assert.equal(answer, "lower effort");
	});
});

/** Runs `sql` on a closed store, as an older or newer build would have left it. */
const tamper = (store: string, sql: string) => {
	const db = new DatabaseSync(store);
	db.exec(sql);
	db.close();
};
const read = (store: string, sql: string) => {
	const db = new DatabaseSync(store, { readOnly: true });
	const row = db.prepare(sql).get();
	db.close();
	return row;
};
const backups = (store: string) => readdirSync(dirname(store)).filter((file) => file.endsWith(".bak"));
const tally = (store: string) => withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}')));

describe("store stamp", () => {
	it("stamps the version in package.json and the installed Pi", () => {
		const pkg = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;
		assert.deepEqual(WRITER, {
			galangan: pkg("../package.json"),
			pi: pkg("../node_modules/@earendil-works/pi-durable/package.json"),
		});
	});

	it("records the writer and every extension's format on a new store, and backs up nothing", async (t) => {
		const store = tempStore(t);
		await withShell(store, Effect.void, true);
		assert.equal(await tally(store), "tally: cups = 1");
		assert.deepEqual({ ...read(store, "SELECT galangan, pi, formats FROM galangan_store") },
			{ ...WRITER, formats: '{"tally":0}' });
		assert.deepEqual(backups(store), []);
	});

	it("refuses a store from a newer or unreadable writer or a newer schema, and leaves it alone", async (t) => {
		const [major, minor, patch = 0] = WRITER.galangan.split(".").map(Number);
		const nextRc = `${major}.${minor}.${patch + 1}-rc.1`;
		const cases = [
			["UPDATE galangan_store SET galangan = '0.10.0'", /written by Galangan 0\.10\.0 on Pi .*, newer than this/],
			["UPDATE galangan_store SET pi = '1.15.0'", /on Pi 1\.15\.0 \(schema 2\), newer than this/],
			// A pre-release of the next patch is still newer than this release.
			[`UPDATE galangan_store SET galangan = '${nextRc}'`, /-rc\.1 on Pi .*newer/],
			["DROP TABLE galangan_store; UPDATE durable_schema SET version = 3", /unstamped writer \(schema 3\), newer/],
			["UPDATE galangan_store SET galangan = 'v9'", /has a stamp this Galangan .* cannot read \(Galangan v9/],
			["UPDATE galangan_store SET formats = 'null'", /cannot read .*formats null/],
		] as const;
		for (const [sql, written] of cases) {
			const store = tempStore(t);
			await withShell(store, Effect.void, true);
			tamper(store, sql);
			const before = readFileSync(store);
			const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
			assert.ok(error instanceof StoreIncompatible, sql);
			assert.match(error.message, written);
			const self = `this Galangan ${WRITER.galangan} on Pi ${WRITER.pi} \\(schema 2\\)`;
			assert.match(error.message, new RegExp(self));
			assert.deepEqual(readFileSync(store), before, sql);
			assert.deepEqual(backups(store), [], sql);
		}
	});

	it("backs up a store before an open that migrates its schema or restamps an older writer", async (t) => {
		const rc = `${WRITER.galangan}-rc.1`;
		const cases = [
			["UPDATE durable_schema SET version = 1", { version: 1, galangan: WRITER.galangan }],
			["UPDATE galangan_store SET galangan = '0.0.9'", { version: 2, galangan: "0.0.9" }],
			// A pre-release sorts below its release, so the release upgrades it.
			[`UPDATE galangan_store SET galangan = '${rc}'`, { version: 2, galangan: rc }],
		] as const;
		for (const [sql, was] of cases) {
			const store = tempStore(t);
			await withShell(store, Effect.void, true);
			assert.equal(await tally(store), "tally: cups = 1");
			tamper(store, sql);
			assert.equal(await tally(store), "tally: cups = 2", sql);
			const [backup, ...more] = backups(store);
			assert.ok(backup !== undefined && more.length === 0, sql);
			assert.match(backup, /^tally\.sqlite\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z\.bak$/);
			// The copy is the store as it was before this open: the old schema or stamp, and the count before it.
			const copy = join(dirname(store), backup);
			assert.deepEqual({ ...read(copy, "SELECT version, galangan FROM durable_schema, galangan_store") }, was);
			const restored = tempStore(t);
			mkdirSync(dirname(restored));
			copyFileSync(copy, restored);
			assert.equal(await tally(restored), "tally: cups = 2", sql);
			assert.deepEqual({ ...read(store, "SELECT version, galangan FROM durable_schema, galangan_store") },
				{ version: 2, galangan: WRITER.galangan });
			// Upgraded now, so the next open backs up nothing more.
			assert.equal(await tally(store), "tally: cups = 3");
			assert.equal(backups(store).length, 1);
		}
	});

	it("refuses to upgrade a store it could not back up, and leaves no partial copy", async (t) => {
		const store = tempStore(t);
		await withShell(store, Effect.void, true);
		assert.equal(await tally(store), "tally: cups = 1");
		tamper(store, "UPDATE galangan_store SET galangan = '0.0.9'");
		const before = readFileSync(store);
		// Pin the backup's timestamp and put a non-empty directory where it goes, so the copy cannot be moved there.
		const now = "2026-01-02T03:04:05.678Z";
		const backup = `${store}.2026-01-02T03-04-05.678Z.bak`;
		mkdirSync(join(backup, "taken"), { recursive: true });
		const clock = t.mock.method(Date.prototype, "toISOString", () => now);
		const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
		clock.mock.restore();
		assert.ok(error instanceof StoreBackupFailed);
		assert.equal(error.backup, backup);
		assert.deepEqual(readFileSync(store), before);
		assert.deepEqual(readdirSync(dirname(store)).filter((file) => file.endsWith(".tmp")), []);
		// Nothing was retried or half-done: with the way clear, the next open backs up once and upgrades.
		rmSync(backup, { recursive: true });
		assert.equal(await tally(store), "tally: cups = 2");
		assert.equal(backups(store).length, 1);
	});

	it("refuses a store written with another kit format, naming both and the wipe step", async (t) => {
		const extra = defineExtension({ name: "extra" });
		/** Opens and closes `store`, returning the error when the open fails. */
		const open = (store: string, formats?: { readonly [extension: string]: number }, extensions = [extra]) =>
			Effect.runPromise(Effect.match(Effect.provide(Effect.void, Shell.layer({
				harness: { ...tallyHarness, extensions: [...tallyHarness.extensions, ...extensions], formats },
				choice: { models: fauxModels(), model: FAUX_MODEL },
				store,
				create: true,
			})), { onSuccess: () => undefined, onFailure: (error) => error }));
		const refused = async (store: string, formats: { readonly [extension: string]: number } | undefined, was: number,
			now: number) => {
			const before = readFileSync(store);
			const error = await open(store, formats);
			assert.ok(error instanceof StoreIncompatible, JSON.stringify(formats));
			assert.match(error.message, new RegExp(`has tally format ${was}, and this build uses tally format ${now}, `
				+ "which does not migrate; .*--init"));
			assert.deepEqual(readFileSync(store), before);
			assert.deepEqual(backups(store), []);
		};

		const store = tempStore(t);
		assert.equal(await open(store, { tally: 1 }, []), undefined);
		await refused(store, { tally: 2 }, 1, 2);
		// Dropping the declaration is a format change too (back to 0), not a way around the check.
		await refused(store, undefined, 1, 0);
		// An extension new to the store has written nothing, so it may start at any format.
		assert.equal(await open(store, { tally: 1, extra: 3 }), undefined);
		assert.deepEqual({ ...read(store, "SELECT formats FROM galangan_store") }, { formats: '{"tally":1,"extra":3}' });

		// A store whose extension wrote before it declared a format has format 0 on record, so declaring one later is
		// refused rather than reading the old docs as empty. So is a store from before stamps.
		const undeclared = tempStore(t);
		await withShell(undeclared, Effect.void, true);
		await refused(undeclared, { tally: 2 }, 0, 2);
		tamper(undeclared, "DROP TABLE galangan_store");
		await refused(undeclared, { tally: 2 }, 0, 2);
	});
});

describe("chooseModel", () => {
	it("defaults to the faux model", async () => {
		assert.deepEqual((await Effect.runPromise(chooseModel())).model, FAUX_MODEL);
	});

	it("defaults to supported effort and identifies the source of explicitly unsupported levels", async () => {
		const faux = fauxProvider({ models: [{ id: "reasoner", reasoning: true }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const choice = { models, model: { provider: "faux", modelId: "reasoner" } };
		assert.equal(await Effect.runPromise(chooseThinking(choice)), "medium");
		assert.equal(await Effect.runPromise(chooseThinking(choice, "high")), "high");
		for (const level of ["xhigh", "typo", ""]) {
			const error = await Effect.runPromise(Effect.flip(chooseThinking(choice, level)));
			assert.ok(error instanceof InvalidModel);
			assert.match(error.message, /GALANGAN_THINKING/);
		}
		const error = await Effect.runPromise(Effect.flip(chooseThinking({ ...choice, thinkingLevel: "xhigh" })));
		assert.match(error.message, /choice.thinkingLevel/);
		assert.doesNotMatch(error.message, /GALANGAN_THINKING/);
		assert.ok(await Effect.runPromise(Effect.flip(chooseModel("faux", "medium"))) instanceof InvalidModel);
		// Catalog-only validation: no authentication or network. Sol cannot run with Pi's old default of off.
		models.setProvider(openaiProvider());
		const sol = { models, model: { provider: "openai", modelId: "gpt-6.1-sol" } };
		assert.ok(await Effect.runPromise(Effect.flip(chooseThinking(sol, "off"))) instanceof InvalidModel);
		assert.equal(await Effect.runPromise(chooseThinking(sol, "high")), "high");
		// Includes off/high/max and high-only reasoners; medium must never be an implicit configuration error.
		const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
		for (const provider of builtinProviders()) {
			models.setProvider(provider);
			for (const model of provider.getModels()) {
				const choice = { models, model: { provider: provider.id, modelId: model.id } };
				const selected = await Effect.runPromise(chooseThinking(choice));
				assert.ok(getSupportedThinkingLevels(model).includes(selected),
					`${provider.id}/${model.id}: ${selected}`);
			}
		}
	});

	it("refuses a spec without a provider and model", async () => {
		for (const spec of ["claude", "/m", "anthropic/"]) {
			const error = await Effect.runPromise(Effect.flip(chooseModel(spec)));
			assert.ok(error instanceof InvalidModel, spec);
		}
	});
});
