// The shell: Effect structures the services, Pi Durable owns persisted execution.
//
// `Shell.layer` opens one Pi Harness over a SQLite store for one harness spec (src/harness.ts) and closes it when the
// layer's scope ends. The store survives the process: a reopen finds the same root conversation, and `resume()`
// continues any run the last process left unfinished.
//
// One process owns a store at a time. Pi has no cross-process lock, so `open()` holds SQLite's exclusive lock for the
// connection's life: a second process fails at once with `StoreLocked` instead of resuming the same tasks, and the OS
// drops the lock when the owner dies, so a crash leaves no stale lease. It also shuts out read-only viewers; if those
// are needed, port Lunas's writer lease (its src/lease.ts) instead.
//
// Only an explicit `create` makes a store. Otherwise a missing file is `StoreMissing`: a mistyped path or another
// working directory must not open an empty store and start the harness with no past (optmem's `memo init` rule).
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { Context, Data, Effect, Layer, Predicate, Schedule } from "effect";
import type { HarnessSpec } from "./harness.ts";
import { chooseThinking, type ModelChoice } from "./models.ts";

const context = BACKGROUND_CONTEXT;

/** An input Pi settled without an answer: `reason` is Pi's (`aborted`, `model_error`, `faulted`, `no_model`, ...). */
export class Unanswered extends Data.TaggedError("Unanswered")<{ readonly reason: string; readonly detail: string }> {
	override get message() {
		return `unanswered (${this.reason}): ${this.detail}`;
	}
}

/** No SQLite file at `store`: nothing is there and the shell was not asked to create one, or a non-file is (`notFile`). */
export class StoreMissing extends Data.TaggedError("StoreMissing")<{
	readonly store: string;
	readonly notFile?: boolean;
}> {
	override get message() {
		return this.notFile ? `${resolve(this.store)} is not a store file` : `no store at ${resolve(this.store)}`;
	}
}

/** Another process has `store` open. */
export class StoreLocked extends Data.TaggedError("StoreLocked")<{ readonly store: string }> {
	override get message() {
		return `store ${resolve(this.store)} is in use by another process`;
	}
}

export type ShellOptions = {
	readonly harness: HarnessSpec;
	readonly choice: ModelChoice;
	/** SQLite file. */
	readonly store: string;
	/** Create `store` and its directory when missing; otherwise a missing store is `StoreMissing`. */
	readonly create?: boolean;
};

export class Shell extends Context.Service<Shell, {
	readonly name: string;
	readonly model: ModelRef;
	readonly thinkingLevel: ModelThinkingLevel;
	/** The open Pi Harness, for anything the shell does not wrap (other conversations, inspect, watch). */
	readonly harness: Harness;
	/** Submit `content` to the root conversation and wait for its answer text. A repeated `requestId` is one input. */
	readonly ask: (content: string, options?: { readonly requestId?: string }) => Effect.Effect<string, Unanswered>;
}>()("galangan/Shell") {
	static layer = ({ harness: spec, choice, store, create = false }: ShellOptions) =>
		Layer.effect(Shell, Effect.gen(function* () {
			// A directory or other non-file would only fail later as SQLITE_CANTOPEN, a defect that says "restart it".
			const found = statSync(store, { throwIfNoEntry: false });
			if (found !== undefined && !found.isFile()) return yield* new StoreMissing({ store, notFile: true });
			if (!create && found === undefined) return yield* new StoreMissing({ store });
			const thinkingLevel = yield* chooseThinking(choice);
			const harness = yield* Effect.acquireRelease(
				Effect.tryPromise({ try: () => open(spec, choice, store), catch: (error) => error }).pipe(
					// SQLITE_BUSY: another connection holds the lock. node:sqlite reports extended codes, such as
					// SQLITE_BUSY_RECOVERY (261) while a crashed store's WAL is recovered, so compare the primary code.
					// Anything else is a defect, as before.
					Effect.catch((error) => Predicate.hasProperty(error, "errcode") && (Number(error.errcode) & 0xff) === 5
						? Effect.fail(new StoreLocked({ store }))
						: Effect.die(error)),
					// Two processes starting together both hold WAL's shared lock while each asks for the exclusive one,
					// so both can be refused and leave the store with no owner. A failed open has closed its connection,
					// so a jittered retry lets one win; a real owner still refuses within about half a second.
					Effect.retry({
						while: (error) => error instanceof StoreLocked,
						schedule: Schedule.jittered(Schedule.spaced("100 millis")),
						times: 3,
					}),
				),
				// close() writes running tasks back as pending without counting a restart; a hard kill counts one.
				(harness) => Effect.promise(() => harness.close(context)),
			);
			const root = yield* Effect.promise(() => harness.root(context));
			// root({ agent }) only configures a new conversation. Reconfigure before resuming existing work too.
			yield* Effect.promise(() => root.configure({ model: choice.model, thinkingLevel }, context));
			harness.resume();
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
			return { name: spec.name, model: choice.model, thinkingLevel, harness, ask };
		}));
}

async function open(spec: HarnessSpec, choice: ModelChoice, store: string): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of spec.extensions) registry.install(extension);
	// No busy timeout: the owner holds the lock alone, so a wait would only delay a second process's refusal (chord's
	// default is 5 s). The open creates a missing file and directory; Shell.layer has already checked `create`.
	const db = await openNodeSqliteDatabase(store, { busyTimeoutMs: 0 });
	try {
		// Pi's Node SQLite storage runs WAL with `synchronous = NORMAL`, which can lose the newest commits on power
		// loss. FULL fsyncs every commit (lunas measured about +0.5 ms). It is per connection: set it on the one Pi uses.
		await db.exec("PRAGMA synchronous = FULL");
		// EXCLUSIVE keeps the lock after the first write until close; the empty write transaction takes it now, before
		// Pi reads or resumes anything, and also refuses readers.
		await db.exec("PRAGMA locking_mode = EXCLUSIVE");
		await db.transaction(async () => {});
	} catch (error) {
		await db.close().catch(() => {});
		throw error;
	}
	return Harness.open(await SqliteStorage.open(db), {
		models: choice.models,
		registry,
		settings: { extensions: spec.extensions, afterFailedRun: "withdraw" },
		onReport: (report) => console.error(`[galangan:${spec.name}] ${report.kind}: ${String(report.error)}`),
	}, context);
}
