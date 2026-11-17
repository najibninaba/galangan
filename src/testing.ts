// Galangan's test entry (`import ... from "galangan/testing"`): the offline faux model, a temporary store, and the
// conformance suite, so a harness's tests run over real file-backed SQLite with no network or keys, as Galangan's own
// tests do.
//
// `conformance(spec)` is the release promise of durability as tests any harness runs against its own spec. It adds a
// probe extension (`galangan.conformance`) to the harness's own extensions, so the cases run through the harness's
// hooks, sections and formats as deployed, but need no prompt that makes the harness's own tools do something. When a
// harness finds a way to lose durability, the fix lands here as a case, and every harness runs it on its next bump.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import type { HarnessSpec } from "./harness.ts";
import { fauxModels, FAUX_MODEL } from "./models.ts";
import { Shell, synchronous } from "./shell.ts";

export { fauxAnswer, fauxModels, FAUX_MODEL } from "./models.ts";

/** A store path in a fresh temporary directory that is removed after the test. The file itself does not exist yet. */
export function tempStore(t: TestContext, file = "store.sqlite"): string {
	const dir = mkdtempSync(join(tmpdir(), "galangan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, file);
}

export type ConformanceOptions = {
	/**
	 * A store with history to start every case from, such as the backup of production's taken before an upgrade
	 * (docs/pin-and-release-policy.md). No process may hold it: a store copied while it is written can be torn. Each
	 * case runs on its own copy of the file and its WAL; this file is never opened. Default: a new store.
	 */
	readonly from?: string;
};

/** Probe counts by key, in the root conversation, as a harness keeps durable state. */
const Probes = defineDoc<{ counts: Record<string, number> }>({
	kind: "galangan.conformance.probes",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ counts: {} }),
	checkpointWhen: () => true,
});

/**
 * Registers node:test cases (in a `describe` named after the harness) that check the shell's durability promise for
 * `spec`: committed state survives a close and reopen, every commit is written with `synchronous = FULL`, a repeated
 * request ID is one input even after a reopen, and a non-replay-safe tool cut off mid-call returns `interrupted` and
 * is not run again. Call it once at the top level of a test file: `conformance(myHarness)`.
 */
