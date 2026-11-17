// Paid, explicit integration probe, never discovered by npm test. Each stage is a separate Node process on one store.
// Reports committed model/effort/usage, never credentials or private reasoning. Refuses to reuse a previous smoke store.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { AssistantEntry, defineExtension, GenerationTask, hook, ToolResultEntry } from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { defineHarness } from "../src/harness.ts";
import { Tallies, tallyHarness } from "../src/harnesses/tally.ts";
import { helper } from "../src/helper.ts";
import { chooseModel, REAL_MODEL } from "../src/models.ts";
import { Shell } from "../src/shell.ts";

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing from the environment");
if (!process.env.OPENAI_API_KEY.startsWith("sk-")) throw new Error("OPENAI_API_KEY must be an sk- API key, not a ChatGPT token");

if (process.argv[2] !== "--stage") {
	const dir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "galangan-real-model-smoke-")));
	assert.equal(existsSync(join(dir, "smoke.sqlite")), false, "smoke requires a fresh store");
	console.log(`SMOKE store=${dir}`);
	for (const stage of ["first", "restart"]) {
		const result = spawnSync(process.execPath, [import.meta.filename, "--stage", stage, dir], {
			encoding: "utf8", timeout: 180_000,
		});
		process.stdout.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		assert.ifError(result.error);
		assert.equal(result.status, 0, `${stage} process failed`);
	}
	console.log("PASS real tool round trip; state survived process restart; one Sol high helper; Terra wrote answers");
} else {
	const stage = process.argv[3]!;
	const store = join(process.argv[4]!, "smoke.sqlite");
	const choice = await Effect.runPromise(chooseModel("real"));
	// Offering only delegate still allows a text answer. Force its first call only during the restricted helper probe.
	const requireDelegate = defineExtension({
		name: "smoke.require-delegate",
		hooks: [hook(GenerationTask, { beforeProviderRequest: ({ payload }) => {
			const body = payload as {
				tools?: { name?: string }[];
				input: { type?: string; name?: string }[];
			};
			if (body.tools?.length !== 1 || body.tools[0]?.name !== "delegate") return;
			const delegated = body.input.some((item) => item.type === "function_call" && item.name === "delegate");
			return { payload: {
				...body, tool_choice: delegated ? "auto" : { type: "function", name: "delegate" }, parallel_tool_calls: false,
			} };
		} })],
	});
	const spec = defineHarness({ name: "real-smoke", extensions: [...tallyHarness.extensions, helper(), requireDelegate] });
	console.log(`STAGE ${stage} pid=${process.pid}`);
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		const agent = await root.agent(context);
		assert.deepEqual(agent.model, { provider: "openai", modelId: "gpt-6.1-terra" });
		assert.equal(agent.thinkingLevel, "medium");
		console.log(`ROOT ${agent.model!.provider}/${agent.model!.modelId} thinking=${agent.thinkingLevel}`);
		const ask = (content: string, requestId: string) => Effect.runPromise(shell.ask(content, { requestId }));
		const count = () => shell.harness.commit(async (tx) => (await tx.doc(Tallies, root.id)).counts["real-smoke"] ?? 0, context);
		assert.equal(await count(), stage === "first" ? 0 : 1);
		if (stage === "first") {
			console.log(`ANSWER ${await ask(
				'Call tally exactly once with label "real-smoke" and report the count. Do not delegate this easy request.',
				"smoke:first",
			)}`);
		} else {
			console.log("RESTART persisted real-smoke=1");
			console.log(`ANSWER ${await ask(
				'Call tally exactly once with label "real-smoke" and report the count. Do not delegate this easy request.',
				"smoke:restart",
			)}`);
			const delegate = agent.tools.find((tool) => tool.name === "delegate")!;
			await root.configure({ modelTools: [delegate] }, context);
			try {
				const findings = await ask(
					"Integration check: call delegate exactly once with this self-contained reasoning task: " +
					"How many integers from 1 through 500 are divisible by 7 or 11 but not both? Check the overlap. " +
					"Then write your own short answer from its findings.",
					"smoke:helper",
				);
				const entries = await root.entries({ order: "ascending" }, 100, undefined, context);
				const results = entries.items.filter(ToolResultEntry.is).flatMap((entry) => entry.model ?? [])
					.filter((message) => message.role === "toolResult")
					.filter((message) => message.toolName === "delegate");
				assert.ok(results.length > 0, "model did not delegate");
				assert.equal(results.length, 1, "expected exactly one delegate result");
				assert.equal(results[0]!.isError, false, "delegate failed");
				assert.match(findings, /\b104\b/); // 71 + 45 - 2 × 6, independently derived.
				console.log(`ANSWER ${findings}`);
			} finally {
				await root.configure({ modelTools: null }, context);
			}
			// Exercise a real configuration_update on the existing transcript, not just an initial reasoning setting.
			await root.configure({ thinkingLevel: "high" }, context);
			console.log(`EFFORT UPDATE ANSWER ${await ask("Reply with exactly: effort update accepted", "smoke:effort")}`);
			await root.configure({ thinkingLevel: "medium" }, context);
		}
		const persisted = await count();
		assert.equal(persisted, stage === "first" ? 1 : 2);
		console.log(`STATE real-smoke=${persisted}`);
		const conversations = await shell.harness.commit((tx) => tx.scanConversations({}, 20), context);
		assert.equal(conversations.items.length, stage === "first" ? 1 : 2);
		let helpers = 0;
		let tallyResults = 0;
		for (const record of conversations.items) {
			const conversation = (await shell.harness.conversation(record.id, context))!;
			const entries = await conversation.entries({ order: "ascending" }, 100, undefined, context);
			assert.equal(entries.next, undefined, "report must include every generation");
			const child = record.id !== root.id;
			if (child) {
				const childAgent = await conversation.agent(context);
				assert.deepEqual(childAgent.extensions, []);
				assert.deepEqual(childAgent.tools, []);
			}
			for (const entry of entries.items) {
				for (const message of entry.model ?? []) {
					if (ToolResultEntry.is(entry) && message.role === "toolResult") {
						assert.equal(message.isError, false, `${message.toolName} failed: ${JSON.stringify(message.content)}`);
						console.log(`TOOL ${child ? "helper" : "root"}/${message.toolName} ${JSON.stringify(message.content)}`);
						if (!child && message.toolName === "tally") tallyResults++;
						if (message.toolName === "delegate") helpers++;
					}
					if (!AssistantEntry.is(entry) || message.role !== "assistant") continue;
					assert.equal(message.provider, "openai");
					assert.equal(message.model, child ? "gpt-6.1-sol" : "gpt-6.1-terra");
					assert.ok(["stop", "toolUse"].includes(message.stopReason));
					const effort = child || (stage === "restart" && entry === entries.items.at(-1)) ? "high" : "medium";
					assert.equal(message.thinkingLevel, effort);
					assert.equal(message.providerThinkingLevel, effort);
					console.log(`GENERATION ${JSON.stringify({
						conversation: child ? "helper" : "root", entry: entry.id,
						model: `${message.provider}/${message.model}`, responseModel: message.responseModel,
						thinkingLevel: message.thinkingLevel, providerThinkingLevel: message.providerThinkingLevel,
						stopReason: message.stopReason, usage: message.usage,
					})}`);
				}
			}
		}
		assert.equal(tallyResults, stage === "first" ? 1 : 2);
		assert.equal(helpers, stage === "first" ? 0 : 1);
		const usage = await shell.harness.usage(context);
		assert.ok(usage.models[REAL_MODEL]!.totalTokens > 0);
		if (stage === "restart") assert.ok(usage.models["openai/gpt-6.1-sol"]!.totalTokens > 0);
		console.log(`USAGE ${JSON.stringify(usage)}`);
		console.log(`COST_USD ${Object.values(usage.models).reduce((sum, value) => sum + value.cost.total, 0).toFixed(8)} (Pi catalog estimate)`);
	})), Shell.layer({ harness: spec, choice, store, create: stage === "first" })));
}
