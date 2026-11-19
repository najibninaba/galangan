// Protect live tool progress before Pi can commit it, then redact tool results in the selected extensions' hooks.
// The shell decorates installed extensions by name, so protection follows their tools through a fork or reconfigure.
// Tools still read credentials from the environment. Encoded values and tool arguments are outside this policy.
import {
	GenerationTask, hook, ToolTask, type Extension, type GenerationHooks, type ToolDiagnostic,
	type ToolExecutionApi, type ToolExecutionResult, type ToolHookCall, type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { sanitizeSurrogates } from "@earendil-works/pi-ai/utils/sanitize-unicode";
import type { JsonValue } from "@earendil-works/chord/json";
import { boundOutput, sanitizeOutput, utf8ByteLength } from "@earendil-works/chord/output";
import type { HarnessSpec } from "./harness.ts";
import { toolTextPolicy } from "./tool-output.ts";

export type Env = { readonly [name: string]: string | undefined };

export const missingSecrets = (spec: HarnessSpec, env: Env): string[] =>
	(spec.secrets ?? []).filter((name) => (env[name] ?? "") === "");

const outputWithheld = {
	severity: "warn", code: "output_withheld", message: "Some tool output was withheld to protect declared secrets.",
} as const satisfies ToolDiagnostic;

// Pi 1.5.2 adds this as a separate model text part after afterTool; nested calls store a different projection.
const renderDiagnostics = (diagnostics: readonly ToolDiagnostic[]) =>
	`<harness>\n${diagnostics.map(({ severity, message }) => `[${severity}] ${message}`).join("\n")}\n</harness>`;

// A match can start or end inside a surrogate pair. Its marginal UTF-8 cost at that boundary is one byte, not three.
const byteBudget = (text: string) => utf8ByteLength(text)
	- (/^[\udc00-\udfff]/.test(text) ? 2 : 0) - (/[\ud800-\udbff]$/.test(text) ? 2 : 0);

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

	const exact = (strings: readonly string[]) => new RegExp(strings.map(RegExp.escape).join("|"), "g");
	const pattern = exact(values);
	const safeLength = (text: string, match = pattern): number => {
		// Pi can round-trip a clipped window through UTF-8. Check that spelling too without changing intact output.
		const raw = text.search(match);
		const encoded = text.isWellFormed() ? -1 : text.toWellFormed().search(match);
		const end = Math.min(raw === -1 ? text.length : raw, encoded === -1 ? text.length : encoded);
		return (text.codePointAt(end - 1) ?? 0) > 0xffff ? end - 1 : end;
	};
	const formattedSafeLength = (text: string): number => {
		const keep = safeLength(text);
		if (keep === 0 || text.isWellFormed()) return keep;
		let index = sanitizeSurrogates(text).search(pattern);
		if (index === -1) return keep;
		// Responses deletes lone surrogates. Map the match back to the original text without splitting a pair.
		let offset = 0;
		for (const char of text) {
			if (char.isWellFormed()) {
				if (index < char.length) break;
				index -= char.length;
			}
			offset += char.length;
		}
		return Math.min(keep, offset);
	};
	const exposesSecret = (text: string): boolean => formattedSafeLength(text) < text.length;
	const redact = (text: string, withhold?: () => void): string => {
		const masked = text.replace(pattern, (value) => {
			const mark = marks.get(value)!;
			if (mark === "") withhold?.();
			return mark;
		});
		const keep = safeLength(masked);
		if (keep < masked.length) withhold?.();
		return masked.slice(0, keep);
	};
	const outputMark = (named: string, bytes: number, safe: (mark: string) => boolean) =>
		[named, "[redacted]", "*", "?", ""].find((mark) => utf8ByteLength(mark) <= bytes &&
			!mark.includes("\n") && mark.isWellFormed() && sanitizeOutput(mark) === mark && safe(mark))!;
	const compactMarks = new Map(values.map((value) => [value, outputMark(marks.get(value)!, byteBudget(value), safeMark)]));
	// Keep protecting the visible spelling of a declared value containing controls that Chord strips.
	const streamNames = new Map(marks);
	for (const value of values) {
		const visible = sanitizeOutput(value).toWellFormed();
		if (visible !== "" && !streamNames.has(visible)) streamNames.set(visible, marks.get(value)!);
	}
	const streamValues = [...streamNames.keys()].sort((a, b) => b.length - a.length);
	const streamPattern = exact(streamValues);
	const streamMark = (value: string, bytes: number) =>
		outputMark(streamNames.get(value)!, bytes, (mark) => safeLength(mark, streamPattern) === mark.length);
	const streamMarks = new Map(streamValues.map((value) => [value, streamMark(value, byteBudget(value))]));
	const compact = (text: string, withhold: () => void) => text.replace(pattern, (value) => {
		const mark = compactMarks.get(value)!;
		if (mark === "") withhold();
		return mark;
	});
	const json = (value: JsonValue): JsonValue => {
		if (typeof value === "string") return redact(value);
		if (Array.isArray(value)) return value.map(json);
		if (value !== null && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), json(item)]));
		}
		return value;
	};
	// The warning must be readable even if its usual wording contains a declared value. No fixed character is safe
	// for all configurations, so the final fallback picks one that does not occur in any of the declared values.
	const notice = (candidates: string[]) => {
		const message = candidates.find((text) => !exposesSecret(text));
		if (message !== undefined) return message;
		for (let code = 0xe000; code <= 0x10ffff; code++) {
			const mark = String.fromCodePoint(code);
			if (values.every((value) => !value.includes(mark))) return mark;
		}
		return "";
	};
	const hidden = notice(["[redacted]", "Redacted.", "█"]);
	const redactHandoff = (text: string) => {
		// Pi stores the handoff as a reset user message, outside the final Responses tool-output guard.
		let masked = redact(text);
		if (exposesSecret(masked)) masked = redact(sanitizeSurrogates(masked));
		return exposesSecret(masked) || (text.trim() !== "" && masked.trim() === "") ? hidden : masked;
	};
	const warnings = [outputWithheld.message, "Tool output withheld.", hidden];
	const warning: ToolDiagnostic = {
		...outputWithheld,
		code: redact(outputWithheld.code),
		message: warnings.find((message) => !exposesSecret(renderDiagnostics([{ ...outputWithheld, message }]))) ?? notice(warnings),
	};
	const diagnostic = (value: ToolDiagnostic, withhold: () => void): ToolDiagnostic => {
		let message = redact(value.message, withhold);
		if ((value.message.trim() !== "" && message.trim() === "") || exposesSecret(message)) {
			withhold();
			message = hidden;
		}
		return {
			...value,
			message,
			...(value.code === undefined ? {} : { code: redact(value.code) }),
		};
	};
	const textOf = (output: ToolExecutionResult["output"]) =>
		output?.flatMap((part) => part.type === "text" ? [part.text] : []) ?? [];
	const unsafeParts = (parts: readonly string[]) => parts.some(exposesSecret) ||
		exposesSecret(parts.join("")) || exposesSecret(parts.join("\n"));
	const partsBeforeCollision = (parts: readonly string[], separator: string, limit?: number) => {
		const text = parts.join(separator).slice(0, limit);
		const keep = formattedSafeLength(text);
		if (keep === text.length) return parts.length;
		let count = 0;
		let offset = 0;
		for (const part of parts) {
			if (offset + part.length > keep) break;
			count++;
			offset += part.length + separator.length;
		}
		return count;
	};
	// Reject collisions at a moving cut without rejoining the entire prefix for each candidate. Each window is a
	// substring of the applicable sink text; the caller also checks the whole result before keeping a prefix.
	const checkShorterBoundary = (parts: readonly string[], separator: string, frame?: string) => {
		const joined = parts.join(separator);
		const formatted = sanitizeSurrogates(joined);
		const suffix = frame === undefined ? "" : separator + frame;
		const size = values[0]!.length;
		const rawHead = suffix.slice(0, size);
		const encodedHead = suffix.toWellFormed().slice(0, size);
		const formattedHead = sanitizeSurrogates(suffix).slice(0, size);
		let end = joined.length;
		let formattedEnd = formatted.length;
		return (removed: string) => {
			end -= removed.length + separator.length;
			formattedEnd -= sanitizeSurrogates(removed).length + separator.length;
			// If the removed part completed a pair across the join, neither half is in the shorter Responses prefix.
			if (separator === "" && removed !== "" && (joined.codePointAt(end - 1) ?? 0) > 0xffff) formattedEnd -= 2;
			const start = Math.max(0, end - size);
			const rawTail = joined.slice((joined.codePointAt(start - 1) ?? 0) > 0xffff ? start - 1 : start, end);
			return (rawTail + rawHead).search(pattern) !== -1 ||
				(rawTail.toWellFormed() + encodedHead).search(pattern) !== -1 ||
				(formatted.slice(Math.max(0, formattedEnd - size), formattedEnd) + formattedHead).search(pattern) !== -1;
		};
	};
	const afterTool = (call: ToolHookCall, result: ToolExecutionResult): ToolExecutionResult => {
		let withheld = false;
		const withhold = () => { withheld = true; };
		// Compact marks apply to every result, including results a hook copied or replaced.
		let output = result.output?.map((part) => {
			if (part.type !== "text") return part;
			const text = compact(part.text, withhold);
			// Signatures are opaque provider metadata for assistant text, not needed for tool text.
			return text === part.text && part.textSignature === undefined ? part : { type: "text" as const, text };
		});
		const joined = textOf(output).join("");
		let keep = safeLength(joined);
		if (output?.some((part, index) => part !== result.output?.[index])) {
			// Parts can split one UTF-16 character. Measure the joined output Pi actually bounds.
			const original = textOf(result.output).join("");
			const maxBytes = utf8ByteLength(original);
			if (utf8ByteLength(joined) > maxBytes) {
				keep = Math.min(keep, boundOutput(joined, { maxBytes, maxLines: Infinity, retain: "head" }).text.length);
			}
		}
		if (output !== undefined && keep < joined.length) {
			withhold();
			for (let i = 0; i < output.length; i++) {
				const part = output[i]!;
				if (part.type !== "text") continue;
				if (part.text.length > keep) output[i] = { ...part, text: part.text.slice(0, keep) };
				keep = Math.max(0, keep - part.text.length);
			}
		}
		const nestedError = call.parent !== undefined && result.isError === true;
		const unsafeSummary = (messages: readonly string[]) => exposesSecret(messages.join("\n").slice(0, 500));
		let diagnostics = (result.diagnostics ?? []).map((value) => diagnostic(value, withhold));
		const errors = () => diagnostics.filter(({ severity }) => severity === "error").map(({ message }) => message);
		const framed = () => call.parent === undefined && diagnostics.length > 0 ? [renderDiagnostics(diagnostics)] : [];
		const unsafeDiagnostics = () => unsafeParts(framed()) || (nestedError && unsafeSummary(errors()));
		if (unsafeDiagnostics()) {
			withhold();
			diagnostics = diagnostics.map((value) => ({ ...value, message: hidden }));
			if (unsafeDiagnostics()) diagnostics = [];
		}
		const keepSafeText = () => {
			const texts = textOf(output);
			const frame = framed();
			const fromOutput = nestedError && errors().length === 0;
			const unsafe = (parts: readonly string[]) => unsafeParts([...parts, ...frame]) ||
				(fromOutput && unsafeSummary(parts));
			if (!unsafe(texts)) return;
			withhold();
			// Cut before a part involved in an output collision. The frame moves with the cut, so a collision with
			// it does not justify skipping any shorter cut: the next part back may be safe next to the frame.
			const first = texts.findIndex(exposesSecret);
			let keep = Math.min(first === -1 ? texts.length : first, partsBeforeCollision(texts, ""),
				partsBeforeCollision(texts, "\n"), fromOutput ? partsBeforeCollision(texts, "\n", 500) : texts.length);
			if (keep > 0 && (keep === texts.length || unsafe(texts.slice(0, keep)))) {
				const prefix = texts.slice(0, keep);
				const adjacent = checkShorterBoundary(prefix, "", frame[0]);
				const separated = checkShorterBoundary(prefix, "\n", frame[0]);
				while (--keep > 0) {
					const removed = texts[keep]!;
					const adjacentCollision = adjacent(removed);
					const separatedCollision = separated(removed);
					if (!adjacentCollision && !separatedCollision && !unsafe(texts.slice(0, keep))) break;
				}
			}
			output = output?.filter((part) => part.type !== "text" || keep-- > 0);
		};
		keepSafeText();
		if (withheld && !diagnostics.some(({ code, message }) => code === warning.code && message === warning.message)) {
			diagnostics.push(warning);
			// The warning itself is also framed, and can complete a value across a diagnostic or output boundary.
			if (unsafeDiagnostics()) diagnostics = [warning];
			if (unsafeDiagnostics()) diagnostics = [];
			keepSafeText();
		}
		return {
			...result,
			// Pi uses the array identity to decide whether to retain its progress truncation diagnostic.
			...(output !== undefined && (output.length !== result.output?.length ||
				output.some((part, index) => part !== result.output?.[index])) ? { output } : {}),
			...(result.structuredOutput === undefined ? {} : { structuredOutput: json(result.structuredOutput) }),
			...(result.details === undefined ? {} : { details: json(result.details) }),
			...(result.diagnostics === undefined && !withheld ? {} : { diagnostics }),
			...(result.control?.handoff === undefined ? {} : {
				control: { ...result.control, handoff: redactHandoff(result.control.handoff) },
			}),
		};
	};
	const beforeProviderRequest: GenerationHooks["beforeProviderRequest"] = ({ model, payload }) => {
		if (model.api !== "openai-responses" && model.api !== "openai-codex-responses" &&
			model.api !== "azure-openai-responses") return;
		const body = payload as { input?: ReturnType<typeof convertResponsesMessages> };
		if (!Array.isArray(body?.input)) return;
		let changed = false;
		const scrub = (text: string) => {
			if (!exposesSecret(text)) return text;
			changed = true;
			return ["Output withheld", hidden, ""].find((mark) =>
				utf8ByteLength(mark) <= utf8ByteLength(text) && !exposesSecret(mark))!;
		};
		// Recheck after Pi's bounds, harness diagnostics and provider placeholders, not just our earlier projection.
		const input = body.input.map((item) => {
			if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") return item;
			const output = typeof item.output === "string" ? scrub(item.output) : item.output.map((chunk) =>
				chunk.type === "input_text" ? { ...chunk, text: scrub(chunk.text) } : chunk);
			return { ...item, output };
		});
		return changed ? { payload: { ...body, input } } : undefined;
	};
	const guardedOutputs = new WeakSet<ToolExecutionApi["output"]>();
	const protectTool = (tool: ToolRegistration): ToolRegistration => ({
		...tool,
		execute: async (args, api, context) => {
			// An extension wrapper may call the tool it wraps with the same protected API.
			if (guardedOutputs.has(api.output)) return tool.execute(args, api, context);
			let withheld = false;
			const withhold = () => {
				if (withheld) return;
				withheld = true;
				api.diagnostic(warning);
			};
			const stream = redactStream(streamMarks, streamMark, (text) => safeLength(text, streamPattern), api.output, withhold);
			guardedOutputs.add(stream.output);
			// Copy own properties for harness wrappers that spread the API, preserving Pi's live getters.
			const protectedApi = Object.defineProperties({}, Object.getOwnPropertyDescriptors(api)) as ToolExecutionApi;
			Object.assign(protectedApi, {
				[toolTextPolicy]: {
					containsSecret: exposesSecret,
					redact(text: string) {
						const masked = compact(text, withhold);
						const safe = masked.slice(0, safeLength(masked));
						const exposed = exposesSecret(safe);
						if (safe.length !== masked.length || exposed) withhold();
						return exposed ? "" : safe;
					},
				},
				output: stream.output,
				// A tail skip could remove part of a secret before this wrapper sees it.
				outputWindow: undefined,
				details: ((value, ctx) => api.details(json(value), ctx)) satisfies ToolExecutionApi["details"],
				diagnostic: (value: ToolDiagnostic) => api.diagnostic(diagnostic(value, withhold)),
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
			hooks: [...(extension.hooks ?? []), hook(ToolTask, { afterTool }), hook(GenerationTask, { beforeProviderRequest })],
		}),
	};
}

// Chord strips OSC/DCS/APC/PM/SOS, CSI and short escapes from each window. Hold a possible unfinished sequence
// across chunks, but never emit ESC or let an unterminated sequence grow without bound.
const unfinishedEscape = /\x1b(?:[\]PX^_][^\x07\x1b]*\x1b?|\[[\x30-\x3f]*[\x20-\x2f]*|[\x20-\x2f]*)(?![\s\S])/;
const maxEscapeLength = 4096;

function redactStream(
	marks: ReadonlyMap<string, string>, markFor: (value: string, bytes: number) => string,
	safeLength: (text: string) => number, emit: (text: string) => void, withhold: () => void,
) {
	const values = [...marks.keys()];
	const overlap = (values[0]?.length ?? 1) - 1;
	const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
	let pending = "";
	let started = false;
	let escape = "";
	let surrogate = "";
	let maskedSuffix = "";
	let stopped = false;
	function normalize(text: string, final = false) {
		const raw = escape + text;
		const unfinished = final ? -1 : raw.search(unfinishedEscape);
		escape = unfinished === -1 ? "" : raw.slice(unfinished);
		let visible = surrogate + sanitizeOutput(unfinished === -1 ? raw : raw.slice(0, unfinished));
		surrogate = !final && /[\ud800-\udbff]$/.test(visible) ? visible.slice(-1) : "";
		if (surrogate !== "") visible = visible.slice(0, -1);
		return visible.toWellFormed();
	}
	function publish(masked: string, state: "open" | "complete" | "interrupted") {
		const joined = maskedSuffix + masked;
		const keep = safeLength(joined);
		const safe = joined.slice(0, keep);
		// A replacement can leave a suffix that looks like a new secret. Hold it before publication, not after.
		let end = safe.length;
		if (state !== "complete" || keep < joined.length) {
			for (let i = Math.max(0, end - overlap); i < end; i++) {
				const suffix = safe.slice(i);
				if (values.some((value) => value.length > suffix.length && value.startsWith(suffix))) {
					end = (safe.codePointAt(i - 1) ?? 0) > 0xffff ? i - 1 : i;
					break;
				}
			}
		}
		const accepted = safe.slice(0, end);
		if (accepted !== "") emit(accepted);
		if (keep < joined.length || escape.length > maxEscapeLength) {
			stopped = true;
			escape = "";
			withhold();
		}
		if (state === "interrupted" && end < safe.length) withhold();
		maskedSuffix = stopped ? "" : safe.slice(end);
	}
	function scan(text: string, state: "open" | "complete" | "interrupted" = "open") {
		if (stopped) return;
		pending += text;
		let index = 0;
		let safe = "";
		while (index < pending.length) {
			const match = values.find((value) => pending.startsWith(value, index));
			if (pending.length - index <= overlap) {
				const suffix = pending.slice(index);
				const partial = values.find((value) => value.length > suffix.length && value.startsWith(suffix));
				if (partial !== undefined) {
					if (state === "open") break;
					if (state === "interrupted") {
						// A shorter value may match the start of a held, longer prefix.
						const value = match?.length === suffix.length ? match : partial;
						const mark = markFor(value, byteBudget(suffix));
						if (mark === "") withhold();
						safe += mark;
						index = pending.length;
						break;
					}
				}
			}
			if (match === undefined) {
				safe += pending[index++];
			} else {
				const mark = marks.get(match)!;
				if (mark === "") withhold();
				safe += mark;
				index += match.length;
			}
		}
		pending = pending.slice(index);
		publish(safe, state);
	}
	return {
		output(chunk: string | Uint8Array, skipped?: Parameters<ToolExecutionApi["output"]>[1]) {
			if (skipped !== undefined) throw new Error("Skipped tool output is unavailable when redacting secrets");
			if (typeof chunk === "string") {
				const text = decoder.decode() + chunk;
				started ||= text !== "";
				scan(normalize(text));
			} else {
				let text = decoder.decode(chunk, { stream: true });
				if (!started && text.startsWith("\ufeff")) {
					text = text.slice(1);
					started = true;
				}
				started ||= text !== "";
				scan(normalize(text));
			}
		},
		end(interrupted: boolean) {
			// Flush the held prefix before a decoder replacement character can make it look unrelated.
			if (interrupted) scan("", "interrupted");
			if (!stopped) scan(normalize(decoder.decode(), true), interrupted ? "interrupted" : "complete");
		},
	};
}
