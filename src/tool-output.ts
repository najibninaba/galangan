// Internal capability for tools that lay out text and call syntax before sizing a page. Without the shell, Pi
// supplies no policy. A tool can prepare its text against the policy but cannot bypass the final result check.
import type { ToolExecutionApi } from "@earendil-works/pi-durable";

export const toolTextPolicy = Symbol("galangan.tool-text-policy");

export type ToolTextApi = ToolExecutionApi & {
	readonly [toolTextPolicy]?: {
		containsSecret(text: string): boolean;
		redact(text: string): string;
	};
};
