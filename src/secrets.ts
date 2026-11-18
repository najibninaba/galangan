// Secrets a harness's tools read from the environment, such as an API token (BIJAN-164, from kirim's Todoist token).
//
// A harness names them in `HarnessSpec.secrets`. The CLI checks them at startup, so a missing one is a configuration
// error (exit 78) instead of a failed tool call partway through a conversation. And the shell keeps their values out
// of the store: Pi commits every tool result, error results included, and a tool's error message can quote what it
// sent, so the `galangan.secrets` extension's `afterTool` hook replaces each value with `[secret NAME]` before the
// commit. The hook is Pi's redaction point: it sees every result a tool task writes, also the error results the
// Harness writes itself, and it runs after the harness's own hooks because the shell selects it last.
//
// It matches exact values only. A tool that encodes a secret (base64, URL escapes) is outside this policy.
// Tool arguments written by the model are outside this policy.
import { defineExtension, hook, wrapTool, ToolTask, type ToolRegistration, type Extension, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import type { HarnessSpec } from "./harness.ts";

export const SECRETS_EXTENSION = "galangan.secrets";

export type Env = { readonly [name: string]: string | undefined };

/** The harness's secrets that `env` leaves unset or empty. */
export const missingSecrets = (spec: HarnessSpec, env: Env): string[] =>
	(spec.secrets ?? []).filter((name) => (env[name] ?? "") === "");

/** Replaces the value of each of `spec`'s secrets set in `env` with `[secret NAME]`, longest value first. */
export function redactor(spec: HarnessSpec, env: Env): (text: string) => string {
	const values = (spec.secrets ?? []).flatMap((name) => (env[name] ?? "") === "" ? [] : [[name, env[name]!] as const])
		.sort(([, a], [, b]) => b.length - a.length);
	return (text) => values.reduce((redacted, [name, value]) => redacted.replaceAll(value, `[secret ${name}]`), text);
}

/** The extension that redacts every tool result before Pi commits it. Installed for every harness, secrets or not. */
export function secretsExtension(redact: (text: string) => string, tools: readonly ToolRegistration[], values: readonly string[]): Extension {
	const json = (value: JsonValue): JsonValue =>
		typeof value === "string"
			? redact(value)
			: Array.isArray(value)
				? value.map(json)
				: value !== null && typeof value === "object"
					? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), json(item)]))
					: value;
	// A hook that throws is skipped, which would commit the result as it was, so this only maps strings.
	const afterTool = (_call: unknown, result: ToolExecutionResult): ToolExecutionResult => ({
		...result,
		...(result.control === undefined ? {} : { control: { ...result.control,
			...(result.control.handoff === undefined ? {} : { handoff: redact(result.control.handoff) }),
		} }),
		...(result.output === undefined ? {} : {
			output: result.output.map((part) => (part.type === "text" ? { ...part, text: redact(part.text) } : part)),
		}),
		...(result.structuredOutput === undefined ? {} : { structuredOutput: json(result.structuredOutput) }),
		...(result.details === undefined ? {} : { details: json(result.details) }),
		...(result.diagnostics === undefined ? {} : {
			diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic, message: redact(diagnostic.message), ...(diagnostic.code === undefined ? {} : { code: redact(diagnostic.code) }) })),
		}),
	});
	return defineExtension({
		name: SECRETS_EXTENSION,
		wraps: tools.map((tool) => wrapTool(tool, (original) => ({
			...original,
			execute: async (args, api, context) => {
				let pending = "";
				const output = (chunk: string) => {
					pending += chunk;
					let safe = "";
					let index = 0;
					while (index < pending.length) {
						const rest = pending.slice(index);
						const match = values.filter((value) => rest.startsWith(value)).sort((a, b) => b.length - a.length)[0];
						if (match !== undefined) {
							safe += redact(match);
							index += match.length;
						} else if (values.some((value) => value.startsWith(rest))) {
							break;
						} else {
							safe += pending[index++];
						}
					}
					api.output(safe);
					pending = pending.slice(index);
				};
				try {
					return await original.execute(args, {
						...api, output, outputWindow: undefined,
						details: (value, ctx) => api.details(json(value), ctx),
						diagnostic: (value) => api.diagnostic({ ...value, message: redact(value.message),
							...(value.code === undefined ? {} : { code: redact(value.code) }) }),
					}, context);
				} finally {
					if (pending !== "") api.output(redact(pending));
				}
			},
		}))),
		hooks: [hook(ToolTask, { afterTool })],
	});
}
