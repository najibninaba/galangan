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
//
// Pi's schema migrations are one-way, so every open stamps the store with the Galangan and Pi versions that wrote it,
// and the kit formats (`HarnessSpec.formats`) it was written with. The stamp is a `galangan_store` table rather than
// a Pi doc so it can be read before Pi migrates anything. An older build refuses a newer store (`StoreIncompatible`)
// instead of failing or corrupting it, and an upgrading open first copies the store to a dated backup beside it, so a
// rollback restores that copy rather than running old code on a migrated store.
import { renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SqliteDatabase } from "@earendil-works/chord/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AssistantEntry, createRegistry, Harness, type ModelRef } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
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

/** `store` was written by a newer Galangan, Pi or schema, or another kit format: this build must not open it. */
export class StoreIncompatible extends Data.TaggedError("StoreIncompatible")<{
	readonly store: string;
	readonly detail: string;
}> {
	override get message() {
		return `store ${resolve(this.store)} ${this.detail}`;
	}
}

/** The backup before an upgrading open failed, so the store was left as it was and not opened. */
export class StoreBackupFailed extends Data.TaggedError("StoreBackupFailed")<{
	readonly store: string;
	readonly backup: string;
	readonly detail: string;
}> {
	override get message() {
		const [store, backup] = [resolve(this.store), resolve(this.backup)];
		return `could not back up store ${store} to ${backup} before upgrading it: ${this.detail}`;
	}
}

/** The versions this build stamps. Kept equal to package.json and the installed Pi by test/shell.test.ts. */
export const WRITER = { galangan: "0.2.2", pi: "1.5.2" } as const;

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
				Effect.tryPromise({ try: () => lock(store), catch: (error) => error }).pipe(
					// SQLITE_BUSY: another connection holds the lock. node:sqlite reports extended codes, such as
					// SQLITE_BUSY_RECOVERY (261) while a crashed store's WAL is recovered, so compare the primary code.
					// Anything else is a defect, as before.
					Effect.catch((error) => Predicate.hasProperty(error, "errcode") && (Number(error.errcode) & 0xff) === 5
						? Effect.fail(new StoreLocked({ store }))
						: Effect.die(error)),
					// Two processes starting together both hold WAL's shared lock while each asks for the exclusive one,
					// so both can be refused and leave the store with no owner. A failed lock has closed its connection
					// and written nothing, so a jittered retry lets one win; a real owner still refuses within about
					// half a second. Only the lock is retried: the open after it backs up and writes.
					Effect.retry({
						while: (error) => error instanceof StoreLocked,
						schedule: Schedule.jittered(Schedule.spaced("100 millis")),
						times: 3,
					}),
					Effect.flatMap((db) =>
						Effect.tryPromise({ try: () => open(spec, choice, store, db), catch: (error) => error })),
					// The stamp check and the backup fail typed; anything else is a defect.
					Effect.catch((error): Effect.Effect<never, StoreLocked | StoreIncompatible | StoreBackupFailed> =>
						error instanceof StoreLocked || error instanceof StoreIncompatible
							|| error instanceof StoreBackupFailed
							? Effect.fail(error)
							: Effect.die(error)),
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

/** Opens `store` and takes its exclusive lock, writing nothing; on failure the connection is closed again. */
async function lock(store: string): Promise<SqliteDatabase> {
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
		return db;
	} catch (error) {
		await db.close().catch(() => {});
		throw error;
	}
}

/** Checks, backs up, migrates and stamps the locked store `db`, then opens the Pi Harness over it. */
async function open(spec: HarnessSpec, choice: ModelChoice, store: string, db: SqliteDatabase): Promise<Harness> {
	const registry = createRegistry();
	for (const extension of spec.extensions) registry.install(extension);
	let formats: Formats;
	try {
		formats = await checkStamp(db, spec, store);
	} catch (error) {
		await db.close().catch(() => {});
		throw error;
	}
	// Pi migrates here, inside one transaction; stamp only once that has succeeded.
	const storage = await SqliteStorage.open(db);
	try {
		await db.transaction(async (tx) => {
			await tx.exec(`CREATE TABLE IF NOT EXISTS ${STAMP} (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				galangan TEXT NOT NULL,
				pi TEXT NOT NULL,
				formats TEXT NOT NULL CHECK (json_valid(formats))
			) STRICT`);
			const values = [WRITER.galangan, WRITER.pi, JSON.stringify(formats)];
			await tx.run(`INSERT OR REPLACE INTO ${STAMP} VALUES (1, ?, ?, ?)`, ...values);
		});
	} catch (error) {
		await storage.close(context).catch(() => {});
		throw error;
	}
	const harness = await Harness.open(storage, {
		models: choice.models,
		registry,
		settings: { extensions: spec.extensions, afterFailedRun: "withdraw" },
		onReport: (report) => console.error(`[galangan:${spec.name}] ${report.kind}: ${String(report.error)}`),
	}, context);
	connections.set(harness, db);
	return harness;
}

/** The connection under each open Harness. Pi keeps it private; only `synchronous` reads it. */
const connections = new WeakMap<Harness, SqliteDatabase>();

/**
 * Internal, for galangan/testing's conformance suite: `PRAGMA synchronous` (2 is FULL) on the connection Pi writes
 * through, so the suite checks what the store really runs with rather than the code that meant to set it.
 */
