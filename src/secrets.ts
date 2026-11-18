// Protect live tool progress before Pi can commit it, then redact tool results in the selected extensions' hooks.
// The shell decorates installed extensions by name, so protection follows their tools through a fork or reconfigure.
// Tools still read credentials from the environment. Encoded values and tool arguments are outside this policy.
import {
	hook, ToolTask, type Extension, type ToolDiagnostic, type ToolExecutionApi, type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { utf8ByteLength } from "@earendil-works/chord/output";
import type { HarnessSpec } from "./harness.ts";

export type Env = { readonly [name: string]: string | undefined };

export const missingSecrets = (spec: HarnessSpec, env: Env): string[] =>
	(spec.secrets ?? []).filter((name) => (env[name] ?? "") === "");

const containsSecret = (text: string, values: readonly string[]) => values.some((value) => text.includes(value));

export function secretProtection(spec: HarnessSpec, env: Env) {
	const marks = new Map<string, string>();
	for (const name of spec.secrets ?? []) {
		const value = env[name];
		if (value && !marks.has(value)) marks.set(value, `[secret ${name}]`);
	}
	const values = [...marks.keys()].sort((a, b) => b.length - a.length);
	if (values.length === 0) return undefined;

	// A named marker can itself contain a short secret or a credential that matches a variable name.
	const safeMark = (mark: string) => !containsSecret(mark, values);
	const fallback = ["[redacted]", "█", ""].find(safeMark)!;
	for (const [value, mark] of marks) if (!safeMark(mark)) marks.set(value, fallback);

	const pattern = new RegExp(values.map((value) => RegExp.escape(value)).join("|"), "g");
	const redact = (text: string): string => {
		const clean = text.replace(pattern, (value) => marks.get(value)!);
		return containsSecret(clean, values) ? "" : clean;
	};
	// Tools can budget a page without knowing the shell's secrets or which afterTool hooks will run.
	const outputMarks = new Map([...marks].map(([value, mark]) => [value,
		[mark, "[redacted]", "*", "?", ""].find((candidate) => !candidate.includes("\n") &&
			utf8ByteLength(candidate) <= utf8ByteLength(value) && safeMark(candidate))!,
	]));
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
		const output = original?.map((part) => {
			if (part.type !== "text") return part;
			const text = part.text.replace(pattern, (value) => outputMarks.get(value)!);
			return text === part.text ? part : { ...part, text };
		});
		const text = (parts: ToolExecutionResult["output"]) =>
			parts?.map((part) => part.type === "text" ? part.text : "").join("") ?? "";
		const rendered = text(output);
		// Pi bounds the joined text. Replacements can create a secret alongside adjacent text or across parts.
		const withhold = containsSecret(rendered, values) || utf8ByteLength(rendered) > utf8ByteLength(text(original));
		return {
			...result,
			// Pi uses the array identity to decide whether to retain its progress truncation diagnostic.
			...(withhold ? { output: output?.filter((part) => part.type !== "text"), isError: true }
				: output?.some((part, index) => part !== original?.[index]) ? { output } : {}),
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
			const stream = redactStream(values, outputMarks, api.output);
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
	const suffixLength = values[0]!.length - 1;
	let pending = "";
	let started = false;
	let withheld = false;
	let suffix = "";
	function scan(text: string, state: "open" | "complete" | "interrupted" = "open") {
		if (withheld) return;
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
						// An incomplete value may be shorter than its marker. Omit it on interruption.
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
		if (safe === "") return;
		// A new match can start in previously emitted text and end in this chunk. Do not emit either the
		// completion or further chunks that could join across the withheld section.
		const joined = suffix + safe;
		if (containsSecret(joined, values)) {
			withheld = true;
			return;
		}
		suffix = suffixLength === 0 ? "" : joined.slice(-suffixLength);
		emit(safe);
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
