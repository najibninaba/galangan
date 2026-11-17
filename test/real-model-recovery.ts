// Paid SIGKILL experiment, outside npm test. Gates pause real streams or afterTool, never replace model responses.
// Evidence contains public answers, task checkpoints and usage, but no credentials, request bodies or reasoning text.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry, defineDoc, defineExtension, GenerationTask, Harness, hook, LiveDoc, ToolTask,
	type ConversationId, type EntryId, type Storage, type TaskId,
} from "@earendil-works/pi-durable";
import { Effect } from "effect";
import { defineHarness } from "../src/harness.ts";
import { Tallies, tallyHarness } from "../src/harnesses/tally.ts";
import { helper } from "../src/helper.ts";
import { chooseModel } from "../src/models.ts";
import { Shell } from "../src/shell.ts";

const scenarios = ["A", "B", "C", "D"] as const;
type Scenario = typeof scenarios[number];
type Event = { kind: string; [key: string]: unknown };
const MAX_OUTPUT = 1024;
const SPEND_LIMIT = 0.25;
// A read-only lens over the helper's existing document; snapshot never creates a budget.
const Budget = defineDoc<{ first?: EntryId; calls: TaskId[] }>({
	kind: "galangan.helper.budget", version: 1, scope: "conversation", history: "latest", fork: "initial",
	initial: () => ({ calls: [] }), checkpointWhen: () => true,
});
const prompts: Record<Scenario, string> = {
	A: "Write 70 numbered lines, each naming a different ordinary household object and its use. Do not call tools.",
	B: 'Count one crash-test item by calling tally exactly once with label "crash-test", then report the result.',
	C: "Call delegate once: Count integers from 1 through 500 divisible by 7 or 11 but not both. " +
		"Ask the helper to check the overlap and present its findings in twelve short numbered lines. " +
		"Then write your own concise answer from those findings.",
	D: "Call delegate once: Count integers from 1 through 500 divisible by 7 or 11 but not both. " +
		"Then write your own concise answer from its findings.",
};

if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing from the environment");
if (!process.env.OPENAI_API_KEY.startsWith("sk-")) throw new Error("OPENAI_API_KEY must be an sk- API key");

function events(dir: string): Event[] {
	const path = join(dir, "events.jsonl");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((s) => JSON.parse(s)) : [];
}