export function conformance(spec: HarnessSpec, options: ConformanceOptions = {}): void {
	// Test coordination only, not durable state: the hang tool tells its case it is running.
	let started = () => {};
	const count = (key: string, api: ToolExecutionApi, context: Context) =>
		api.commit(async (tx) => {
			const doc = await tx.doc(Probes, api.conversationId);
			doc.counts[key] = (doc.counts[key] ?? 0) + 1;
			return doc.counts[key];
		}, context);
	const probe = defineExtension({
		name: "galangan.conformance",
		tools: [
			defineTool({
				name: "galangan_probe",
				description: "Conformance probe: add one to the counter `key` and return its new value.",
				parameters: obj({ key: str() }),
				execute: async (args, api, context) =>
					({ output: [{ type: "text", text: `${args.key} = ${await count(args.key, api, context)}` }] }),
			}),
			defineTool({
				name: "galangan_probe_hang",
				description: "Conformance probe: add one to the counter `hang`, then wait until the call is cut off.",
				parameters: obj({}),
				// Not replay-safe (Pi's default), like any tool whose effect must not happen twice.
				execute: async (_args, api, context) => {
					// A second run is the failure under test: answer at once so the case fails now, not at its timeout.
					if (await count("hang", api, context) > 1) return { output: [{ type: "text", text: "ran again" }] };
					started();
					await new Promise((_, reject) => context.abortSignal?.addEventListener("abort",
						() => reject(new Error("cut off")), { once: true }));
					return { output: [{ type: "text", text: "not cut off" }] };
				},
			}),
		],
	});
	const harness: HarnessSpec = { ...spec, extensions: [...spec.extensions, probe] };

	/** This case's store: a copy of `options.from`, or a path for a new one. */
	const store = (t: TestContext) => {
		const path = tempStore(t, "conformance.sqlite");
		if (options.from !== undefined) {
			copyFileSync(options.from, path);
			if (existsSync(`${options.from}-wal`)) copyFileSync(`${options.from}-wal`, `${path}-wal`);
		}
		return path;
	};
	/** Opens the shell on `path`, runs `program`, and closes it again. */
	const withShell = <A, E>(path: string, program: Effect.Effect<A, E, Shell>) =>
		Effect.runPromise(Effect.provide(program, Shell.layer({
			harness,
			choice: { models: fauxModels(), model: FAUX_MODEL },
			store: path,
			create: !existsSync(path),
		})));
	const ask = (path: string, ...messages: (readonly [string, string?])[]) =>
		withShell(path, Effect.gen(function* () {
			const shell = yield* Shell;
			const answers = [];
			for (const [message, requestId] of messages) {
				answers.push(yield* shell.ask(message, requestId === undefined ? {} : { requestId }));
			}
			return answers;
		}));
	const call = (key: string) => `call galangan_probe {"key":"${key}"}`;

	describe(`galangan conformance: ${spec.name}`, () => {
		if (options.from !== undefined) {
			it("starts each case from the history in the store it was given", async (t) => {
				const entries = await withShell(store(t), Shell.use((shell) => Effect.promise(async () => {
					const root = await shell.harness.root(BACKGROUND_CONTEXT);
					return (await root.context(BACKGROUND_CONTEXT)).entries.length;
				})));
				assert.ok(entries > 0, `the root conversation of ${options.from} has no history`);
			});
		}

		it("keeps committed tool state across a close and reopen", async (t) => {
			const path = store(t);
			const [one, two] = ["galangan_probe: a = 1", "galangan_probe: a = 2"];
			assert.deepEqual(await ask(path, [call("a")], [call("a")]), [one, two]);
			assert.deepEqual(await ask(path, [call("a")]), ["galangan_probe: a = 3"]);
		});

		it("writes every commit with synchronous = FULL", async (t) => {
			// NORMAL (Pi's default) can lose the newest commits on power loss.
			const level = Shell.use((shell) => Effect.promise(() => synchronous(shell.harness)));
			assert.equal(await withShell(store(t), level), 2);
		});

		it("answers a repeated request ID once, also after a reopen", async (t) => {
			const path = store(t);
			const once = "galangan_probe: r = 1";
			assert.deepEqual(await ask(path, [call("r"), "conformance:1"], [call("r"), "conformance:1"],
				[call("r"), "conformance:2"]), [once, once, "galangan_probe: r = 2"]);
			const reopened = await ask(path, [call("r"), "conformance:1"], [call("r")]);
			assert.deepEqual(reopened, [once, "galangan_probe: r = 3"]);
		});

		// A hang here means the probe call never started or the close never cut it off.
		it("gives a non-replay-safe tool cut off mid-call an interrupted result and does not run it again",
			{ timeout: 60_000 }, async (t) => {
				const path = store(t);
				const running = new Promise<void>((accept) => { started = accept; });
				const hang = ["call galangan_probe_hang", "conformance:hang"] as const;
				await withShell(path, Effect.gen(function* () {
					yield* Effect.forkChild((yield* Shell).ask(hang[0], { requestId: hang[1] }));
					// Closing the shell now cuts the call off. A stop, not a crash: no restart is counted, but Pi
					// recovers the call through the same path (`npm run smoke:recovery` covers a real SIGKILL).
					yield* Effect.promise(() => running);
				}));
				const [answer, after] = await ask(path, [hang[0], hang[1]], [call("hang")]);
				assert.match(answer!, /^galangan_probe_hang failed: .*was interrupted/s);
				// The counter the cut-off call raised once, and nothing since.
				assert.equal(after, "galangan_probe: hang = 2");
			});
	});
}
