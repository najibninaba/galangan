// The command line every harness gets: `runCli(harnesses)` is a harness repo's whole entry point, so the shell never
// imports a harness (examples/tally/main.ts is the reference caller). Given a message as arguments it answers that one;
// with none it reads one message per stdin line. `--init` creates the store; nothing else does, so a wrong
// GALANGAN_DATA is an error, not an empty store.
//
// Environment: GALANGAN_HARNESS (a name among `harnesses`; default the first), GALANGAN_MODEL (see src/models.ts;
// default the faux model), GALANGAN_THINKING (a supported thinking level; see src/models.ts), GALANGAN_DATA (store
// directory; default ~/.galangan from any directory), and every variable the harness names in `secrets`.
// Exit codes: 0 done, 1 failed (restart it), 75 store in use by another process, 78 bad configuration or a store this
// build must not open (needs a person),
// 130/143 stopped by SIGINT/SIGTERM after closing the Harness.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Effect } from "effect";
import type { HarnessSpec } from "./harness.ts";
import { chooseModel, InvalidModel } from "./models.ts";
import { missingSecrets } from "./secrets.ts";
import { Shell, StoreBackupFailed, StoreIncompatible, StoreLocked, StoreMissing } from "./shell.ts";

const EXIT_LOCKED = 75;
const EXIT_CONFIG = 78;

// SIGINT and SIGTERM interrupt the program, so the layer's scope closes the Harness (running work goes back to pending
// without counting a restart) before the process exits 128 + signal. A second signal gets Node's default: exit now.
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 } as const;
type StopSignal = keyof typeof SIGNAL_EXIT;

/**
 * Runs the CLI for one of `harnesses` and sets `process.exitCode`; the promise settles when the run is over. A
 * configuration error before the store opens, or a failed Harness, exits the process at once instead. The first
 * SIGINT or SIGTERM removes every listener for both signals, including the caller's, so a second one exits at once.
 */
export function runCli(harnesses: readonly HarnessSpec[]): Promise<void> {
	if (harnesses.length === 0) {
		console.error("galangan: runCli needs at least one harness");
		process.exit(EXIT_CONFIG);
	}
	const name = process.env.GALANGAN_HARNESS ?? harnesses[0]?.name;
	const harness = harnesses.find((candidate) => candidate.name === name);
	if (harness === undefined) {
		console.error(`galangan: unknown harness ${name}; this build has ${harnesses.map((h) => h.name).join(", ")}`);
		process.exit(EXIT_CONFIG);
	}
	// Before anything opens: a tool that finds its token missing would fail only when the model calls it.
	const missing = missingSecrets(harness, process.env);
	if (missing.length > 0) {
		console.error(`galangan: ${harness.name} needs ${missing.join(", ")} set in the environment`);
		process.exit(EXIT_CONFIG);
	}
	const init = process.argv[2] === "--init";
	if (init && process.argv.length > 3) {
		console.error(`galangan: --init takes no other arguments; got ${process.argv.slice(3).join(" ")}`);
		process.exit(EXIT_CONFIG);
	}

	const stop = new AbortController();
	let signalled: StopSignal | undefined;
	const onSignal = (signal: StopSignal) => {
		for (const name of Object.keys(SIGNAL_EXIT)) process.removeAllListeners(name);
		signalled = signal;
		console.error(`galangan: ${signal}, closing`);
		stop.abort();
	};
	for (const signal of Object.keys(SIGNAL_EXIT) as StopSignal[]) process.once(signal, onSignal);

	const run = Effect.gen(function* () {
		const shell = yield* Shell;
		shell.harness.closed.then((end) => {
			// A storage error ends the Harness; exit so a supervisor restarts the process instead of retrying the call.
			if (end.kind === "failed") {
				console.error(`galangan: harness failed: ${String(end.error)}`);
				process.exit(1);
			}
			if (signalled !== undefined) console.error("galangan: closed");
		});
		const message = process.argv.slice(2).join(" ");
		if (message !== "") return console.log(yield* shell.ask(message));
		console.error(`galangan: ${shell.name} on ${shell.model.provider}/${shell.model.modelId} (${shell.thinkingLevel}); one message per line`);
		// Closed with the scope, so an interrupted loop releases stdin and the process can exit.
		const readline = yield* Effect.acquireRelease(
			Effect.sync(() => createInterface({ input: process.stdin })),
			(readline) => Effect.sync(() => readline.close()),
		);
		const lines = readline[Symbol.asyncIterator]();
		for (;;) {
			const line = yield* Effect.promise(() => lines.next());
			if (line.done) return;
			if (line.value.trim() === "") continue;
			// One unanswered input (bad tool arguments, a model error) is that line's failure, not the session's.
			yield* shell.ask(line.value).pipe(
				Effect.match({
					onSuccess: (answer) => console.log(answer),
					onFailure: (error) => console.error(`galangan: ${error.message}`),
				}),
			);
		}
	});

	const program = Effect.gen(function* () {
		const choice = yield* chooseModel(process.env.GALANGAN_MODEL, process.env.GALANGAN_THINKING);
		const store = join(process.env.GALANGAN_DATA ?? join(homedir(), ".galangan"), `${harness.name}.sqlite`);
		// Opening an existing store resumes its unfinished runs, which --init must not start.
		if (init && statSync(store, { throwIfNoEntry: false })?.isFile()) {
			return console.error(`galangan: store already exists at ${resolve(store)}`);
		}
		const ready = Effect.sync(() => console.error(`galangan: store ready at ${resolve(store)}`));
		yield* Effect.provide(init ? ready : Effect.scoped(run), Shell.layer({ harness, choice, store, create: init }));
	});

	return Effect.runPromise(program, { signal: stop.signal }).then(
		() => {
			if (signalled !== undefined) process.exitCode = SIGNAL_EXIT[signalled];
		},
		(error: unknown) => {
			if (signalled !== undefined) return void (process.exitCode = SIGNAL_EXIT[signalled]);
			console.error(`galangan: ${error instanceof Error ? error.message : String(error)}`);
			if (error instanceof StoreMissing && error.notFile !== true) {
				// The default was ./data before ~/.galangan; point an upgrade at its history instead of at an empty --init.
				const legacy = resolve("data", `${harness.name}.sqlite`);
				console.error(process.env.GALANGAN_DATA === undefined && existsSync(legacy)
					? `galangan: found a store at ${legacy} (the old default); run with GALANGAN_DATA=${resolve("data")}`
					: "galangan: create it with --init, or point GALANGAN_DATA at the one you have");
			}
			process.exitCode = error instanceof StoreLocked
				? EXIT_LOCKED
				: error instanceof InvalidModel || error instanceof StoreMissing || error instanceof StoreIncompatible
						|| error instanceof StoreBackupFailed
					? EXIT_CONFIG
					: 1;
		},
	);
}