if (process.argv[2] !== "--worker") {
	const dir = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "galangan-recovery-")));
	assert.equal(existsSync(join(dir, "events.jsonl")), false, "requires a fresh evidence directory");
	for (const scenario of scenarios) {
		assert.equal(existsSync(join(dir, `${scenario}.sqlite`)), false, "requires fresh recovery stores");
	}
	console.log(`RECOVERY evidence=${dir} limit_usd=${SPEND_LIMIT}`);
	for (const scenario of scenarios) {
		for (const phase of ["kill", "reopen"]) {
			await new Promise<void>((accept, reject) => {
				const child = spawn(process.execPath, [import.meta.filename, "--worker", scenario, phase, dir], {
					stdio: ["ignore", "inherit", "inherit", "ipc"],
				});
				let gated = false;
				const timeout = setTimeout(() => {
					child.kill("SIGKILL");
					reject(new Error(`${scenario}/${phase}: timed out; boundary NOT verified`));
				}, 180_000);
				child.on("message", (message) => {
					if ((message as Event).kind !== "gate") return;
					gated = true;
					assert.equal(phase, "kill");
					assert.equal(child.kill("SIGKILL"), true);
				});
				child.on("error", reject);
				child.on("exit", (code, signal) => {
					clearTimeout(timeout);
					try {
						if (phase === "kill") {
							assert.equal(gated, true, `${scenario}: process exited before the intended boundary`);
							assert.equal(signal, "SIGKILL");
							const receipt = { kind: "killed", scenario, pid: child.pid, signal };
							appendFileSync(join(dir, "events.jsonl"), `${JSON.stringify(receipt)}\n`);
							console.log(JSON.stringify(receipt));
						} else assert.equal(code, 0, `${scenario}: reopen failed (${signal})`);
						accept();
					} catch (error) { reject(error); }
				});
			});
		}
	}
	const log = events(dir);
	const snapshots = log.filter((event) => event.kind === "after");
	const summary = {
		requestsSent: log.filter((event) => event.kind === "request").length,
		usageBearingGenerations: snapshots.reduce((n, event) => n + Number(event.usageBearingGenerations), 0),
		piEstimatedUsd: snapshots.reduce((n, event) => n + Number(event.piEstimatedUsd), 0),
		reservedCeilingUsd: log.filter((event) => event.kind === "request").reduce((n, event) => n + Number(event.reservedUsd), 0),
		billing: "Aborted requests may be billed; Pi usage is not an invoice. Reservations include their full output caps.",
	};
	writeFileSync(join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
	console.log(`SUMMARY ${JSON.stringify(summary)}`);
	console.log("COMPLETE four verified SIGKILL boundaries; see events.jsonl for all generations, tools, reports and task restarts");
} else {
	const scenario = process.argv[3] as Scenario;
	assert.ok(scenarios.includes(scenario));
	const phase = process.argv[4]!;
	const dir = process.argv[5]!;
	const requestId = `recovery:${scenario}`;
	const log = (kind: string, value: Record<string, unknown> = {}) => {
		const event = { kind, scenario, phase, pid: process.pid, time: new Date().toISOString(), ...value };
		const line = JSON.stringify(event).replaceAll(process.env.OPENAI_API_KEY!, "[redacted]");
		appendFileSync(join(dir, "events.jsonl"), `${line}\n`);
		console.log(line);
	};
	const tasks = (records: Awaited<ReturnType<Storage["scanTasks"]>>["items"]) => records.map((task) => ({
		id: task.id, kind: task.kind, conversationId: task.conversationId, owner: task.owner,
		restarts: task.restarts ?? 0, state: task.state,
	}));
	let opened: Harness;
	let storage: Storage;
	const persistedPartials = new Set<ConversationId>();
	const originalOpen = Harness.open;
	Harness.open = async (backend, options, ctx) => {
		storage = backend;
		opened = await originalOpen(backend, {
			...options,
			onReport: (report) => {
				const safeReport = { ...report, error: String(report.error).replaceAll(process.env.OPENAI_API_KEY!, "[redacted]") };
				log("report", { report: safeReport });
				options.onReport?.(safeReport);
			},
		}, ctx);
		log("opened", { tasks: tasks((await storage.scanTasks({}, 100, undefined, context)).items) });
		opened.observeCommits({
			advance(publication) {
				for (const change of publication.changes) {
					if (change.type === "task") log("task", { seq: publication.seq, task: tasks([change.value])[0] });
					if (change.type === "document" && change.kind === "change" && change.record.kind === LiveDoc.definition.kind &&
						(change.value.generation as { message?: unknown } | undefined)?.message !== undefined &&
						change.conversationId !== undefined) persistedPartials.add(change.conversationId);
				}
			},
			end() {},
		});
		return opened;
	};
	async function snapshot() {
		const conversations = (await storage.scanConversations({}, 100, undefined, context)).items;
		const submissions = await storage.scanSubmissions({}, 100, undefined, context);
		assert.equal(submissions.next, undefined);
		const pages = await Promise.all(conversations.map((conversation) => storage.scanEntries({
			conversationId: conversation.id, order: "ascending",
		}, 200, undefined, context)));
		for (const page of pages) assert.equal(page.next, undefined);
		const entries = pages.flatMap((page) => page.items).sort((a, b) => a.id - b.id);
		const generations = entries.filter(AssistantEntry.is).flatMap((entry) => (entry.model ?? [])
			.flatMap((message) => message.role !== "assistant" ? [] : [{
				entry: entry.id, conversation: entry.conversationId, model: `${message.provider}/${message.model}`,
				responseModel: message.responseModel, thinkingLevel: message.thinkingLevel ?? null,
				providerThinkingLevel: message.providerThinkingLevel ?? null, stopReason: message.stopReason,
				usage: message.usage, responseId: message.responseId,
				text: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""),
				toolCalls: message.content.flatMap((part) => part.type === "toolCall" ? [part] : []),
			}]));
		const tools = entries.flatMap((entry) => (entry.model ?? []).flatMap((message) => message.role !== "toolResult"
			? [] : [{ entry: entry.id, conversation: entry.conversationId, ...message }]));
		const state = [];
		for (const conversation of conversations) {
			const live = await opened.snapshot(LiveDoc, conversation.id, context);
			state.push({
				id: conversation.id, owner: conversation.owner,
				budget: await opened.snapshot(Budget, conversation.id, context),
				tallies: await opened.snapshot(Tallies, conversation.id, context),
				live: { run: live?.run, runFailure: live?.runFailure, tools: live?.tools,
					generation: live?.generation === undefined ? undefined : {
						attempt: live.generation.attempt,
						partial: live.generation.message === undefined ? undefined : {
							model: live.generation.message.model, thinkingLevel: live.generation.message.thinkingLevel,
							stopReason: live.generation.message.stopReason,
							contentTypes: live.generation.message.content.map((part) => part.type),
						},
					} },
			});
		}
		const usage = await opened.usage(context);
		return {
			conversations: state, submissions: submissions.items, generations, tools,
			tasks: tasks((await storage.scanTasks({}, 100, undefined, context)).items), usage,
			usageBearingGenerations: generations.filter((generation) => generation.usage.totalTokens > 0).length,
			piEstimatedUsd: Object.values(usage.models).reduce((n, value) => n + value.cost.total, 0),
		};
	}
	async function gate(boundary: string, target: ConversationId, extra: Record<string, unknown> = {}): Promise<never> {
		const state = await snapshot();
		assert.equal(state.submissions.find((submission) => submission.requestId === requestId)?.status, "placed");
		assert.equal(state.tools.length, 0, "root must not have received the tool result before the kill");
		const active = state.tasks.filter((task) => task.conversationId === target && task.state.status === "running");
		assert.ok(active.length > 0);
		if (scenario === "A" || scenario === "C") {
			assert.ok(active.some((task) => task.kind === GenerationTask.definition.name && "checkpoint" in task.state &&
				(task.state.checkpoint as { phase?: string } | undefined)?.phase === "request"));
			assert.ok(persistedPartials.has(target), "partial must be published to storage before SIGKILL");
		} else {
			assert.ok(active.some((task) => task.kind === ToolTask.definition.name && "checkpoint" in task.state &&
				(task.state.checkpoint as { phase?: string } | undefined)?.phase === "execute"));
		}
		if (scenario === "B") assert.equal(state.conversations[0]!.tallies?.counts["crash-test"], 1);
		if (scenario === "C" || scenario === "D") {
			assert.equal(state.conversations.length, 2);
			assert.equal(state.submissions.length, 2);
			assert.equal(state.conversations[0]!.budget?.calls.length, 1);
		}
		if (scenario === "D") {
			assert.equal(state.submissions.find((submission) => submission.requestId?.startsWith("subagent:"))?.status, "done");
			assert.equal(state.generations.filter((generation) => generation.model === "openai/gpt-6.1-sol" &&
				generation.stopReason === "stop").length, 1);
		}
		log("gate", { boundary, target, ...extra, ...state });
		process.send!({ kind: "gate" });
		return new Promise<never>(() => {});
	}
	const baseChoice = await Effect.runPromise(chooseModel("real"));
	const provider = baseChoice.models.getProvider("openai")!;
	const choice = { ...baseChoice, models: createModels() };
	// Instrument the real HTTP dispatch, including retries. No request body/headers ever enter the log.
	choice.models.setProvider({
		...provider,
		streamSimple(model, transcript, options) {
			let deltas = 0;
			let responseId: string | undefined;
			return provider.streamSimple(model, transcript, {
				...options, maxTokens: MAX_OUTPUT, maxRetries: 0,
				fetch: async (input, init) => {
					const previous = events(dir).filter((event) => event.kind === "request");
					const spent = previous.reduce((n, event) => n + Number(event.reservedUsd), 0);
					// UTF-8 bytes deliberately overestimate input tokens; allow extra framing tokens. Reserve output too,
					// including killed requests whose usage will never arrive. Not an OpenAI invoice measurement.
					const inputAllowance = Buffer.byteLength(String(init?.body ?? "")) + 1024;
					const reservedUsd = (inputAllowance * model.cost.input + MAX_OUTPUT * model.cost.output) / 1e6;
					if (spent + reservedUsd > SPEND_LIMIT) throw new Error("Recovery smoke spend reservation exhausted");
					log("request", { index: previous.length + 1, model: `${model.provider}/${model.id}`,
						effort: options?.reasoning, maxOutputTokens: MAX_OUTPUT, reservedUsd });
					const response = await fetch(input, init);
					log("http", { model: model.id, status: response.status, requestId: response.headers.get("x-request-id") });
					return response;
				},
				onProviderStreamEvent: async (raw) => {
					const event = raw as { type: string; response?: { id?: string; usage?: unknown; status?: string } };
					if (event.type === "response.created") responseId = event.response?.id;
					if (["response.completed", "response.failed", "response.incomplete"].includes(event.type)) {
						log("provider-terminal", { model: model.id, responseId, type: event.type, usage: event.response?.usage });
					}
					const target = (scenario === "A" && model.id === "gpt-6.1-terra") ||
						(scenario === "C" && model.id === "gpt-6.1-sol");
					if (phase !== "kill" || !target || event.type !== "response.output_text.delta" || ++deltas !== 2) return;
					const records = (await storage.scanConversations({}, 100, undefined, context)).items;
					const conversation = records.find((record) => scenario === "A" ? record.owner === undefined : record.owner !== undefined)!;
					const until = Date.now() + 10_000;
					while (!persistedPartials.has(conversation.id) && Date.now() < until) {
						await new Promise((accept) => setTimeout(accept, 20));
					}
					await gate("second real output delta paused; preceding partial stored; no terminal SSE consumed", conversation.id,
						{ responseId, deltaEvents: deltas });
				},
			});
		},
	});
	const instrumentation = defineExtension({
		name: "recovery.instrumentation",
		hooks: [
			hook(GenerationTask, { beforeProviderRequest: ({ payload, model }) => {
				if (model.id !== "gpt-6.1-terra" || scenario === "A") return;
				const body = payload as { input: { type?: string; name?: string }[] };
				const tool = scenario === "B" ? "tally" : "delegate";
				const alreadyCalled = body.input.some((item) => item.type === "function_call" && item.name === tool);
				return { payload: { ...body, parallel_tool_calls: false,
					tool_choice: alreadyCalled ? "auto" : { type: "function", name: tool } } };
			} }),
			hook(ToolTask, { afterTool: async (call, result, api) => {
				log("after-tool", { taskId: api.taskId, name: call.name, result });
				if (phase !== "kill") return;
				if (scenario === "B" && call.name === "tally") {
					await gate("tally increment committed; afterTool paused before tool result commit", api.conversationId);
				}
				if (scenario === "D" && call.name === "delegate") {
					await gate("child submission done; delegate afterTool paused before root result commit", api.conversationId);
				}
			} }),
		],
	});
	const spec = defineHarness({ name: "recovery-smoke", extensions: [...tallyHarness.extensions, helper(), instrumentation] });
	await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
		const root = await shell.harness.root(context);
		if (phase === "kill") {
			const agent = await root.agent(context);
			await root.configure({ modelTools: scenario === "A" ? [] : agent.tools.filter((tool) =>
				tool.name === (scenario === "B" ? "tally" : "delegate")) }, context);
		}
		const ask = () => Effect.runPromise(Effect.result(shell.ask(prompts[scenario], { requestId })));
		const outcome = await ask();
		log("caller", { outcome });
		if (phase === "kill") throw new Error(`${scenario}: boundary was missed; request finished without SIGKILL`);
		await shell.harness.waitForIdle(context);
		const beforeRepeat = events(dir).filter((event) => event.kind === "request").length;
		const repeated = await ask();
		assert.deepEqual(repeated, outcome, "same requestId must return the same caller outcome");
		assert.equal(events(dir).filter((event) => event.kind === "request").length, beforeRepeat);
		log("repeated-request", { outcome: repeated, additionalRequests: 0 });
		log("after", await snapshot());
	})), Shell.layer({ harness: spec, choice, store: join(dir, `${scenario}.sqlite`), create: phase === "kill" })));
}
