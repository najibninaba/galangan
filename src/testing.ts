// Galangan's test entry (`import ... from "galangan/testing"`): the offline faux model, a temporary store, and the
// conformance suite, so a harness's tests run over real file-backed SQLite with no network or keys, as Galangan's own
// tests do.
//
// `conformance(spec)` is the release promise of durability as tests any harness runs against its own spec. It adds a
// probe extension (`galangan.conformance`) to the harness's own extensions, so the cases run through the harness's
// hooks, sections and formats as deployed, but need no prompt that makes the harness's own tools do something. When a
// harness finds a way to lose durability, the fix lands here as a case, and every harness runs it on its next bump.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { AssistantEntry, LiveDoc, defineDoc, defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
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
 * request ID is one input even after a reopen, a non-replay-safe tool cut off mid-call returns `interrupted` and
 * is not run again, and no secret's value reaches the store from a tool's result or error. The cases set the
 * harness's `secrets` to made-up values, so they need none of the real ones. Call it once at the top level of a test
 * file: `conformance(myHarness)`.
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
	// Made-up values for the harness's own secrets and one of the suite's, so the leak case runs for every harness.
	const prefixName = "GALANGAN_CONFORMANCE_PREFIX";
	const secrets = [...(spec.secrets ?? []), "GALANGAN_CONFORMANCE_SECRET", prefixName];
	const env = Object.fromEntries(secrets.map((name) => [name, `s${randomUUID().replaceAll("-", "")}`]));
	const firstValue = env[secrets[0]!]!;
	env[prefixName] = firstValue.slice(0, 12);
	const partial = firstValue.slice(0, -1);
	let progressReady: (() => void) | undefined;
	const leaky = defineExtension({
		name: "galangan.conformance.secrets",
		tools: [defineTool({
			name: "galangan_probe_secret",
			description: "Conformance probe: put every secret's value in the result, or in a thrown error when `how` " +
				"is \"throw\", as a careless tool might.",
			parameters: obj({ how: str() }),
			execute: async (args, api, context) => {
				const values = Object.values(env).join(" ");
				if (args.how === "partial") {
					api.output(`partial: ${partial}`);
					throw new Error("tool stopped");
				}
				if (args.how === "ordinary" || args.how === "returned-error") {
					api.output("listing files");
					return { isError: args.how === "returned-error" };
				}
				const progress = new TextEncoder().encode(`☕ ${values}`);
				// Split both the UTF-8 character and the first credential across chunks.
				api.output(progress.subarray(0, 1));
				api.output(progress.subarray(1, 8));
				api.output(progress.subarray(8));
				api.diagnostic({ severity: "info", code: values, message: values });
				await api.details({ sent: values }, context);
				if (args.how === "interrupt") {
					api.output(` partial: ${partial}`);
					await api.commit((tx) => tx.doc(LiveDoc, api.conversationId).then(() => undefined), context);
					progressReady?.();
					await new Promise((_, reject) => context.abortSignal?.addEventListener("abort",
						() => reject(new Error("interrupted")), { once: true }));
				}
				if (args.how === "throw") throw new Error(`request with ${values} failed`);
				return { output: [{ type: "text", text: `sent ${values}` }], details: { sent: values } };
			},
		})],
	});
	const harness: HarnessSpec = { ...spec, secrets, extensions: [...spec.extensions, probe, leaky] };

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
			env,
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

		it("redacts SQLite live progress before settlement and after interrupted reopen", { timeout: 60_000 }, async (t) => {
			const path = store(t);
			const ready = new Promise<void>((resolve) => { progressReady = resolve; });
			const inspect = () => {
				const files = [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file));
				for (const value of Object.values(env)) assert.ok(files.every((bytes) => !bytes.includes(value)));
				assert.ok(files.every((bytes) => !bytes.includes(partial)));
			};
			await withShell(path, Effect.gen(function* () {
				const shell = yield* Shell;
				const root = yield* Effect.promise(() => shell.harness.root(BACKGROUND_CONTEXT));
				// Choose the tool's extension explicitly to exercise it without a default hook selection.
				yield* Effect.promise(() => root.configure({ extensions: [leaky] }, BACKGROUND_CONTEXT));
				yield* Effect.forkChild(shell.ask('call galangan_probe_secret {"how":"interrupt"}',
					{ requestId: "secret-interrupt" }));
				yield* Effect.promise(() => ready);
				const live = yield* Effect.promise(() => shell.harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT));
				assert.ok(live?.tools?.some((tool) => tool.output?.includes(`☕ [secret ${secrets[0]}]`)));
				inspect();
			}));
			inspect();
			await ask(path, ['call galangan_probe_secret {"how":"interrupt"}', "secret-interrupt"]);
			inspect();
			const [ordinary, returnedError, failed] = await ask(path, ['call galangan_probe_secret {"how":"ordinary"}'],
				['call galangan_probe_secret {"how":"returned-error"}'], ['call galangan_probe_secret {"how":"partial"}']);
			assert.equal(ordinary, "galangan_probe_secret: listing files");
			assert.equal(returnedError, "galangan_probe_secret failed: listing files");
			assert.match(failed!, /tool stopped/);
			inspect();
		});

		it("redacts tool results in a fork with a saved extension selection", async (t) => {
			const path = store(t);
			await withShell(path, Shell.use((shell) => Effect.promise(async () => {
				const context = BACKGROUND_CONTEXT;
				const root = await shell.harness.root(context);
				await root.configure({ extensions: [leaky] }, context);
				const first = await (await root.submit({ type: "input", content: "save selection" }, context)).wait(context);
				assert.ok(first.status === "done" && first.type === "input");
				// Pi copies the earlier explicit selection, even if the parent's selection has since changed.
				await root.configure({ extensions: [] }, context);
				const fork = await root.fork(first.answer, { ownership: { kind: "ownerless" } }, context);
				const call = { type: "input", content: 'call galangan_probe_secret {"how":"return"}' } as const;
				const settled = await (await fork.submit(call, context)).wait(context);
				assert.ok(settled.status === "done" && settled.type === "input");
				const answer = await fork.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				assert.ok(JSON.stringify(answer?.model).includes(`[secret ${secrets[0]}]`));
			})));
			for (const value of Object.values(env)) assert.equal(readFileSync(path).includes(value), false);
		});

		it("keeps secret values out of the store, also when a tool's error quotes them", async (t) => {
			const path = store(t);
			const marks = secrets.map((name) => `[secret ${name}]`).join(" ");
			const [sent, threw = ""] = await ask(path, ['call galangan_probe_secret {"how":"return"}'],
				['call galangan_probe_secret {"how":"throw"}']);
			// The model still learns which secret was involved.
			assert.ok(sent?.startsWith(`galangan_probe_secret: sent ${marks}`));
			assert.match(threw, /^galangan_probe_secret failed: /);
			assert.ok(threw.includes(`with ${marks} failed`), threw);
			// The file itself, not what Pi reads back: a value anywhere in it, a page or the WAL, is a leak.
			const bytes = [path, `${path}-wal`].filter((file) => existsSync(file)).map((file) => readFileSync(file).toString("latin1"));
			for (const [name, value] of Object.entries(env)) {
				assert.ok(bytes.every((content) => !content.includes(value)), `${name}'s value is in the store`);
			}
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
