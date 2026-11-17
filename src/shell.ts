// The shell: Effect structures the services, Pi Durable owns persisted execution.
//
// `Shell.layer` opens one Pi Harness over a SQLite store for one harness spec (src/harness.ts) and closes it when the
// layer's scope ends. The store survives the process: a reopen finds the same root conversation, and `resume()`
// continues any run the last process left unfinished.
//
// One process owns a store at a time; Pi has no cross-process lock. Lunas adds a writer lease for that (its
// src/lease.ts); add one here before running two shells against one directory.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { AssistantEntry, createRegistry, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Context, Data, Effect, Layer } from "effect";
import type { HarnessSpec } from "./harness.ts";
import type { ModelChoice } from "./models.ts";

const context = BACKGROUND_CONTEXT;

/** An input Pi settled without an answer: `reason` is Pi's (`aborted`, `model_error`, `faulted`, `no_model`, ...). */
export class Unanswered extends Data.TaggedError("Unanswered")<{ readonly reason: string; readonly detail: string }> {
	override get message() {
		return `unanswered (${this.reason}): ${this.detail}`;
	}
}

export type ShellOptions = {
	readonly harness: HarnessSpec;
	readonly choice: ModelChoice;
	/** SQLite file; its directory is created. */
	readonly store: string;
};

export class Shell extends Context.Service<Shell, {
	readonly name: string;
	readonly model: ModelRef;
	/** The open Pi Harness, for anything the shell does not wrap (other conversations, inspect, watch). */
	readonly harness: Harness;
	/** Submit `content` to the root conversation and wait for its answer text. A repeated `requestId` is one input. */
	readonly ask: (content: string, options?: { readonly requestId?: string }) => Effect.Effect<string, Unanswered>;
}>()("galangan/Shell") {
	static layer = ({ harness: spec, choice, store }: ShellOptions) =>
		Layer.effect(Shell, Effect.gen(function* () {
			const harness = yield* Effect.acquireRelease(
				Effect.promise(() => open(spec, choice, store)),
				// close() writes running tasks back as pending without counting a restart; a hard kill counts one.
				(harness) => Effect.promise(() => harness.close(context)),
			);
			harness.resume();
			const root = yield* Effect.promise(() => harness.root(context, { agent: { model: choice.model } }));
			const ask = (content: string, options: { readonly requestId?: string } = {}) =>
				Effect.gen(function* () {
					const submission = yield* Effect.promise(() => root.submit({ type: "input", content, ...options }, context));
					const settled = yield* Effect.promise(() => submission.wait(context));
					if (settled.status !== "done" || settled.type !== "input") {
						const reason = settled.status === "done" ? "not_input" : settled.reason;
						return yield* new Unanswered({ reason, detail: String("detail" in settled ? settled.detail ?? "" : "") });
					}
					const answer = yield* Effect.promise(() => root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context));
					return (answer?.model ?? [])
						.flatMap((message) => (message.role === "assistant" ? message.content : []))
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("")
						.trim();
				});
			return { name: spec.name, model: choice.model, harness, ask };
		}));
}

async function open(spec: HarnessSpec, choice: ModelChoice, store: string): Promise<Harness> {
	mkdirSync(dirname(store), { recursive: true });
	const registry = createRegistry();
	for (const extension of spec.extensions) registry.install(extension);
	// Pi's Node SQLite storage runs WAL with `synchronous = NORMAL`, which can lose the newest commits on power loss.
	// FULL fsyncs every commit (lunas measured about +0.5 ms). It is per connection: set it on the one Pi uses.
	const db = await openNodeSqliteDatabase(store);
	await db.exec("PRAGMA synchronous = FULL");
	return Harness.open(await SqliteStorage.open(db), {
		models: choice.models,
		registry,
		settings: { extensions: spec.extensions, afterFailedRun: "withdraw" },
		onReport: (report) => console.error(`[galangan:${spec.name}] ${report.kind}: ${String(report.error)}`),
	}, context);
}
