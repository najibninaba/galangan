// The shell over a real file-backed SQLite store, the example harness and the faux model (no network).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { Effect } from "effect";
import { tallyHarness } from "../examples/tally/tally.ts";
import { chooseModel, chooseThinking, fauxModels, FAUX_MODEL, InvalidModel } from "../src/models.ts";
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
