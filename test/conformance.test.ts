// The conformance suite on a copy of an existing store, as a harness upgrade runs it against production's
// (docs/pin-and-release-policy.md): every case must pass there too, and the source store must stay untouched.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { Effect } from "effect";
import { tallyHarness } from "../examples/tally/tally.ts";
import { Shell } from "../src/shell.ts";
import { conformance, fauxModels, FAUX_MODEL } from "../src/testing.ts";

const dir = mkdtempSync(join(tmpdir(), "galangan-"));
const from = join(dir, "production.sqlite");
// History the copy starts with: a root conversation that already exists, with tally state.
const choice = { models: fauxModels(), model: FAUX_MODEL };
await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask('call tally {"label":"cups"}')),
	Shell.layer({ harness: tallyHarness, choice, store: from, create: true })));
const before = readFileSync(from);
// Hooks run in order: compare first, then clean up.
after(() => assert.deepEqual(readFileSync(from), before));
after(() => rmSync(dir, { recursive: true, force: true }));

conformance(tallyHarness, { from });
