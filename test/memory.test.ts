// Run the public memory kit through Pi's tool loop, stock compaction and a real SQLite fork, without a network model.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import {
	CompactionEntry, ToolResultEntry, type Conversation, type EntryId, type InputEntry,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { defineHarness, Shell } from "galangan";
import { memory, memoryFormats } from "galangan/kit/memory";
import { FAUX_MODEL, fauxAnswer, tempStore } from "galangan/testing";

async function send(conversation: Conversation, content: string, entry?: InputEntry) {
	const settled = await (await conversation.submit({ type: "input", content, entry }, context)).wait(context);
	assert.ok(settled.type === "input" && settled.status === "done", JSON.stringify(settled));
	return settled;
}

async function call(conversation: Conversation, name: "recall" | "zoom", args: object, isError = false) {
	const { entry, answer } = await send(conversation, `call ${name} ${JSON.stringify(args)}`);
	const { items } = await conversation.entries({ minEntryId: entry, maxEntryId: answer }, 10, undefined, context);
	const result = items.find(ToolResultEntry.is);
	const message = result?.model?.[0];
	assert.ok(message?.role === "toolResult" && message.toolName === name, `missing ${name} result`);
	assert.equal(message.isError, isError, JSON.stringify(message.content).slice(0, 500));
	assert.ok(!result?.data.diagnostics?.some(({ code }) => code === "truncated"), "Pi truncated the result");
	return message.content.map((part) => part.type === "text" ? part.text : "").join("");
}

function part(output: string, tool: "recall" | "zoom"): { body: string; next?: object } {
	const footer = new RegExp(`\\nContinue: ${tool}\\((\\{.*\\})\\)$`).exec(output);
	return footer === null ? { body: output } : {
		body: output.slice(0, footer.index - (tool === "zoom" ? 1 : 0)), next: JSON.parse(footer[1]!),
	};
}

