// Protect live tool progress before Pi can commit it, then redact tool results in the selected extensions' hooks.
// The shell decorates installed extensions by name, so protection follows their tools through a fork or reconfigure.
// Tools still read credentials from the environment. Encoded values and tool arguments are outside this policy.
import {
	hook, ToolTask, type Extension, type ToolDiagnostic, type ToolExecutionApi, type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { boundOutput, utf8ByteLength } from "@earendil-works/chord/output";
import type { HarnessSpec } from "./harness.ts";

export type Env = { readonly [name: string]: string | undefined };
type ToolOutput = NonNullable<ToolExecutionResult["output"]>;

export const missingSecrets = (spec: HarnessSpec, env: Env): string[] =>
	(spec.secrets ?? []).filter((name) => (env[name] ?? "") === "");

export function secretProtection(spec: HarnessSpec, env: Env) {
	const marks = new Map<string, string>();
	for (const name of spec.secrets ?? []) {
		const value = env[name];
		if (value && !marks.has(value)) marks.set(value, `[secret ${name}]`);
	}
	const values = [...marks.keys()].sort((a, b) => b.length - a.length);
	if (values.length === 0) return undefined;

	// A named marker can itself contain a short secret or a credential that matches a variable name.
	const safeMark = (mark: string) => values.every((value) => !mark.includes(value));
	const fallback = ["[redacted]", "█", ""].find(safeMark)!;
	for (const [value, mark] of marks) if (!safeMark(mark)) marks.set(value, fallback);

	const pattern = new RegExp(values.map((value) => RegExp.escape(value)).join("|"), "g");
	const redact = (text: string): string => text.replace(pattern, (value) => marks.get(value)!);
	const compactMarks = new Map([...marks].map(([value, mark]) => [value,
		[mark, "[redacted]", "█", "*", "?", ""].find((candidate) => !candidate.includes("\n") &&
			utf8ByteLength(candidate) <= utf8ByteLength(value) && safeMark(candidate))!,
	]));
	const compact = (text: string): string => text.replace(pattern, (value) => compactMarks.get(value)!);
	const outputBudgets = new WeakMap<ToolOutput, NonNullable<ToolRegistration["outputLimits"]>>();
	const json = (value: JsonValue): JsonValue => {
		if (typeof value === "string") return redact(value);
		if (Array.isArray(value)) return value.map(json);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), json(item)]));
		}
		return value;
	};
	const diagnostic = (value: ToolDiagnostic): ToolDiagnostic => ({
		...value,
		message: redact(value.message),
		...(value.code === undefined ? {} : { code: redact(value.code) }),
	});
	const afterTool = (_call: unknown, result: ToolExecutionResult): ToolExecutionResult => {
		const original = result.output;
		const redactOutput = (apply: (text: string) => string) => original?.map((part) => {
			if (part.type !== "text") return part;
			const text = apply(part.text);
			return text === part.text ? part : { ...part, text };
		});
		let output = redactOutput(redact);
		const limits = original === undefined ? undefined : outputBudgets.get(original);
		if (original !== undefined && limits !== undefined && output?.some((part, index) => part !== original[index])) {
			const fits = (parts: ToolOutput) => boundOutput(
				parts.map((part) => part.type === "text" ? part.text : "").join(""),
				{ maxBytes: limits.maxBytes ?? Infinity, maxLines: limits.maxLines ?? Infinity, retain: "head" },
			).droppedBytes === 0;
			// A page that already fits must not lose content (including its footer) solely to redaction.
			if (!fits(output) && fits(original)) output = redactOutput(compact);
		}
		return {
			...result,
			// Pi uses the array identity to decide whether to retain its progress truncation diagnostic.
			...(output?.some((part, index) => part !== result.output?.[index]) ? { output } : {}),
			...(result.structuredOutput === undefined ? {} : { structuredOutput: json(result.structuredOutput) }),
			...(result.details === undefined ? {} : { details: json(result.details) }),
			...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics.map(diagnostic) }),
			...(result.control?.handoff === undefined ? {} : {
				control: { ...result.control, handoff: redact(result.control.handoff) },
			}),
		};
	};
	const guardedOutputs = new WeakSet<ToolExecutionApi["output"]>();
	const protectTool = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		execute: async (args, api, context) => {
			// An extension wrapper may call the tool it wraps with the same protected API.
			if (guardedOutputs.has(api.output)) return tool.execute(args, api, context);
			const stream = redactStream(values, marks, api.output);
			guardedOutputs.add(stream.output);
			// Copy own properties for harness wrappers that spread the API, preserving Pi's live getters.
			const protectedApi = Object.defineProperties({}, Object.getOwnPropertyDescriptors(api)) as ToolExecutionApi;
			Object.assign(protectedApi, {
				output: stream.output,
				// A tail skip could remove part of a secret before this wrapper sees it.
				outputWindow: undefined,
				details: ((value, ctx) => api.details(json(value), ctx)) satisfies ToolExecutionApi["details"],
				diagnostic: (value: ToolDiagnostic) => api.diagnostic(diagnostic(value)),
			});
			let completed = false;
			try {
				const result = await tool.execute(args, protectedApi, context);
				completed = true;
				if (result.output !== undefined && tool.outputLimits !== undefined) {
					// Pi passes explicit output through to afterTool by identity, unlike its streamed fallback.
					outputBudgets.set(result.output, tool.outputLimits);
				}
				return result;
			} finally {
				stream.end(!completed || context.abortSignal?.aborted === true);
			}
		},
	});
	return {
		redact,
		protect: (extension: Extension): Extension => ({
			...extension,
			...(extension.tools === undefined ? {} : { tools: extension.tools.map(protectTool) }),
			...(extension.wraps === undefined ? {} : {
				wraps: extension.wraps.map((wrap) => "tool" in wrap
					? { ...wrap, wrap: (tool: ToolRegistration) => protectTool(wrap.wrap(tool)) }
					: wrap),
			}),
			// The final hook follows the extension's own hooks. Whichever extension is selected last also
			// sanitizes errors Pi generates without executing a tool.
			hooks: [...(extension.hooks ?? []), hook(ToolTask, { afterTool })],
		}),
	};
}

