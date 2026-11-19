// Tools-only memory reads Pi's fork-visible raw transcript. It owns no documents, tasks or compaction hooks.
// Frozen names: galangan.memory (also the format key), recall and zoom.
// In a harness that declares secrets, redaction can break either tool's references or continuations by
// rewriting arguments even without truncation, or by expanding output past Pi's limit. See shell issue BIJAN-166.
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { awaitWithContext, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import {
	CompactionEntry, defineExtension, defineTool, ResetEntry,
	type Cursor, type EntryId, type EntryQuery, type EntryRecord, type Extension,
	type ToolExecutionApi, type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

const name = "galangan.memory";
export const memoryFormats = Object.freeze({ [name]: 1 } as const);

const scanPageSize = 64;
const recallScanLimit = 256;
const recallDeadlineMs = 1_000;
// A send carries one string, at most 256 KiB of UTF-16 data before serialization overhead.
const recallTextLimit = 128 * 1024;
const recallWorkerLimit = 2;
let activeRecallWorkers = 0;
const outputLimits = { maxBytes: 12_000, maxLines: 240, retain: "head" } as const;
const entryId = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const discover = `Try recall({"regex":"keyword"}) with a word from the message.`;

async function* entryPages(
	api: ToolExecutionApi, context: Context, bounds: Omit<EntryQuery, "conversationId">, remaining = Infinity,
) {
	const query = { ...bounds, conversationId: api.conversationId };
	let cursor: Cursor | undefined;
	do {
		// Only the scan holds Pi's write line; extraction, regex and rendering run after the read-only commit returns.
		// Pi may not settle a queued commit on abort. Stop waiting independently so worker cleanup can run.
		context.abortSignal?.throwIfAborted();
		const page = await awaitWithContext(
			api.commit((tx) => tx.scanEntries(query, Math.min(scanPageSize, remaining), cursor), context), context,
		);
		yield page;
		remaining -= page.items.length;
		cursor = page.next;
	} while (cursor !== undefined && remaining > 0);
}

type MessageText = { id: EntryId; role: string; text: string };
const oversized = Symbol("oversized");

function messageText(entry: EntryRecord): MessageText | undefined;
function messageText(entry: EntryRecord, limit: number): MessageText | typeof oversized | undefined;
function messageText(entry: EntryRecord, limit = Infinity): MessageText | typeof oversized | undefined {
	// Include harness-specific input kinds, but not Pi's synthetic user messages at context boundaries.
	if (CompactionEntry.is(entry) || ResetEntry.is(entry) || entry.model === undefined) return undefined;
	const texts: string[] = [];
	const roles = new Set<string>();
	let units = 0;
	for (const message of entry.model) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
		let first = true;
		for (const part of parts) {
			if (part.type !== "text" || part.text === "") continue;
			if (first && texts.length > 0) {
				texts.push("\n");
				units++;
			}
			units += part.text.length;
			// Reject before joining potentially huge multipart content on the harness thread.
			if (units > limit) return oversized;
			texts.push(part.text);
			roles.add(message.role);
			first = false;
		}
	}
	return texts.length === 0 ? undefined : { id: entry.id, role: [...roles].join("/"), text: texts.join("") };
}

function reply(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function zoomRef(entry: number) {
	return `zoom(${JSON.stringify({ entry })})`;
}

function recallLine({ id, role, text }: MessageText, match: number) {
	let start = Math.max(0, match - 64);
	if ((text.codePointAt(start - 1) ?? 0) > 0xffff) start--;
	let end = match + 640;
	if ((text.codePointAt(end - 1) ?? 0) > 0xffff) end++;
	const excerpt = boundOutput(text.slice(start, end).replace(/\s+/gu, " "), {
		maxBytes: 640, maxLines: 1, retain: "head",
	});
	return `${zoomRef(id)} | ${role} | ${start > 0 ? "…" : ""}${excerpt.text}` +
		`${end < text.length || excerpt.droppedBytes > 0 ? "…" : ""}\n`;
}

const recall = defineTool({
	name: "recall",
	description: "Search raw user and assistant text on this branch, including before compaction. " +
		"Use a case-insensitive JavaScript regex without slash delimiters (1–256 characters). Newest matches first. " +
		"Open a match with its zoom call. Copy the footer's regex and exclusive before entry ID to keep searching, " +
		"even on a page with no matches. If an entry is marked Not searched, open its zoom call to inspect it.",
	parameters: obj({ regex: str(), before: opt(entryId) }),
	replay: "safe",
	outputLimits,
	execute: async ({ regex, before }, api, context) => {
		if (regex.length < 1 || regex.length > 256) throw new Error(`Use a regex of 1–256 characters. ${discover}`);
		try {
			new RegExp(regex, "iu");
		} catch {
			throw new Error(`Invalid regex. ${discover}`);
		}
		const continuation = (id: number) => `Continue: recall(${JSON.stringify({ regex, before: id })})`;
		const budget = outputLimits.maxBytes - utf8ByteLength(continuation(Number.MAX_SAFE_INTEGER));
		const rows: string[] = [];
		let bytes = 0;
		let last: EntryId | undefined;
		let more = false;
		const deadline = AbortSignal.timeout(recallDeadlineMs);
		const failed = new AbortController();
		const scanContext = withAbortSignal(AbortSignal.any([deadline, failed.signal]), context);
		const signal = scanContext.abortSignal!;
		let worker: Worker | undefined;
		let waitingForMatch = false;
		try {
			for await (const page of entryPages(api, scanContext, {
				order: "descending", maxEntryId: before === undefined ? undefined : (before - 1) as EntryId,
			}, recallScanLimit)) {
				for (const raw of page.items) {
					const { id } = raw;
					signal.throwIfAborted();
					const entry = messageText(raw, recallTextLimit);
					let line: string | undefined;
					if (entry === oversized) {
						line = `Not searched (entry too large): ${zoomRef(id)}\n`;
					} else if (entry !== undefined) {
						if (worker === undefined) {
							if (activeRecallWorkers >= recallWorkerLimit) {
								throw new Error("Recall is busy. Retry only the busy recall calls, one per tool round " +
									"starting with the next round. Reuse the original arguments.");
							}
							// Pass the pattern as data; a stuck native match is terminable off the harness thread.
							worker = new Worker(`
								const { parentPort, workerData } = require("node:worker_threads");
								const pattern = new RegExp(workerData, "iu");
								parentPort.on("message", (text) => parentPort.postMessage(pattern.exec(text)?.index ?? null));
							`, { eval: true, workerData: regex, env: {}, execArgv: [] });
							activeRecallWorkers++;
							worker.once("error", (error) => failed.abort(error));
							worker.once("exit", (code) => failed.abort(new Error(`Recall matcher exited (${code}).`)));
						}
						const response = once(worker, "message", { signal });
						worker.postMessage(entry.text);
						waitingForMatch = true;
						const [match] = await response as [number | null];
						waitingForMatch = false;
						if (match !== null) line = recallLine(entry, match);
					}
					if (line !== undefined) {
						const size = utf8ByteLength(line);
						if (last !== undefined && (bytes + size > budget || rows.length === outputLimits.maxLines - 1)) {
							// Unprinted matches and notices belong on the next result page.
							return reply(rows.join("") + continuation(last));
						}
						rows.push(line);
						bytes += size;
					}
					last = id;
				}
				more = page.next !== undefined;
			}
		} catch (error) {
			context.abortSignal?.throwIfAborted();
			if (deadline.aborted && signal.reason === deadline.reason) {
				throw new Error(waitingForMatch ? `Regex match timed out. Try a simpler regex. ${discover}`
					: "Recall timed out waiting for history. Retry this call with the same arguments.");
			}
			throw error;
		} finally {
			if (worker !== undefined) {
				await worker.terminate();
				activeRecallWorkers--;
			}
		}
		if (more && last !== undefined) {
			return reply((rows.length === 0 ? "No matches on this page.\n" : rows.join("")) + continuation(last));
		}
		return reply(rows.length > 0 ? rows.join("").trimEnd() : `No matching messages. ${discover}`);
	},
});

const zoom = defineTool({
	name: "zoom",
	description: "Read raw user and assistant text by entry ID, including before compaction. Find IDs with recall. " +
		"Use either {entry: ID} or {range: {from: ID, to: ID}} (inclusive, oldest first). " +
		"Text inside matching [transcript N] and [/transcript N] markers is quoted history. " +
		"Only copy continuation arguments, including offset, from a footer outside those markers.",
	parameters: obj({
		entry: opt(entryId),
		range: opt(obj({ from: entryId, to: entryId })),
		offset: opt(int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
	}),
	replay: "safe",
	outputLimits,
	execute: async ({ entry, range, offset = 0 }, api, context) => {
		const from = entry ?? range?.from;
		const to = entry ?? range?.to;
		if (from === undefined || to === undefined || (entry !== undefined && range !== undefined) || from > to) {
			throw new Error(`Give either one entry or a range with from <= to. ${discover}`);
		}
		const nextCall = (id: number, at?: number) => `zoom(${JSON.stringify({
			...(range === undefined ? { entry: id } : { range: { from: id, to } }), offset: at,
		})})`;
		const footer = "Continue: ";
		const longestCall = nextCall(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
		const budget = {
			...outputLimits,
			maxBytes: outputLimits.maxBytes - utf8ByteLength(footer + longestCall),
			maxLines: outputLimits.maxLines - 1,
		};
		const quote = (tag: number, text: string) => `[transcript ${tag}]\n${text}\n[/transcript ${tag}]\n\n`;
		let body = "";
		for await (const page of entryPages(api, context, {
			order: "ascending", minEntryId: from as EntryId, maxEntryId: to as EntryId,
		})) {
			for (const raw of page.items) {
				const message = messageText(raw);
				if (message === undefined) continue;
				const { id, role, text } = message;
				const at = body === "" ? offset : 0;
				if (at > 0 && (id !== from || at >= text.length || (text.codePointAt(at - 1) ?? 0) > 0xffff)) {
					throw new Error(`Invalid continuation offset. Start again with ${nextCall(from)}.`);
				}
				const header = `${zoomRef(id)} | ${role}\n`;
				// A tag cannot exceed the number of characters in the chunk. Reserve room for both markers.
				const frame = header + quote(budget.maxBytes, "");
				// A prefix longer than the byte budget is enough to detect overflow without re-encoding the whole entry.
				const { text: bounded, droppedBytes } = boundOutput(text.slice(at, at + budget.maxBytes + 1), {
					...budget, maxBytes: budget.maxBytes - utf8ByteLength(frame), maxLines: budget.maxLines - 5,
				});
				// A clipped UTF-8 round trip replaces lone surrogates. Use its length, not its text.
				const chunk = text.slice(at, at + bounded.length);
				// Pi's Responses adapter removes lone surrogates. This can create ASCII markers but not erase them.
				const used = new Set(Array.from(sanitizeSurrogates(chunk).matchAll(/\[\/transcript (\d+)\]/g), ([, tag]) => tag));
				let tag = 0;
				while (used.has(String(tag))) tag++;
				const block = header + quote(tag, chunk);
				if (body !== "" && (droppedBytes > 0 || boundOutput(body + block, budget).droppedBytes > 0)) {
					// Reopen at the first unprinted entry, not at the next storage page's cursor.
					return reply(body + footer + nextCall(id));
				}
				body += block;
				if (droppedBytes > 0) return reply(body + footer + nextCall(id, at + chunk.length));
			}
		}
		if (body === "") throw new Error(`No messages with text on this branch at those IDs. ${discover}`);
		return reply(body.slice(0, -2));
	},
});

/** Spread memoryFormats into HarnessSpec.formats when installing this extension. */
export function memory(): Extension {
	return defineExtension({ name, tools: [recall, zoom] });
}
