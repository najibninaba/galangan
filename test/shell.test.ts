// The shell over a real file-backed SQLite store, the example harness and the faux model (no network).
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	type Conversation, defineExtension, defineTool, type Extension, hook, LiveDoc, ResetEntry, ToolResultEntry, ToolTask,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { Effect } from "effect";
import { tallyHarness } from "../examples/tally/tally.ts";
import { chooseModel, chooseThinking, fauxModels, FAUX_MODEL, InvalidModel } from "../src/models.ts";
import { Shell, StoreBackupFailed, StoreIncompatible, StoreLocked, StoreMissing, WRITER } from "../src/shell.ts";

function tempStore(t: TestContext): string {
	const dir = mkdtempSync(join(tmpdir(), "galangan-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "store", "tally.sqlite");
}

const layer = (store: string, create = false) =>
	Shell.layer({ harness: tallyHarness, choice: { models: fauxModels(), model: FAUX_MODEL }, store, create });

/** Opens the shell on `store`, runs `program`, and closes the Harness again. */
const withShell = <A, E>(store: string, program: Effect.Effect<A, E, Shell>, create = false) =>
	Effect.runPromise(Effect.provide(program, layer(store, create)));

const probeLayer = (store: string, extension: Extension, env: Record<string, string> = {}) => Shell.layer({
	harness: { name: "output-test", extensions: [extension], secrets: Object.keys(env) },
	choice: { models: fauxModels(), model: FAUX_MODEL }, store, create: true, env,
});

async function callProbe(root: Conversation, mode: string) {
	const content = `call output_probe ${JSON.stringify({ mode })}`;
	const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
	assert.ok(settled.type === "input" && settled.status === "done");
	const result = (await root.entries({ minEntryId: settled.entry, maxEntryId: settled.answer },
		10, undefined, context)).items.find(ToolResultEntry.is);
	const message = result?.model?.[0];
	assert.ok(result && message?.role === "toolResult" && message.toolName === "output_probe");
	return { message, diagnostics: result.data.diagnostics ?? [] };
}

describe("shell", () => {
	it("answers a message that calls no tool", async (t) => {
		assert.equal(await withShell(tempStore(t), Shell.use((shell) => shell.ask("hello")), true), "ack: hello");
	});

	it("keeps Pi's byte output and tail window when the harness has no secrets", async (t) => {
		const output = defineExtension({
			name: "output-probe",
			tools: [defineTool({
				name: "output_probe",
				description: "Streams UTF-8 bytes",
				parameters: obj({}),
				outputLimits: { retain: "tail" },
				execute: async (_args, api) => {
					assert.ok(api.outputWindow);
					const bytes = new TextEncoder().encode("☕");
					api.output(bytes.subarray(0, 1));
					api.output(bytes.subarray(1));
					return {};
				},
			})],
		});
		const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("call output_probe {}")),
			Shell.layer({
				harness: { name: "output-test", extensions: [output] },
				choice: { models: fauxModels(), model: FAUX_MODEL },
				store: tempStore(t), create: true,
			})));
		assert.equal(answer, "output_probe: ☕");
	});

	it("keeps an in-budget result after an earlier afterTool hook copies it", async (t) => {
		const env = { FIXTURE_TOKEN: "q7!" };
		const body = `${`${env.FIXTURE_TOKEN}:keep|`.repeat(1000)}\nContinue: page 2`;
		const output = defineExtension({
			name: "output-probe",
			hooks: [hook(ToolTask, { afterTool: (_call, result) => ({ ...result, output: [...result.output!] }) })],
			tools: [defineTool({
				name: "output_probe", description: "Return a page at the byte and line limits", parameters: obj({}),
				outputLimits: { maxBytes: Buffer.byteLength(body), maxLines: 2 },
				execute: async () => ({ output: [{ type: "text", text: body }] }),
			})],
		});
		const store = tempStore(t);
		const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("call output_probe {}")),
			Shell.layer({
				harness: { name: "output-test", extensions: [output], secrets: Object.keys(env) },
				choice: { models: fauxModels(), model: FAUX_MODEL }, store, create: true, env,
			})));
		assert.equal(answer, `output_probe: ${"*:keep|".repeat(1000)}\nContinue: page 2`);
		assert.ok(!readFileSync(store).includes(env.FIXTURE_TOKEN));
	});

	it("withholds joined secrets in returned text without changing success or error status", async (t) => {
		const env = { JOINED: "left*righ", SEPARATOR: "X", WARNING: "output_withheld" };
		const output = defineExtension({
			name: "output-probe",
			tools: [defineTool({
				name: "output_probe", description: "Return adjacent text fragments", parameters: obj({ mode: str() }),
				execute: async ({ mode }) => ({
					isError: mode === "failure",
					output: (mode === "failure" ? ["leftXrigh"] : ["kept prefix leftX", "righ ignored"])
						.map((text) => ({ type: "text", text })),
				}),
			})],
		});
		const store = tempStore(t);
		await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
			const root = await shell.harness.root(context);
			for (const mode of ["success", "failure"]) {
				const input = { type: "input", content: `call output_probe ${JSON.stringify({ mode })}` } as const;
				const settled = await (await root.submit(input, context)).wait(context);
				assert.ok(settled.type === "input" && settled.status === "done");
				const result = (await root.entries({ minEntryId: settled.entry, maxEntryId: settled.answer },
					10, undefined, context)).items.find(ToolResultEntry.is);
				const message = result?.model?.[0];
				assert.ok(message?.role === "toolResult");
				assert.equal(message.isError, mode === "failure");
				assert.equal(message.content.slice(0, -1).map((part) => part.type === "text" ? part.text : "").join(""),
					mode === "failure" ? "" : "kept prefix ");
				assert.deepEqual(result?.data.diagnostics, [{ severity: "warn", code: "[secret WARNING]",
					message: "Some tool output was withheld to protect declared secrets." }]);
			}
		})), Shell.layer({
			harness: { name: "output-test", extensions: [output], secrets: Object.keys(env) },
			choice: { models: fauxModels(), model: FAUX_MODEL }, store, create: true, env,
		})));
		assert.ok(!readFileSync(store).includes(env.JOINED));
	});

	it("checks Responses output after LF joins, compact marks, and deletion of lone surrogates", async (t) => {
		const receipt = "SAFE RECEIPT: 42.";
		const shifted = `\ud800${receipt}\udc00`;
		const parts = new Map([
			["raw", [receipt, "one", "two\ud800three"]],
			["shifted", [shifted, "one", "two\ud800three"]],
			["warning", [receipt, "held tail", "one", "two\ud800three"]],
			["masked", ["leftX", "r\udc00ight"]],
			["safe", ["keep", "two\ud800 parts"]],
		]);
		const env = {
			JOINED: "one\ntwothree", MASKED: "left*\nright", SHORT: "X", WARNING_JOIN: "held tail\n<harness>",
			SIGNATURE: "opaque-fixture-signature",
		};
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Return fragments", parameters: obj({ mode: str() }),
			execute: async ({ mode }) => ({ output: parts.get(mode)!.map((text) => ({
				type: "text", text, textSignature: env.SIGNATURE,
			})) }),
		})] });
		const choice = await Effect.runPromise(chooseModel("real"));
		const model = choice.models.getModel(choice.model.provider, choice.model.modelId);
		assert.ok(model?.api === "openai-responses");
		for (const protectedEnv of [{}, env]) {
			const active = protectedEnv === env;
			const store = tempStore(t);
			await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
				const root = await shell.harness.root(context);
				const controls = {
					raw: `${receipt}\n${env.JOINED}`, shifted: `${receipt}\n${env.JOINED}`,
					warning: `${receipt}\nheld tail\n${env.JOINED}`,
					masked: "leftX\nright", safe: "keep\ntwo parts",
				};
				for (const [mode, control] of Object.entries(controls)) {
					const { message, diagnostics } = await callProbe(root, mode);
					const transcript = normalizeContext({ messages: [...(await root.context(context)).messages] });
					const wire: unknown = convertResponsesMessages(model, transcript, new Set(["openai"]))
						.findLast((item) => item.type === "function_call_output")?.output;
					assert.ok(typeof wire === "string");
					if (!active || mode === "safe") assert.equal(wire, control);
					else {
						assert.match(wire, /\[warn\] Some tool output was withheld/);
						assert.equal(diagnostics[0]?.code, "output_withheld");
						assert.ok(!message.isError);
						if (mode !== "masked") {
							const retained = mode === "shifted" ? shifted : receipt;
							assert.deepEqual(message.content.slice(0, -1), [{ type: "text", text: retained }], mode);
							assert.ok(wire.startsWith(`${receipt}\n<harness>\n`), mode);
						}
					}
					if (active) {
						for (const value of [env.JOINED, env.MASKED, env.WARNING_JOIN]) assert.ok(!wire.includes(value));
						assert.ok(message.content.every((part) => part.type !== "text" || part.textSignature === undefined));
					}
				}
			})), probeLayer(store, output, protectedEnv)));
			if (active) assert.ok(!readFileSync(store).includes(env.SIGNATURE));
		}
	});

	it("keeps the longest safe multipart prefix when shorter prefixes collide with the warning", async (t) => {
		const retained = ["held tail", "SAFE RECEIPT: 42."];
		const warning = {
			severity: "warn", code: "output_withheld", message: "Some tool output was withheld to protect declared secrets.",
		} as const;
		const env = {
			JOINED: "one\ntwo", WARNING_JOIN: "held tail\n<harness>", FRAMED: "SAFE RECEIPT: 42.\nlate part\n<harness>",
		};
		const parts = new Map([
			["control", retained],
			["collision", [...retained, "held tail", "held tail", "one", "two"]],
			["framed", [...retained, "late part"]],
		]);
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Return a receipt between warning collisions", parameters: obj({ mode: str() }),
			execute: async ({ mode }) => ({
				output: parts.get(mode)!.map((text) => ({ type: "text" as const, text })),
				...(mode === "collision" ? {} : { diagnostics: [warning] }),
			}),
		})] });
		const choice = await Effect.runPromise(chooseModel("real"));
		const model = choice.models.getModel(choice.model.provider, choice.model.modelId);
		assert.ok(model?.api === "openai-responses");
		await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
			const root = await shell.harness.root(context);
			for (const mode of parts.keys()) {
				const { message, diagnostics } = await callProbe(root, mode);
				assert.equal(message.isError, false, mode);
				assert.deepEqual(diagnostics, [warning], mode);
				assert.deepEqual(message.content.slice(0, -1), retained.map((text) => ({ type: "text", text })), mode);
				const transcript = normalizeContext({ messages: [...(await root.context(context)).messages] });
				const wire: unknown = convertResponsesMessages(model, transcript, new Set(["openai"]))
					.findLast((item) => item.type === "function_call_output")?.output;
				assert.equal(wire, `${retained.join("\n")}\n<harness>\n[warn] ${warning.message}\n</harness>`, mode);
			}
		})), probeLayer(tempStore(t), output, env)));
	});

	it("redacts handoffs that would expose a value in a formatted Responses user message", async (t) => {
		const env = { JOINED: "fixture-joined", EXACT: "fixture-exact", MASKED: "[secret EXACT]suffix" };
		const handoffs = new Map([
			["joined", ["Continue with fixture-\ud800joined.", "Continue with [secret JOINED]."]],
			["exact", ["Continue with fixture-exact.", "Continue with [secret EXACT]."]],
			["masked", ["Continue with fixture-exact\udc00suffix.", "Continue with [secret MASKED]."]],
		]);
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Hand off to a new context", parameters: obj({ mode: str() }),
			execute: async ({ mode }) => ({ control: { handoff: handoffs.get(mode)![0]! } }),
		})] });
		const choice = await Effect.runPromise(chooseModel("real"));
		const model = choice.models.getModel(choice.model.provider, choice.model.modelId);
		assert.ok(model?.api === "openai-responses");
		await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
			const root = await shell.harness.root(context);
			for (const [mode, [, expected]] of handoffs) {
				const content = `call output_probe ${JSON.stringify({ mode })}`;
				const settled = await (await root.submit({ type: "input", content }, context)).wait(context);
				assert.ok(settled.type === "input" && settled.status === "done");
				const reset = (await root.entries({ minEntryId: settled.entry, maxEntryId: settled.answer },
					10, undefined, context)).items.find(ResetEntry.is)?.model?.[0];
				const transcript = normalizeContext({ messages: [...(await root.context(context)).messages] });
				const wire: ReturnType<typeof convertResponsesMessages> =
					convertResponsesMessages(model, transcript, new Set(["openai"]));
				assert.ok(!wire.some((item) => item.type === "function_call_output"), mode);
				const user = wire.findLast((item) => "role" in item && item.role === "user");
				assert.deepEqual(user, { role: "user", content: [{ type: "input_text", text: expected }] }, mode);
				assert.ok(reset?.role === "user", mode);
				assert.equal(reset.content, expected, mode);
			}
		})), probeLayer(tempStore(t), output, env)));
	});

	it("checks the formatted provider payload after Pi appends a truncation diagnostic", async (t) => {
		const env = { WINDOW_JOIN: "receipt\n<harness>" };
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Return more than the tool limit", parameters: obj({}),
			outputLimits: { maxBytes: 7 },
			execute: async () => ({ output: [{ type: "text", text: "receipt-more" }] }),
		})] });
		const faux = fauxProvider({ api: "openai-responses" });
		const models = createModels();
		models.setProvider(faux.provider);
		type Input = ReturnType<typeof convertResponsesMessages>;
		const text = (input: Input) => input.findLast((item) => item.type === "function_call_output")?.output;
		let formatted: unknown;
		let outgoing: unknown;
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("output_probe", {}), { stopReason: "toolUse" }),
			async (messages, options, _state, model) => {
				const input = convertResponsesMessages(model, messages, new Set([model.provider]));
				formatted = text(input);
				const next = await options?.onPayload?.({ input }, model) as { input: Input } | undefined;
				outgoing = text(next?.input ?? input);
				return fauxAssistantMessage("done");
			},
		]);
		const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("check the output window")),
			Shell.layer({ harness: { name: "output-test", extensions: [output], secrets: Object.keys(env) },
				store: tempStore(t), create: true, env, choice: { models, model: FAUX_MODEL } })));
		assert.equal(answer, "done");
		assert.ok(typeof formatted === "string" && formatted.startsWith(env.WINDOW_JOIN));
		assert.match(formatted, /Output truncated/);
		assert.equal(outgoing, "Output withheld");
	});

	it("keeps framed diagnostics and thrown errors safe and nonblank in stored tool results", async (t) => {
		const env = { FRAMED: "[error] receipt denied", BOUNDARY: "receipt\n<harness>", A: "fixture-a", B: "[secret A]!" };
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Report a fixture diagnostic", parameters: obj({ mode: str() }),
			execute: async ({ mode }) => {
				if (mode === "throw") throw new Error("fixture-a! expected a receipt");
				if (mode === "boundary") return { output: [{ type: "text", text: "receipt" }],
					diagnostics: [{ severity: "info", message: "on hold" }] };
				return { isError: true, diagnostics: [{ severity: "error", message: "receipt denied" }] };
			},
		})] });
		await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
			const root = await shell.harness.root(context);
			for (const mode of ["frame", "boundary", "throw"]) {
				const { message, diagnostics } = await callProbe(root, mode);
				assert.equal(message.isError, mode !== "boundary");
				const stored = message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
				for (const value of Object.values(env)) assert.ok(!stored.includes(value));
				assert.match(stored, /\[warn\] Some tool output was withheld/);
				assert.ok(diagnostics.every(({ message }) => message.trim() !== ""));
				if (mode === "throw") assert.equal(diagnostics.find(({ severity }) => severity === "error")?.code, "tool_error");
			}
		})), probeLayer(tempStore(t), output, env)));
	});

	it("checks the LF-joined error summaries Pi persists for nested calls", { timeout: 10_000 }, async (t) => {
		const env = { JOINED: "first\nsecond", CLIPPED: "tip�" };
		const ready = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const output = defineExtension({ name: "output-probe", tools: [
			defineTool({ name: "parent_probe", description: "Call nested tools", parameters: obj({}),
				execute: async (_args, api, ctx) => {
					for (const mode of ["joined", "clipped", "output", "safe"]) await api.executeTool("output_probe", { mode }, ctx);
					ready.resolve();
					await release.promise;
					return {};
				},
			}),
			defineTool({ name: "output_probe", description: "Fail a nested call", parameters: obj({ mode: str() }),
				execute: async ({ mode }) => {
					if (mode === "output") return { isError: true,
						output: ["first", "second"].map((text) => ({ type: "text", text })) };
					const messages = mode === "joined" ? ["first", "second"]
						: mode === "clipped" ? [`${"a".repeat(496)}tip🧭`] : ["original error"];
					return { isError: true, diagnostics: messages.map((message) => ({ severity: "error", message })) };
				},
			}),
		] });
		const store = tempStore(t);
		await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
			const root = await shell.harness.root(context);
			const submission = await root.submit({ type: "input", content: "call parent_probe {}" }, context);
			try {
				await ready.promise;
				const slots = (await shell.harness.snapshot(LiveDoc, root.id, context))?.nestedTools ?? [];
				assert.equal(slots.length, 4);
				for (const slot of slots) {
					assert.ok(slot.summary?.isError);
					const summary = slot.summary.error ?? "";
					assert.ok(!summary.includes(env.JOINED) && !summary.toWellFormed().includes(env.CLIPPED));
					if (slot.arguments.mode === "safe") assert.equal(summary, "original error");
				}
			} finally {
				release.resolve();
			}
			assert.equal((await submission.wait(context)).status, "done");
		})), probeLayer(store, output, env)));
	});

	it("guards normalized live output and the WAL across chunk boundaries", { timeout: 10_000 }, async (t) => {
		const env = { JOINED: "leftrigh", SEPARATOR: "X", STAR: "*", QUESTION: "?" };
		const witness = "test-progress-in-wal";
		for (const mode of ["whole", "split", "interrupted"]) {
			const store = tempStore(t);
			const ready = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const content = "call output_probe {}";
			const requestId = "live-redaction";
			let executions = 0;
			const output = defineExtension({
				name: "output-probe",
				tools: [defineTool({
					name: "output_probe", description: "Stream text and terminal escapes", parameters: obj({}),
					execute: async (_args, api, ctx) => {
						if (++executions > 1) return { output: [{ type: "text", text: "ran twice" }] };
						if (mode === "whole") api.output("kept prefix leftX\x1b[0mrigh ignored");
						else if (mode === "interrupted") api.output("kept prefix le\x1b[31mftX");
						else for (const chunk of ["\x1b[3", "1mkept prefix leftX", "\x1b[", "0m\x00righ ignored"]) {
							api.output(chunk);
						}
						await api.details({ witness }, ctx);
						// Pi flushes deferred progress when a durable commit consumes the live document.
						await api.commit(async (tx) => {
							await tx.doc(LiveDoc, api.conversationId);
							await tx.appendEntry(api.conversationId, { kind: "fixture.passive" });
						}, ctx);
						if (mode === "interrupted") await new Promise<never>((_, reject) => {
							ctx.abortSignal!.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
							ready.resolve();
						});
						ready.resolve();
						await release.promise;
						api.output("this tail must not appear");
						return {};
					},
				})],
			});
			await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
				const root = await shell.harness.root(context);
				const submission = await root.submit({ type: "input", content, requestId }, context);
				try {
					await ready.promise;
					const slot = (await shell.harness.snapshot(LiveDoc, root.id, context))?.tools?.[0];
					assert.equal(slot?.output, "kept prefix ");
					assert.equal(slot?.diagnostics?.[0]?.code, "output_withheld");
					const wal = readFileSync(`${store}-wal`);
					assert.ok(wal.includes(witness), "the active progress snapshot reached the WAL");
					assert.ok(!wal.includes("kept prefix left"), "a held partial value never reached the WAL");
					assert.ok(!wal.includes(env.JOINED) && !readFileSync(store).includes(env.JOINED));
				} finally {
					release.resolve();
				}
				if (mode === "interrupted") return;
				const settled = await submission.wait(context);
				assert.ok(settled.type === "input" && settled.status === "done");
				const result = (await root.entries({ minEntryId: settled.entry, maxEntryId: settled.answer },
					10, undefined, context)).items.find(ToolResultEntry.is);
				const message = result?.model?.[0];
				assert.ok(message?.role === "toolResult" && !message.isError);
				assert.doesNotMatch(JSON.stringify(message.content), /leftrigh|ignored|this tail/);
				assert.deepEqual(result?.data.diagnostics?.map(({ code }) => code), ["output_withheld"]);
			})), probeLayer(store, output, env)));
			if (mode === "interrupted") {
				const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask(content, { requestId })),
					probeLayer(store, output, env)));
				assert.match(answer, /output_probe failed: kept prefix .*was interrupted/s);
				assert.doesNotMatch(answer, /kept prefix left/);
				assert.equal(executions, 1);
			}
			assert.ok(!readFileSync(store).includes(env.JOINED));
		}
	});

	it("never unmasks hidden terminal text in retained or final output", async (t) => {
		const env = { INSIDE_ESCAPE: "Pfixture" };
		const captures: Array<{ text: string; truncated: boolean }> = [];
		const output = defineExtension({ name: "output-probe", tools: [defineTool({
			name: "output_probe", description: "Stream a hidden terminal caption and a status", parameters: obj({ mode: str() }),
			execute: async ({ mode }, api) => {
				const caption = "\x1bPfixtureCAPTION\x07ready";
				for (const chunk of mode === "whole" ? [caption] : [caption.slice(0, 4), caption.slice(4)]) api.output(chunk);
				captures.push(api.retainedOutput());
				return {};
			},
		})] });
		for (const protectedEnv of [{}, env]) {
			await Effect.runPromise(Effect.provide(Shell.use((shell) => Effect.promise(async () => {
				const root = await shell.harness.root(context);
				for (const mode of ["whole", "split"]) {
					const { message, diagnostics } = await callProbe(root, mode);
					assert.ok(!message.isError);
					assert.deepEqual(diagnostics, []);
					assert.deepEqual(message.content, [{ type: "text", text: "ready" }]);
					const retained = captures.pop()!;
					assert.deepEqual(retained, { text: "ready", truncated: false });
					assert.equal(Buffer.byteLength(retained.text), 5);
				}
			})), probeLayer(tempStore(t), output, protectedEnv)));
		}
	});

	it("refuses a missing store unless asked to create it, and creates nothing", async (t) => {
		const store = tempStore(t);
		const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
		assert.ok(error instanceof StoreMissing);
		assert.equal(error.store, store);
		assert.equal(existsSync(store), false);
	});

	it("refuses a second shell on an open store at once, and opens it again after the first closes", async (t) => {
		const store = tempStore(t);
		const second = await withShell(store, Effect.gen(function* () {
			yield* (yield* Shell).ask('call tally {"label":"cups"}');
			const started = Date.now();
			const error = yield* Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store)));
			return { error, ms: Date.now() - started };
		}), true);
		assert.ok(second.error instanceof StoreLocked);
		// chord's default busy timeout would make this about 5 s.
		assert.ok(second.ms < 1000, `refused after ${second.ms} ms`);
		assert.equal(await withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}'))), "tally: cups = 2");
	});

	it("applies model and effort changes to an existing root before its next generation", async (t) => {
		const store = tempStore(t);
		await withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}')), true);
		const faux = fauxProvider({ models: [{ id: "replacement", reasoning: true }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([(context, options, _state, model) => {
			assert.equal(model.id, "replacement");
			assert.equal(options?.reasoning, "high");
			assert.ok(context.messages.some((message) => message.role === "toolResult"));
			return fauxAssistantMessage("new model, preserved history");
		}]);
		await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("hello again")), Shell.layer({
			harness: tallyHarness, store,
			choice: { models, model: { provider: "faux", modelId: "replacement" }, thinkingLevel: "high" },
		})));
		// Changing effort alone must also replace the persisted value, not just print a new banner.
		faux.setResponses([(_context, options) => {
			assert.equal(options?.reasoning, "low");
			return fauxAssistantMessage("lower effort");
		}]);
		const answer = await Effect.runPromise(Effect.provide(Shell.use((shell) => shell.ask("one more")), Shell.layer({
			harness: tallyHarness, store,
			choice: { models, model: { provider: "faux", modelId: "replacement" }, thinkingLevel: "low" },
		})));
		assert.equal(answer, "lower effort");
	});
});

