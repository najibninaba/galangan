// tally over a real temporary SQLite store and the faux model, through Galangan's public entries only: the test a
// harness repo copies along with its harness. `conformance` adds the shell's durability cases for this harness.
import assert from "node:assert/strict";
import { it } from "node:test";
import { Effect } from "effect";
import { Shell } from "galangan";
import { conformance, fauxModels, FAUX_MODEL, tempStore } from "galangan/testing";
import { tallyHarness } from "./tally.ts";

const ask = (store: string, message: string, create = false) => Effect.runPromise(Effect.provide(
	Shell.use((shell) => shell.ask(message)),
	Shell.layer({ harness: tallyHarness, choice: { models: fauxModels(), model: FAUX_MODEL }, store, create }),
));

it("counts per label and keeps counts across a reopen", async (t) => {
	const store = tempStore(t);
	assert.equal(await ask(store, 'call tally {"label":"cups"}', true), "tally: cups = 1");
	assert.equal(await ask(store, 'call tally {"label":"plates"}'), "tally: plates = 1");
	assert.equal(await ask(store, 'call tally {"label":"cups"}'), "tally: cups = 2");
});

// `CONFORMANCE_FROM=<store backup> npm test` runs the cases on copies of that backup before an upgrade.
conformance(tallyHarness, { from: process.env.CONFORMANCE_FROM });
