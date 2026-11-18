// Foreground helper contracts over real SQLite and scripted faux models; no provider credentials or network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { defineHarness } from "../src/harness.ts";
import { tallyHarness } from "../examples/tally/tally.ts";
import { helper } from "../src/helper.ts";
import { Shell } from "../src/shell.ts";

function setup(t: TestContext, options: Parameters<typeof helper>[0] = {}, secret?: string) {
	const dir = mkdtempSync(join(tmpdir(), "galangan-helper-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const faux = fauxProvider({ models: [{ id: "parent", reasoning: true }, { id: "helper", reasoning: true }] });
	const models = createModels();
	const store = join(dir, "store.sqlite");
	const extensions = [...new Map([...tallyHarness.extensions, ...(options.extensions ?? [])]
		.map((extension) => [extension.name, extension])).values()];
	models.setProvider(faux.provider);
	// Recreate extensions on reopen too: a closure-held budget must not survive merely because this is one process.
	const layer = () => Shell.layer({
		harness: defineHarness({
			name: "helper-test",
			secrets: ["HELPER_TEST_SECRET"],
			extensions: [...extensions, helper({
				model: { provider: "faux", modelId: "helper" }, thinkingLevel: "high", ...options,
			})],
		}),
		store, create: true, env: { HELPER_TEST_SECRET: secret },
		choice: { models, model: { provider: "faux", modelId: "parent" }, thinkingLevel: "medium" },
	});
	return { faux, models, layer, store };
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
		const conversations = yield* Effect.promise(() => shell.harness.commit((tx) => tx.scanConversations({}, 10), context));
		for (const record of conversations.items.filter((record) => record.owner !== undefined)) {
			const child = yield* Effect.promise(() => shell.harness.conversation(record.id, context));
			const agent = yield* Effect.promise(() => child!.agent(context));
			assert.deepEqual(agent.extensions.map((extension) => extension.name), [],
				"no parent tools, sections or hooks by default");
			assert.deepEqual(agent.tools, []);
		}
	}), layer()));
});

it("redacts a resumed helper's tool result without replenishing the answer's budget", async (t) => {
	const secret = "test-only-helper-credential";
	const probe = defineExtension({
		name: "helper-probe",
		tools: [defineTool({
			name: "helper_probe",
			description: "Returns a test tool result",
			parameters: obj({}),
			execute: async (_args, api, context) => {
				await api.details({ token: secret }, context);
				return { output: [{ type: "text", text: secret }] };
			},
		})],
	});
	const { faux, layer, store } = setup(t, { extensions: [probe] }, secret);
	const started = Promise.withResolvers<void>();
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("delegate", { task: "first task" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("first finding"),
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
		fauxAssistantMessage(fauxToolCall("helper_probe", {}), { stopReason: "toolUse" }),
		(transcript) => {
			assert.match(JSON.stringify(transcript.messages.at(-1)), /\[secret HELPER_TEST_SECRET\]/);
			return fauxAssistantMessage("recovered finding");
		},
		(transcript) => {
			assert.match(JSON.stringify(transcript.messages.at(-1)), /recovered finding/);
			return fauxAssistantMessage(fauxToolCall("delegate", { task: "third task" }), { stopReason: "toolUse" });
		},
		fauxAssistantMessage("third finding"),
		(transcript) => {
			assert.match(JSON.stringify(transcript.messages.at(-1)), /third finding/);
			return fauxAssistantMessage(fauxToolCall("delegate", { task: "fourth must be refused" }), { stopReason: "toolUse" });
		},
		(transcript) => {
			const result = transcript.messages.at(-1);
			assert.ok(result?.role === "toolResult" && result.isError, "fourth helper call must be refused after reopen");
			assert.match(JSON.stringify(result.content), /Three helper calls used/);
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
		assert.equal(conversations.items.length, 4, "root and three children; the resumed child was reused, fourth refused");
	})), layer()));
	assert.equal(readFileSync(store).includes(secret), false);
});

it("gives a child only explicitly selected extensions, independent of the parent's tool filters, and redacts secrets there", async (t) => {
	const { faux, layer } = setup(t, { extensions: tallyHarness.extensions }, "cups");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("delegate", { task: "count one cup" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("tally", { label: "cups" }), { stopReason: "toolUse" }),
		(transcript) => {
			// The child's own tool result uses a marker that fits the short value's byte budget.
			assert.match(JSON.stringify(transcript.messages.at(-1)), /\* = 1/);
			return fauxAssistantMessage("one cup finding");
		},
		fauxAssistantMessage("one cup synthesis"),
	]);
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		const delegate = (await root.agent(context)).tools.find((tool) => tool.name === "delegate")!;
		await root.configure({ tools: [delegate], modelTools: [delegate] }, context);
		assert.equal(await Effect.runPromise(shell.ask("count")), "one cup synthesis");
		const records = await shell.harness.commit((tx) => tx.scanConversations({}, 10), context);
		const child = (await shell.harness.conversation(records.items.find((record) => record.id !== root.id)!.id, context))!;
		const agent = await child.agent(context);
		assert.deepEqual(agent.extensions.map((extension) => extension.name), ["tally"]);
		assert.deepEqual(agent.tools.map((tool) => tool.name), ["tally"]);
	})), layer()));
});

it("distinguishes unregistered helper providers/models, unsupported effort and missing credentials", async (t) => {
	for (const [model, thinkingLevel, expected] of [
		[{ provider: "absent", modelId: "helper" }, "high", /helper provider absent is not registered/],
		[{ provider: "faux", modelId: "absent" }, "high", /helper model faux\/absent is not registered/],
		[{ provider: "faux", modelId: "helper" }, "xhigh", /helper thinkingLevel is "xhigh"; faux\/helper supports/],
		[{ provider: "locked", modelId: "helper" }, "high", /helper provider locked has no credentials configured/],
	] as const) {
		const { faux, models, layer } = setup(t, { model, thinkingLevel });
		const locked = fauxProvider({ provider: "locked", models: [{ id: "helper", reasoning: true }] });
		models.setProvider({ ...locked.provider, auth: { apiKey: {
			name: "unconfigured test provider", resolve: async () => undefined,
		} } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("delegate", { task: "work" }), { stopReason: "toolUse" }),
			(transcript) => {
				const result = transcript.messages.at(-1);
				assert.ok(result?.role === "toolResult" && result.isError);
				assert.match(result.content.map((part) => part.type === "text" ? part.text : "").join(""), expected);
				return fauxAssistantMessage("configuration error reported");
			},
		]);
		await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("work")), layer()));
	}
});
