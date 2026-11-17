// The extension point: a custom harness is a name plus the Pi Durable extensions it runs with.
//
// Everything a harness does comes from its extensions: tools, prompt sections, hooks, wrappers and durable tasks
// (`defineExtension` from `@earendil-works/pi-durable`). The shell (src/shell.ts) installs them in its registry and
// selects them for every conversation it opens, so a harness never touches storage, models or the Harness lifecycle.
import type { Extension } from "@earendil-works/pi-durable";

export type HarnessSpec = {
	/** Short, stable name; it appears in logs. Conversations store extension names, not this one. */
	readonly name: string;
	/** Installed and selected in this order. A later extension's tool replaces an earlier one with the same name. */
	readonly extensions: readonly Extension[];
};

/** Types a harness definition; harnesses live in src/harnesses/ and are listed in src/harnesses/index.ts. */
export const defineHarness = (spec: HarnessSpec): HarnessSpec => spec;
