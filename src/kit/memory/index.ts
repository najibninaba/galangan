// Tools-only memory reads Pi's fork-visible raw transcript. It owns no documents, tasks or compaction hooks.
// Frozen names: galangan.memory (also the format key), recall and zoom.
import type { Context } from "@earendil-works/chord/context";
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
import {
	CompactionEntry, defineExtension, defineTool, ResetEntry,
	type Cursor, type EntryId, type EntryQuery, type Extension, type ToolExecutionApi, type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { int, obj, opt, str } from "@earendil-works/pi-schema";

const name = "galangan.memory";
export const memoryFormats = Object.freeze({ [name]: 1 } as const);

const scanPageSize = 64;
const outputLimits = { maxBytes: 12_000, maxLines: 240, retain: "head" } as const;
const entryId = int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const discover = `Try recall({"regex":"keyword"}) with a word from the message.`;

async function* messages(api: ToolExecutionApi, context: Context, bounds: Omit<EntryQuery, "conversationId">) {
	const query = { ...bounds, conversationId: api.conversationId };
	let cursor: Cursor | undefined;
	do {
		// Only the scan holds Pi's write line; extraction, regex and rendering run after the read-only commit returns.
		const page = await api.commit((tx) => tx.scanEntries(query, scanPageSize, cursor), context);
		for (const entry of page.items) {
			// Include harness-specific input kinds, but not Pi's synthetic user messages at context boundaries.
			if (CompactionEntry.is(entry) || ResetEntry.is(entry) || entry.model === undefined) continue;
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
			if (texts.length > 0) yield { id: entry.id, role: [...roles].join("/"), text: texts.join("\n") };
		}
		cursor = page.next;
	} while (cursor !== undefined);
}

function reply(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function zoomRef(entry: number) {
	return `zoom(${JSON.stringify({ entry })})`;
}

const recall = defineTool({
	name: "recall",
	description: "Search raw user and assistant text on this branch, including before compaction. " +
		"Use a case-insensitive JavaScript regex without slash delimiters (1–256 characters). Newest matches first. " +
		"Open a match with its zoom call. To continue, copy the footer's regex and exclusive before entry ID.",
	parameters: obj({ regex: str(), before: opt(entryId) }),
	replay: "safe",
	outputLimits,
	execute: async ({ regex, before }, api, context) => {
		if (regex.length < 1 || regex.length > 256) throw new Error(`Use a regex of 1–256 characters. ${discover}`);
		let pattern: RegExp;
		try {
			pattern = new RegExp(regex, "iu");
		} catch {
			throw new Error(`Invalid regex. ${discover}`);
		}
		const continuation = (id: number) => `Continue: recall(${JSON.stringify({ regex, before: id })})`;
		const budget = outputLimits.maxBytes - utf8ByteLength(continuation(Number.MAX_SAFE_INTEGER));
		const rows: string[] = [];
		let bytes = 0;
		let last: EntryId | undefined;
		for await (const { id, role, text } of messages(api, context, {
			order: "descending", maxEntryId: before === undefined ? undefined : (before - 1) as EntryId,
		})) {
			const match = pattern.exec(text);
			if (match === null) continue;
			let start = Math.max(0, match.index - 64);
			if ((text.codePointAt(start - 1) ?? 0) > 0xffff) start--;
			let end = match.index + 640;
			if ((text.codePointAt(end - 1) ?? 0) > 0xffff) end++;
			const excerpt = boundOutput(text.slice(start, end).replace(/\s+/gu, " "), {
				maxBytes: 640, maxLines: 1, retain: "head",
			});
			const line = `${zoomRef(id)} | ${role} | ${start > 0 ? "…" : ""}${excerpt.text}` +
				`${end < text.length || excerpt.droppedBytes > 0 ? "…" : ""}\n`;
			const size = utf8ByteLength(line);
			if (last !== undefined && (bytes + size > budget || rows.length === outputLimits.maxLines - 1)) {
				return reply(rows.join("") + continuation(last));
			}
			rows.push(line);
			bytes += size;
			last = id;
		}
		return reply(rows.length > 0 ? rows.join("").trimEnd() : `No matching messages. ${discover}`);
	},
});

const zoom = defineTool({
	name: "zoom",
	description: "Read raw user and assistant text by entry ID, including before compaction. Find IDs with recall. " +
		"Use either {entry: ID} or {range: {from: ID, to: ID}} (inclusive, oldest first). " +
		"Only pass offset when copying a continuation footer.",
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
		const continuation = (id: number, at?: number) => `Continue: zoom(${JSON.stringify({
			...(range === undefined ? { entry: id } : { range: { from: id, to } }), offset: at,
		})})`;
		const budget = {
			...outputLimits,
			maxBytes: outputLimits.maxBytes - utf8ByteLength(continuation(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)),
			maxLines: outputLimits.maxLines - 1,
		};
		let body = "";
		for await (const { id, role, text } of messages(api, context, {
			order: "ascending", minEntryId: from as EntryId, maxEntryId: to as EntryId,
		})) {
			const at = body === "" ? offset : 0;
			if (at > 0 && (id !== from || at >= text.length || (text.codePointAt(at - 1) ?? 0) > 0xffff)) {
				throw new Error(`Invalid continuation offset. Start again with ${zoomRef(id)}.`);
			}
			const header = `${zoomRef(id)} | ${role}\n`;
			// A prefix longer than the byte budget is enough to detect overflow without re-encoding the whole entry.
			const chunk = boundOutput(text.slice(at, at + budget.maxBytes + 1), {
				...budget, maxBytes: budget.maxBytes - utf8ByteLength(header) - 2, maxLines: budget.maxLines - 3,
			});
			const block = header + chunk.text + "\n\n";
			if (body !== "" && (chunk.droppedBytes > 0 || boundOutput(body + block, budget).droppedBytes > 0)) {
				// Reopen at the first unprinted entry, not at the next storage page's cursor.
				return reply(body + continuation(id));
			}
			body += block;
			if (chunk.droppedBytes > 0) return reply(body + continuation(id, at + chunk.text.length));
		}
		if (body === "") throw new Error(`No messages with text on this branch at those IDs. ${discover}`);
		return reply(body.slice(0, -2));
	},
});

/** Spread memoryFormats into HarnessSpec.formats when installing this extension. */
export function memory(): Extension {
	return defineExtension({ name, tools: [recall, zoom] });
}
