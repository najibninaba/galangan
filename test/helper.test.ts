// Foreground helper contracts over real SQLite and scripted faux models; no provider credentials or network.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { defineHarness } from "../src/harness.ts";
import { helper } from "../src/kit/helper.ts";
import { Shell } from "../src/shell.ts";

function setup(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "galangan-helper-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ models: [{ id: "parent", reasoning: true }, { id: "helper", reasoning: true }] });
	const models = createModels();
	models.setProvider(faux.provider);
	const spec = defineHarness({
		name: "helper-test",
		extensions: [helper({ model: { provider: "faux", modelId: "helper" }, thinkingLevel: "high" })],
	});
	const layer = () => Shell.layer({
		harness: spec, store: join(dir, "store.sqlite"), create: true,
		choice: { models, model: { provider: "faux", modelId: "parent" }, thinkingLevel: "medium" },
	});
	return { faux, layer };
}

it("returns findings to the parent, caps parallel and later calls, and resets the budget for the next answer", async (t) => {
	const { faux, layer } = setup(t);
	let childRequests = 0;
	let parentRequests = 0;
	const step: Parameters<typeof faux.setResponses>[0][number] = (transcript, options, _state, model) => {
		faux.appendResponses([step]);
		if (model.id === "helper") {
			childRequests++;
			assert.equal(options?.reasoning, "high");
			assert.equal(transcript.messages.some((message) => message.role === "system" &&
				message.toolsAdded?.some((tool) => tool.name === "delegate")), false);
			// A failed helper still consumes one of the three slots.
			return childRequests === 1
				? fauxAssistantMessage("", { stopReason: "error", errorMessage: "no findings" })
				: fauxAssistantMessage(`finding ${childRequests}`);
		}
		assert.equal(options?.reasoning, "medium");
		parentRequests++;
		if (parentRequests === 1) return fauxAssistantMessage(
			[1, 2, 3, 4].map((n) => fauxToolCall("delegate", { task: `task ${n}` })), { stopReason: "toolUse" },
		);
		if (parentRequests === 2) {
			const results = transcript.messages.filter((message) => message.role === "toolResult");
			assert.equal(results.length, 4);
			assert.equal(results.filter((result) => result.isError).length, 2);
			return fauxAssistantMessage(fauxToolCall("delegate", { task: "fifth attempt" }), { stopReason: "toolUse" });
		}
		if (parentRequests === 3) {
			assert.match(JSON.stringify(transcript.messages.at(-1)), /Three helper calls used/);
			return fauxAssistantMessage("parent synthesis");
		}
		if (parentRequests === 4) return fauxAssistantMessage(
			fauxToolCall("delegate", { task: "new answer budget" }), { stopReason: "toolUse" },
		);
		assert.match(JSON.stringify(transcript.messages.at(-1)), /finding 4/);
		return fauxAssistantMessage("parent synthesis again");
	};
	faux.setResponses([step]);
	await Effect.runPromise(Effect.provide(Effect.gen(function* () {
		const shell = yield* Shell;
		assert.equal(yield* shell.ask("hard task"), "parent synthesis");
		assert.equal(childRequests, 3);
		assert.equal(yield* shell.ask("another task"), "parent synthesis again");
		assert.equal(childRequests, 4);
	}), layer()));
});

it("reattaches to one task-owned child and submission after reopening mid-helper", async (t) => {
	const { faux, layer } = setup(t);
	const started = Promise.withResolvers<void>();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("delegate", { task: "unfinished task" }), { stopReason: "toolUse" }),
		(_transcript, options) => {
			started.resolve();
			return new Promise((resolve) => options!.signal!.addEventListener("abort", () => {
				resolve(fauxAssistantMessage("", { stopReason: "aborted" }));
			}, { once: true }));
		},
	]);
	const id = await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		const submission = await root.submit({ type: "input", content: "work" }, context);
		await started.promise;
		return submission.id;
	})), layer()));
	faux.setResponses([
		fauxAssistantMessage("recovered finding"),
		(transcript) => {
			assert.match(JSON.stringify(transcript.messages.at(-1)), /recovered finding/);
			return fauxAssistantMessage("parent recovered answer");
		},
	]);
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const settled = await (await shell.harness.submission(id, context))!.wait(context);
		assert.equal(settled.status, "done");
		if (settled.status !== "done" || settled.type !== "input") assert.fail("input not answered");
		const entry = await shell.harness.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		assert.match(JSON.stringify(entry?.model), /parent recovered answer/);
		const conversations = await shell.harness.commit((tx) => tx.scanConversations({}, 10), context);
		assert.equal(conversations.items.length, 2, "only root and the reused child");
	})), layer()));
});
