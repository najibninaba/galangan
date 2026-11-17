// CLI entry: `npm start -- "<message>"` answers one message; with no arguments it reads one message per stdin line.
//
// Environment: GALANGAN_HARNESS (a name from src/harnesses/index.ts; default the first), GALANGAN_MODEL (see
// src/models.ts; default the faux model), GALANGAN_DATA (store directory; default ./data).
// Exit codes: 0 done, 1 failed (restart it), 78 bad configuration (needs a person).
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect } from "effect";
import { harnesses } from "./harnesses/index.ts";
import { chooseModel, InvalidModel } from "./models.ts";
import { Shell } from "./shell.ts";

const EXIT_CONFIG = 78;

const run = Effect.gen(function* () {
	const shell = yield* Shell;
	// A storage error ends the Harness; exit so a supervisor restarts the process instead of retrying the call.
	shell.harness.closed.then((end) => {
		if (end.kind === "failed") {
			console.error(`galangan: harness failed: ${String(end.error)}`);
			process.exit(1);
		}
	});
	const message = process.argv.slice(2).join(" ");
	if (message !== "") return console.log(yield* shell.ask(message));
	console.error(`galangan: ${shell.name} on ${shell.model.provider}/${shell.model.modelId}; one message per line`);
	const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
	for (;;) {
		const line = yield* Effect.promise(() => lines.next());
		if (line.done) return;
		if (line.value.trim() !== "") console.log(yield* shell.ask(line.value));
	}
});

const name = process.env.GALANGAN_HARNESS ?? harnesses[0]!.name;
const harness = harnesses.find((candidate) => candidate.name === name);
if (harness === undefined) {
	console.error(`galangan: unknown harness ${name}; this build has ${harnesses.map((h) => h.name).join(", ")}`);
	process.exit(EXIT_CONFIG);
}

const program = Effect.gen(function* () {
	const choice = yield* chooseModel(process.env.GALANGAN_MODEL);
	const store = join(process.env.GALANGAN_DATA ?? "./data", `${harness.name}.sqlite`);
	yield* Effect.provide(run, Shell.layer({ harness, choice, store }));
});

Effect.runPromise(program).catch((error: unknown) => {
	console.error(`galangan: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = error instanceof InvalidModel ? EXIT_CONFIG : 1;
});