// Keep only a possible secret prefix between chunks. Decode bytes incrementally, matching Pi's output buffer
// when a string interrupts bytes or a stream starts with a UTF-8 BOM.
function redactStream(values: readonly string[], marks: ReadonlyMap<string, string>, emit: (text: string) => void) {
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let pending = "";
	let started = false;
	function scan(text: string, state: "open" | "complete" | "interrupted" = "open") {
		pending += text;
		let index = 0;
		let safe = "";
		while (index < pending.length) {
			const match = values.find((value) => pending.startsWith(value, index));
			if (pending.length - index < (values[0]?.length ?? 0)) {
				const suffix = pending.slice(index);
				const partial = values.find((value) => value.length > suffix.length && value.startsWith(suffix));
				if (partial !== undefined) {
					if (state === "open") break;
					if (state === "interrupted") {
						// A shorter value may match the start of a held, longer prefix.
						const value = match?.length === suffix.length ? match : partial;
						safe += marks.get(value)!;
						index = pending.length;
						break;
					}
				}
			}
			if (match === undefined) {
				safe += pending[index++];
			} else {
				safe += marks.get(match)!;
				index += match.length;
			}
		}
		pending = pending.slice(index);
		if (safe !== "") emit(safe);
	}
	return {
		output(chunk: string | Uint8Array, skipped?: Parameters<ToolExecutionApi["output"]>[1]) {
			if (skipped !== undefined) throw new Error("Skipped tool output is unavailable when redacting secrets");
			if (typeof chunk === "string") {
				const text = decoder.decode() + chunk;
				started ||= text !== "";
				scan(text);
			} else {
				let text = decoder.decode(chunk, { stream: true });
				if (!started && text.startsWith("\ufeff")) {
					text = text.slice(1);
					started = true;
				}
				started ||= text !== "";
				scan(text);
			}
		},
		end(interrupted: boolean) {
			// Flush the held prefix before a decoder replacement character can make it look unrelated.
			if (interrupted) scan("", "interrupted");
			scan(decoder.decode(), interrupted ? "interrupted" : "complete");
		},
	};
}
