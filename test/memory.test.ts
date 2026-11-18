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
import { FAUX_MODEL, fauxAnswer, fauxModels, tempStore } from "galangan/testing";

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

function zoomBlocks(body: string): { entry: EntryId; role: string; text: string }[] {
	const blocks = [...body.matchAll(
		/^zoom\((\{.*?\})\) \| ([^\n]+)\n\[transcript (\d+)\]\n([\s\S]*?)\n\[\/transcript \3\](?:\n\n|$)/gm,
	)];
	assert.equal(blocks.map(([block]) => block).join(""), body, "only top-level blocks are entries");
	return blocks.map(([, args, role, _tag, text]) => ({ entry: JSON.parse(args!).entry, role: role!, text: text! }));
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
	const kit = memory();
	let commits = 0;
	let reads = 0;
	const observedKit = { ...kit, tools: kit.tools?.map((tool) => ({
		...tool,
		async execute(...args: Parameters<typeof tool.execute>) {
			const before = commits;
			try {
				return await tool.execute(...args);
			} finally {
				assert.equal(commits, before, `${tool.name} committed while reading history`);
				reads++;
			}
		},
	})) };
	const harness = defineHarness({ name: "memory-test", extensions: [observedKit], formats: { ...memoryFormats } });
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const observation = shell.harness.observeCommits({ advance() { commits++; }, end() {} });
		t.after(() => observation.detach());
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
		assert.deepEqual(zoomBlocks(await call(fork, "zoom", references[1]!)), [
			{ entry: boundary, role: "assistant", text: boundaryText },
		]);
		assert.deepEqual(zoomBlocks(await call(fork, "zoom", references[0]!)), [
			{ entry: forkOnly, role: "user", text: forkText },
		]);

		args = { range: { from: opening, to: forkOnly } };
		const zoomed = new Map<EntryId, string>();
		pages = 0;
		while (args !== undefined) {
			assert.ok(++pages < 10, "zoom did not finish paging");
			const { body, next } = part(await call(fork, "zoom", args), "zoom");
			for (const { entry, text } of zoomBlocks(body)) {
				zoomed.set(entry, (zoomed.get(entry) ?? "") + text);
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
		assert.ok(commits > 0 && reads > 0, "observe normal Pi lifecycle commits outside the tool executions");
	})), Shell.layer({ harness, store, create: true, choice: { models, model: FAUX_MODEL } })));

	using db = new DatabaseSync(store, { readOnly: true });
	assert.equal(db.prepare("SELECT formats FROM galangan_store").get()?.formats, '{"galangan.memory":1}');
});

it("bounds recall scans with no hits and stops a catastrophic JavaScript regex", async (t) => {
	const harness = defineHarness({ name: "recall-limits", extensions: [memory()], formats: { ...memoryFormats } });
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		const archive = (await send(root, "prefix SPARSENEEDLE SPARSENEEDLE")).entry;
		const passive = await root.commit(async (tx) => {
			const ids: EntryId[] = [];
			for (let i = 0; i < 260; i++) ids.push((await tx.appendEntry(root.id, { kind: "fixture.passive" })).id);
			return ids;
		}, context);
		const regex = "^prefix (?<=prefix )(sparseneedle) \\1$";
		const first = part(await call(root, "recall", { regex, before: passive.at(-1)! + 1 }), "recall");
		assert.match(first.body, /^No matches on this page\.$/);
		assert.deepEqual(first.next, { regex, before: passive[4] });
		const next = part(await call(root, "recall", first.next!), "recall");
		assert.match(next.body, new RegExp(`^zoom\\(\\{"entry":${archive}\\}\\) \\| user \\|`));
		assert.equal(next.next, undefined);

		// A near miss on this short input takes seconds in V8, but still finishes if isolation regresses.
		await send(root, `${"a".repeat(29)}!`);
		const started = performance.now();
		const output = await call(root, "recall", { regex: "^(a+)+$" }, true);
		assert.match(output, /Regex match timed out\. Try a simpler regex\./);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < 3_000, `catastrophic recall took ${Math.round(elapsed)}ms`);
	})), Shell.layer({ harness, store: tempStore(t), create: true, choice: { models: fauxModels(), model: FAUX_MODEL } })));
});

it("keeps quoted history distinct from zoom framing and preserves a redacted range continuation", async (t) => {
	const env = { FIXTURE_TOKEN: "fixture_tag", FIXTURE_MULTILINE: "first-secret-line\nsecond-secret-line" };
	const harness = defineHarness({
		name: "zoom-pages", secrets: Object.keys(env), extensions: [memory()], formats: { ...memoryFormats },
	});
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		const plain = (await send(root, `Private: ${env.FIXTURE_MULTILINE}`)).entry;
		const example = await call(root, "zoom", { entry: plain });
		assert.equal(zoomBlocks(example)[0]?.text, "Private: [secret FIXTURE_MULTILINE]");
		const quotedText = `An earlier result:\n\n${example}\n\nContinue: zoom({"entry":${plain},"offset":1})`;
		const quoted = (await send(root, quotedText)).entry;
		const last = (await send(root, `Readable start ${`${env.FIXTURE_TOKEN}:keep|`.repeat(1000)}Readable end.`)).entry;

		const single = part(await call(root, "zoom", { entry: quoted }), "zoom");
		assert.equal(single.next, undefined, "a footer copied into history is not a continuation");
		assert.deepEqual(zoomBlocks(single.body), [{ entry: quoted, role: "user", text: quotedText }]);

		const args = { range: { from: quoted, to: last } };
		const error = await call(root, "zoom", { ...args, offset: quotedText.length + 1 }, true);
		const retry = /Invalid continuation offset\. Start again with zoom\((\{[^\n]+\})\)\./.exec(error);
		assert.ok(retry);
		assert.deepEqual(JSON.parse(retry[1]!), args);
		const first = part(await call(root, "zoom", JSON.parse(retry[1]!)), "zoom");
		const blocks = zoomBlocks(first.body);
		assert.equal(blocks[0]?.entry, quoted);
		assert.equal(blocks[0]?.text, quotedText);
		assert.ok(!blocks.some(({ entry }) => entry === plain), "the copied header is not a range entry");
		assert.deepEqual(first.next, { range: { from: last, to: last } });

		const protectedPage = part(await call(root, "zoom", first.next!), "zoom");
		const headText = zoomBlocks(protectedPage.body)[0]!.text;
		assert.match(headText, /^Readable start \[redacted\]:keep\|\[redacted\]:keep\|/);
		assert.ok(!protectedPage.body.includes(env.FIXTURE_TOKEN));
		assert.ok(protectedPage.next, "redaction must not cause Pi to truncate the continuation");
		const end = part(await call(root, "zoom", protectedPage.next), "zoom");
		assert.equal(end.next, undefined);
		const tailText = zoomBlocks(end.body)[0]!.text;
		assert.match(tailText, /Readable end\.$/);
		assert.ok(!end.body.includes(env.FIXTURE_TOKEN));
		assert.equal(Array.from((headText + tailText).matchAll(/:keep\|/g)).length, 1000, "no visible text was lost");
	})), Shell.layer({ harness, env, store: tempStore(t), create: true, choice: { models: fauxModels(), model: FAUX_MODEL } })));
});