it("pages raw text across a fork and Pi's stock compaction without gaps or parent-only entries", async (t) => {
	const store = tempStore(t);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const summary = "BranchMark summary, not raw history.";
	const boundaryText = "BranchMark at the fork point.";
	const step: FauxResponseFactory = (transcript) => {
		faux.appendResponses([step]);
		if (transcript.messages.some((message) => message.role === "system" &&
			typeof message.content === "string" &&
			message.content.startsWith("You are a context summarization assistant."))) return fauxAssistantMessage(summary);
		const last = transcript.messages.at(-1);
		if (last?.role === "user" && typeof last.content === "string") {
			if (last.content === "Write the fork marker.") return fauxAssistantMessage(boundaryText);
			if (last.content.startsWith("call ")) return fauxAnswer(transcript);
		}
		// Don't echo historical matches or tool output into new assistant entries.
		return fauxAssistantMessage("Acknowledged.");
	};
	faux.setResponses([step]);
	const harness = defineHarness({ name: "memory-test", extensions: [memory()], formats: { ...memoryFormats } });
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		await root.configure({ compaction: { enabled: false, keepRecentTokens: 128 } }, context);
		const openingText = `${"a short line\n".repeat(260)}${"😀".repeat(4000)}\nBranchMark archive`;
		const opening = (await send(root, openingText)).entry;
		// Scan both ways across full storage pages that have no printable messages.
		await root.commit(async (tx) => {
			for (let i = 0; i < 160; i++) await tx.appendEntry(root.id, { kind: "fixture.passive" });
		}, context);
		const matches = new Map<EntryId, string>();
		for (let i = 0; i < 20; i++) {
			const text = `BranchMark topic ${i}: ${"x".repeat(640)}`;
			matches.set((await send(root, text)).entry, text);
		}
		await root.waitForIdle(context);
		const task = await root.compact(undefined, context);
		const { outcome } = (await shell.harness.waitForTask(task, context)).state;
		assert.equal(outcome.status, "completed");
		if (outcome.result?.submissionId !== undefined) {
			assert.equal((await (await shell.harness.submission(outcome.result.submissionId, context))!.wait(context)).status,
				"done");
		}
		const boundary = (await send(root, "Write the fork marker.")).answer;
		const fork = await root.fork(boundary, { ownership: { kind: "ownerless" } }, context);
		const active = await fork.context(context);
		assert.ok(CompactionEntry.is(active.head), "stock compaction must have been placed before the fork");
		assert.ok(JSON.stringify(active.head.model).includes(summary));
		assert.ok(!active.entries.some(({ id }) => id === opening), "the old message must be outside active context");
		const parentOnly = (await send(root, "BranchMark parent-only.")).entry;
		const forkText = "BranchMark fork-local.";
		const forkOnly = (await send(fork, forkText, { kind: "fixture.input" })).entry;

		let args: object | undefined = { regex: "branchmark [a-z]+" };
		const references: { entry: number }[] = [];
		let pages = 0;
		while (args !== undefined) {
			assert.ok(++pages < 5, "recall did not finish paging");
			const { body, next } = part(await call(fork, "recall", args), "recall");
			for (const [, json] of body.matchAll(/^zoom\((\{.*?\})\) \|/gm)) references.push(JSON.parse(json!));
			assert.doesNotMatch(body, /parent-only|not raw history|arrived between pages/);
			if (pages === 1) await send(fork, "BranchMark arrived between pages.");
			if (next === undefined) assert.match(body, /BranchMark archive/, "the excerpt includes the match near the end");
			args = next;
		}
		assert.ok(pages > 1, "the result must hit its output cap");
		assert.deepEqual(references.map(({ entry }) => entry), [forkOnly, boundary, ...[...matches.keys()].reverse(), opening]);
		assert.equal(await call(fork, "zoom", references[1]!), `zoom({"entry":${boundary}}) | assistant\n${boundaryText}`);
		assert.equal(await call(fork, "zoom", references[0]!), `zoom({"entry":${forkOnly}}) | user\n${forkText}`);

		args = { range: { from: opening, to: forkOnly } };
		const zoomed = new Map<EntryId, string>();
		pages = 0;
		while (args !== undefined) {
			assert.ok(++pages < 10, "zoom did not finish paging");
			const { body, next } = part(await call(fork, "zoom", args), "zoom");
			for (const block of body.split(/\n\n(?=zoom\()/u)) {
				const split = block.indexOf("\n");
				const header = /^zoom\((\{.*\})\) \| (?:user|assistant)$/.exec(block.slice(0, split));
				assert.ok(header, block.slice(0, 100));
				const { entry } = JSON.parse(header[1]!);
				zoomed.set(entry, (zoomed.get(entry) ?? "") + block.slice(split + 1));
			}
			args = next;
		}
		assert.ok(pages > 1);
		assert.equal(zoomed.get(opening), openingText, "reassemble the oversized multibyte entry exactly");
		assert.deepEqual([...zoomed].filter(([id]) => matches.has(id)), [...matches]);
		assert.equal(zoomed.get(boundary), boundaryText);
		assert.equal(zoomed.get(forkOnly), forkText);
		assert.ok(!zoomed.has(parentOnly) && !zoomed.has(active.head.id));
		assert.match(await call(fork, "recall", { regex: "[" }, true), /Invalid regex.*recall\(\{"regex":"keyword"\}\)/s);
		assert.match(await call(fork, "zoom", { entry: parentOnly }, true), /No messages.*recall\(\{"regex":"keyword"\}\)/s);
		assert.match(await call(fork, "zoom", { range: { from: forkOnly, to: opening } }, true), /from <= to.*recall\(/s);
	})), Shell.layer({ harness, store, create: true, choice: { models, model: FAUX_MODEL } })));

	using db = new DatabaseSync(store, { readOnly: true });
	assert.equal(db.prepare("SELECT formats FROM galangan_store").get()?.formats, '{"galangan.memory":1}');
});