/** Runs `sql` on a closed store, as an older or newer build would have left it. */
const tamper = (store: string, sql: string) => {
	const db = new DatabaseSync(store);
	db.exec(sql);
	db.close();
};
const read = (store: string, sql: string) => {
	const db = new DatabaseSync(store, { readOnly: true });
	const row = db.prepare(sql).get();
	db.close();
	return row;
};
const backups = (store: string) => readdirSync(dirname(store)).filter((file) => file.endsWith(".bak"));
const tally = (store: string) => withShell(store, Shell.use((shell) => shell.ask('call tally {"label":"cups"}')));

describe("store stamp", () => {
	it("stamps the version in package.json and the installed Pi", () => {
		const pkg = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")).version;
		assert.deepEqual(WRITER, {
			galangan: pkg("../package.json"),
			pi: pkg("../node_modules/@earendil-works/pi-durable/package.json"),
		});
	});

	it("records the writer and every extension's format on a new store, and backs up nothing", async (t) => {
		const store = tempStore(t);
		await withShell(store, Effect.void, true);
		assert.equal(await tally(store), "tally: cups = 1");
		assert.deepEqual({ ...read(store, "SELECT galangan, pi, formats FROM galangan_store") },
			{ ...WRITER, formats: '{"tally":0}' });
		assert.deepEqual(backups(store), []);
	});

	it("refuses a store from a newer or unreadable writer or a newer schema, and leaves it alone", async (t) => {
		const [major, minor, patch = 0] = WRITER.galangan.split(".").map(Number);
		const nextRc = `${major}.${minor}.${patch + 1}-rc.1`;
		const cases = [
			["UPDATE galangan_store SET galangan = '0.10.0'", /written by Galangan 0\.10\.0 on Pi .*, newer than this/],
			["UPDATE galangan_store SET pi = '1.15.0'", /on Pi 1\.15\.0 \(schema 2\), newer than this/],
			// A pre-release of the next patch is still newer than this release.
			[`UPDATE galangan_store SET galangan = '${nextRc}'`, /-rc\.1 on Pi .*newer/],
			["DROP TABLE galangan_store; UPDATE durable_schema SET version = 3", /unstamped writer \(schema 3\), newer/],
			["UPDATE galangan_store SET galangan = 'v9'", /has a stamp this Galangan .* cannot read \(Galangan v9/],
			["UPDATE galangan_store SET formats = 'null'", /cannot read .*formats null/],
		] as const;
		for (const [sql, written] of cases) {
			const store = tempStore(t);
			await withShell(store, Effect.void, true);
			tamper(store, sql);
			const before = readFileSync(store);
			const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
			assert.ok(error instanceof StoreIncompatible, sql);
			assert.match(error.message, written);
			const self = `this Galangan ${WRITER.galangan} on Pi ${WRITER.pi} \\(schema 2\\)`;
			assert.match(error.message, new RegExp(self));
			assert.deepEqual(readFileSync(store), before, sql);
			assert.deepEqual(backups(store), [], sql);
		}
	});

	it("backs up a store before an open that migrates its schema or restamps an older writer", async (t) => {
		const rc = `${WRITER.galangan}-rc.1`;
		const cases = [
			["UPDATE durable_schema SET version = 1", { version: 1, galangan: WRITER.galangan }],
			["UPDATE galangan_store SET galangan = '0.0.9'", { version: 2, galangan: "0.0.9" }],
			// A pre-release sorts below its release, so the release upgrades it.
			[`UPDATE galangan_store SET galangan = '${rc}'`, { version: 2, galangan: rc }],
		] as const;
		for (const [sql, was] of cases) {
			const store = tempStore(t);
			await withShell(store, Effect.void, true);
			assert.equal(await tally(store), "tally: cups = 1");
			tamper(store, sql);
			assert.equal(await tally(store), "tally: cups = 2", sql);
			const [backup, ...more] = backups(store);
			assert.ok(backup !== undefined && more.length === 0, sql);
			assert.match(backup, /^tally\.sqlite\.\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d\.\d{3}Z\.bak$/);
			// The copy is the store as it was before this open: the old schema or stamp, and the count before it.
			const copy = join(dirname(store), backup);
			assert.deepEqual({ ...read(copy, "SELECT version, galangan FROM durable_schema, galangan_store") }, was);
			const restored = tempStore(t);
			mkdirSync(dirname(restored));
			copyFileSync(copy, restored);
			assert.equal(await tally(restored), "tally: cups = 2", sql);
			assert.deepEqual({ ...read(store, "SELECT version, galangan FROM durable_schema, galangan_store") },
				{ version: 2, galangan: WRITER.galangan });
			// Upgraded now, so the next open backs up nothing more.
			assert.equal(await tally(store), "tally: cups = 3");
			assert.equal(backups(store).length, 1);
		}
	});

	it("refuses to upgrade a store it could not back up, and leaves no partial copy", async (t) => {
		const store = tempStore(t);
		await withShell(store, Effect.void, true);
		assert.equal(await tally(store), "tally: cups = 1");
		tamper(store, "UPDATE galangan_store SET galangan = '0.0.9'");
		const before = readFileSync(store);
		// Pin the backup's timestamp and put a non-empty directory where it goes, so the copy cannot be moved there.
		const now = "2026-01-02T03:04:05.678Z";
		const backup = `${store}.2026-01-02T03-04-05.678Z.bak`;
		mkdirSync(join(backup, "taken"), { recursive: true });
		const clock = t.mock.method(Date.prototype, "toISOString", () => now);
		const error = await Effect.runPromise(Effect.flip(Effect.provide(Shell.use(Effect.succeed), layer(store))));
		clock.mock.restore();
		assert.ok(error instanceof StoreBackupFailed);
		assert.equal(error.backup, backup);
		assert.deepEqual(readFileSync(store), before);
		assert.deepEqual(readdirSync(dirname(store)).filter((file) => file.endsWith(".tmp")), []);
		// Nothing was retried or half-done: with the way clear, the next open backs up once and upgrades.
		rmSync(backup, { recursive: true });
		assert.equal(await tally(store), "tally: cups = 2");
		assert.equal(backups(store).length, 1);
	});

	it("refuses a store written with another kit format, naming both and the wipe step", async (t) => {
		const extra = defineExtension({ name: "extra" });
		/** Opens and closes `store`, returning the error when the open fails. */
		const open = (store: string, formats?: { readonly [extension: string]: number }, extensions = [extra]) =>
			Effect.runPromise(Effect.match(Effect.provide(Effect.void, Shell.layer({
				harness: { ...tallyHarness, extensions: [...tallyHarness.extensions, ...extensions], formats },
				choice: { models: fauxModels(), model: FAUX_MODEL },
				store,
				create: true,
			})), { onSuccess: () => undefined, onFailure: (error) => error }));
		const refused = async (store: string, formats: { readonly [extension: string]: number } | undefined, was: number,
			now: number) => {
			const before = readFileSync(store);
			const error = await open(store, formats);
			assert.ok(error instanceof StoreIncompatible, JSON.stringify(formats));
			assert.match(error.message, new RegExp(`has tally format ${was}, and this build uses tally format ${now}, `
				+ "which does not migrate; .*--init"));
			assert.deepEqual(readFileSync(store), before);
			assert.deepEqual(backups(store), []);
		};

		const store = tempStore(t);
		assert.equal(await open(store, { tally: 1 }, []), undefined);
		await refused(store, { tally: 2 }, 1, 2);
		// Dropping the declaration is a format change too (back to 0), not a way around the check.
		await refused(store, undefined, 1, 0);
		// An extension new to the store has written nothing, so it may start at any format.
		assert.equal(await open(store, { tally: 1, extra: 3 }), undefined);
		assert.deepEqual({ ...read(store, "SELECT formats FROM galangan_store") }, { formats: '{"tally":1,"extra":3}' });

		// A store whose extension wrote before it declared a format has format 0 on record, so declaring one later is
		// refused rather than reading the old docs as empty. So is a store from before stamps.
		const undeclared = tempStore(t);
		await withShell(undeclared, Effect.void, true);
		await refused(undeclared, { tally: 2 }, 0, 2);
		tamper(undeclared, "DROP TABLE galangan_store");
		await refused(undeclared, { tally: 2 }, 0, 2);
	});
});

describe("chooseModel", () => {
	it("defaults to the faux model", async () => {
		assert.deepEqual((await Effect.runPromise(chooseModel())).model, FAUX_MODEL);
	});

	it("defaults to supported effort and identifies the source of explicitly unsupported levels", async () => {
		const faux = fauxProvider({ models: [{ id: "reasoner", reasoning: true }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const choice = { models, model: { provider: "faux", modelId: "reasoner" } };
		assert.equal(await Effect.runPromise(chooseThinking(choice)), "medium");
		assert.equal(await Effect.runPromise(chooseThinking(choice, "high")), "high");
		for (const level of ["xhigh", "typo", ""]) {
			const error = await Effect.runPromise(Effect.flip(chooseThinking(choice, level)));
			assert.ok(error instanceof InvalidModel);
			assert.match(error.message, /GALANGAN_THINKING/);
		}
		const error = await Effect.runPromise(Effect.flip(chooseThinking({ ...choice, thinkingLevel: "xhigh" })));
		assert.match(error.message, /choice.thinkingLevel/);
		assert.doesNotMatch(error.message, /GALANGAN_THINKING/);
		assert.ok(await Effect.runPromise(Effect.flip(chooseModel("faux", "medium"))) instanceof InvalidModel);
		// Catalog-only validation: no authentication or network. Sol cannot run with Pi's old default of off.
		models.setProvider(openaiProvider());
		const sol = { models, model: { provider: "openai", modelId: "gpt-6.1-sol" } };
		assert.ok(await Effect.runPromise(Effect.flip(chooseThinking(sol, "off"))) instanceof InvalidModel);
		assert.equal(await Effect.runPromise(chooseThinking(sol, "high")), "high");
		// Includes off/high/max and high-only reasoners; medium must never be an implicit configuration error.
		const { builtinProviders } = await import("@earendil-works/pi-ai/providers/all");
		for (const provider of builtinProviders()) {
			models.setProvider(provider);
			for (const model of provider.getModels()) {
				const choice = { models, model: { provider: provider.id, modelId: model.id } };
				const selected = await Effect.runPromise(chooseThinking(choice));
				assert.ok(getSupportedThinkingLevels(model).includes(selected),
					`${provider.id}/${model.id}: ${selected}`);
			}
		}
	});

	it("refuses a spec without a provider and model", async () => {
		for (const spec of ["claude", "/m", "anthropic/"]) {
			const error = await Effect.runPromise(Effect.flip(chooseModel(spec)));
			assert.ok(error instanceof InvalidModel, spec);
		}
	});
});