export async function synchronous(harness: Harness): Promise<number | undefined> {
	const db = connections.get(harness);
	if (db === undefined) throw new Error("not a Harness the shell opened");
	return (await db.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous;
}

const STAMP = "galangan_store";
/** Pi's schema table (no prefix), read before Pi opens the store so a newer schema is refused, not half-opened. */
const PI_SCHEMA = "durable_schema";
type Formats = NonNullable<HarnessSpec["formats"]>;
type Stamp = { readonly galangan: string; readonly pi: string; readonly formats: string };

/** `x.y.z` with an optional `-pre-release`, which sorts below its release. Anything else is unreadable. */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Compares two release versions, or returns undefined when either is not one. */
const compare = (a: string, b: string): number | undefined => {
	const [x, y] = [VERSION.exec(a), VERSION.exec(b)];
	if (x === null || y === null) return undefined;
	for (const i of [1, 2, 3]) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
	if (x[4] === y[4]) return 0;
	return x[4] === undefined ? 1 : y[4] === undefined ? -1 : x[4] < y[4] ? -1 : 1;
};

/** The format a harness stamps for each of its extensions: its declared one, or 0 when it declares none. */
const formatsOf = (spec: HarnessSpec): Formats => ({
	...Object.fromEntries(spec.extensions.map((extension) => [extension.name, 0])),
	...spec.formats,
});

const isFormats = (value: unknown): value is Formats =>
	Predicate.isObject(value) && !Array.isArray(value) && Object.values(value).every(Number.isSafeInteger);

/**
 * Refuses a store this build must not open, backs up one it is about to upgrade, and returns the kit formats to stamp.
 * Runs under the exclusive lock, before Pi migrates anything.
 */
async function checkStamp(db: SqliteDatabase, spec: HarnessSpec, store: string): Promise<Formats> {
	const tables = new Set((await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'"))
		.map((row) => row.name));
	const schema = tables.has(PI_SCHEMA)
		? (await db.get<{ version: number }>(`SELECT version FROM ${PI_SCHEMA} WHERE singleton = 1`))?.version ?? 0
		: 0;
	const stamp = tables.has(STAMP)
		? await db.get<Stamp>(`SELECT galangan, pi, formats FROM ${STAMP} WHERE singleton = 1`)
		: undefined;
	const wrote = stamp === undefined ? "an unstamped writer" : `Galangan ${stamp.galangan} on Pi ${stamp.pi}`;
	const self = `Galangan ${WRITER.galangan} on Pi ${WRITER.pi} (schema ${CURRENT_SQLITE_SCHEMA_VERSION})`;
	const galangan = stamp === undefined ? 0 : compare(stamp.galangan, WRITER.galangan);
	const pi = stamp === undefined ? 0 : compare(stamp.pi, WRITER.pi);
	const recorded: unknown = stamp === undefined ? {} : JSON.parse(stamp.formats);
	// A stamp this build cannot read may be from a newer one, so treat it like a newer stamp rather than overwrite it.
	if (galangan === undefined || pi === undefined || !isFormats(recorded)) {
		throw new StoreIncompatible({
			store,
			detail: `has a stamp this ${self} cannot read (${wrote}, formats ${stamp?.formats}); run the build `
				+ "that wrote it, or restore a backup",
		});
	}
	if (schema > CURRENT_SQLITE_SCHEMA_VERSION || galangan > 0 || pi > 0) {
		throw new StoreIncompatible({
			store,
			detail: `was written by ${wrote} (schema ${schema}), newer than this ${self}; run that version or newer, `
				+ "or restore the backup taken before it upgraded the store",
		});
	}
	// An unstamped store with data predates format stamps, so its extensions wrote format 0 as far as anyone knows.
	const stored: Formats = stamp === undefined && schema > 0
		? Object.fromEntries(Object.keys(formatsOf(spec)).map((extension) => [extension, 0]))
		: recorded;
	const formats = formatsOf(spec);
	for (const [extension, format] of Object.entries(formats)) {
		const was = stored[extension];
		// An extension new to this store has written nothing yet, so any format is its first.
		if (was === undefined || was === format) continue;
		// Experimental kit formats have no migration: under another format Pi would read the old docs as empty.
		throw new StoreIncompatible({
			store,
			detail: `has ${extension} format ${was}, and this build uses ${extension} format ${format}, which does `
				+ `not migrate; run a build with ${extension} format ${was}, or wipe the store (move it aside, --init)`,
		});
	}
	// An upgrade is one-way once this open stamps or migrates the store, so keep a copy for rolling back. A new store
	// (schema 0) has nothing to keep.
	if (schema > 0 && (schema < CURRENT_SQLITE_SCHEMA_VERSION || stamp === undefined || galangan < 0 || pi < 0)) {
		const backup = `${store}.${new Date().toISOString().replaceAll(":", "-")}.bak`;
		// VACUUM INTO writes a consistent copy, WAL included, under our lock. It goes to a temporary name first, so a
		// file named .bak is always a whole copy even if this process dies mid-copy.
		const partial = `${backup}.tmp`;
		try {
			rmSync(partial, { force: true });
			await db.run("VACUUM INTO ?", partial);
			renameSync(partial, backup);
		} catch (error) {
			rmSync(partial, { force: true });
			const detail = error instanceof Error ? error.message : String(error);
			throw new StoreBackupFailed({ store, backup, detail });
		}
		console.error(`[galangan:${spec.name}] upgrading the store from ${wrote} (schema ${schema}) to ${self}; `
			+ `backed it up to ${resolve(backup)}`);
	}
	return { ...stored, ...formats };
}
