// Tools-only memory reads Pi's fork-visible raw transcript. It owns no documents, tasks or compaction hooks.
// Frozen names: galangan.memory (also the format key), recall and zoom.
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { withAbortSignal, type Context } from "@earendil-works/chord/context";
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
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
		const page = await api.commit((tx) => tx.scanEntries(query, Math.min(scanPageSize, remaining), cursor), context);
		yield page;
		remaining -= page.items.length;
		cursor = page.next;
	} while (cursor !== undefined && remaining > 0);
}

function messageText(entry: EntryRecord) {
	// Include harness-specific input kinds, but not Pi's synthetic user messages at context boundaries.
	if (CompactionEntry.is(entry) || ResetEntry.is(entry) || entry.model === undefined) return undefined;
	const texts: string[] = [];
	const roles = new Set<string>();
	for (const message of entry.model) {
		if (message.role !== "user" && message.role !== "assistant") continue;
		const text = typeof message.content === "string" ? message.content : message.content
			.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
		if (text === "") continue;
		texts.push(text);
		roles.add(message.role);
	}
	return texts.length === 0 ? undefined : { id: entry.id, role: [...roles].join("/"), text: texts.join("\n") };
}

function reply(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function zoomRef(entry: number) {
	return `zoom(${JSON.stringify({ entry })})`;
}

function recallLine({ id, role, text }: NonNullable<ReturnType<typeof messageText>>, match: number) {
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
		"even on a page with no matches. If a regex times out, try a simpler one.",
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
		const scanContext = withAbortSignal(deadline, context);
		try {
			// The pattern is data, not worker source. A stuck native match must be terminable off the harness thread.
			await using worker = new Worker(`
				const { parentPort, workerData } = require("node:worker_threads");
				const pattern = new RegExp(workerData, "iu");
				parentPort.on("message", (texts) => {
					parentPort.postMessage(texts.map((text) => text === undefined ? null : pattern.exec(text)?.index ?? null));
				});
			`, { eval: true, workerData: regex, env: {}, execArgv: [] });
			const failed = new AbortController();
			worker.once("error", (error) => failed.abort(error));
			worker.once("exit", (code) => failed.abort(new Error(`Recall matcher exited (${code}).`)));
			const signal = AbortSignal.any([scanContext.abortSignal!, failed.signal]);
			for await (const page of entryPages(api, scanContext, {
				order: "descending", maxEntryId: before === undefined ? undefined : (before - 1) as EntryId,
			}, recallScanLimit)) {
				const entries = page.items.map(messageText);
				let indices: Array<number | null> = [];
				if (entries.some(Boolean)) {
					signal.throwIfAborted();
					const response = once(worker, "message", { signal });
					worker.postMessage(entries.map((entry) => entry?.text));
					[indices] = await response as [Array<number | null>];
				}
				for (const [i, { id }] of page.items.entries()) {
					const match = indices[i];
					if (match != null) {
						const line = recallLine(entries[i]!, match);
						const size = utf8ByteLength(line);
						if (last !== undefined && (bytes + size > budget || rows.length === outputLimits.maxLines - 1)) {
							// The match that did not fit is not consumed; it belongs on the next result page.
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
			if (deadline.aborted) throw new Error(`Regex match timed out. Try a simpler regex. ${discover}`);
			throw error;
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
				const chunk = boundOutput(text.slice(at, at + budget.maxBytes + 1), {
					...budget, maxBytes: budget.maxBytes - utf8ByteLength(frame), maxLines: budget.maxLines - 5,
				});
				// Keep the transcript verbatim, including multiline strings the shell needs to match for redaction.
				const used = new Set(Array.from(chunk.text.matchAll(/\[\/transcript (\d+)\]/g), ([, tag]) => tag));
				let tag = 0;
				while (used.has(String(tag))) tag++;
				const block = header + quote(tag, chunk.text);
				if (body !== "" && (chunk.droppedBytes > 0 || boundOutput(body + block, budget).droppedBytes > 0)) {
					// Reopen at the first unprinted entry, not at the next storage page's cursor.
					return reply(body + footer + nextCall(id));
				}
				body += block;
				if (chunk.droppedBytes > 0) return reply(body + footer + nextCall(id, at + chunk.text.length));
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
