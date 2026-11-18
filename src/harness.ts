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
	/**
	 * Store format version per extension name, for kit extensions whose docs have no migration (memory first). The
	 * store records it for every extension, 0 when undeclared, and a store written with another format fails at open
	 * instead of reading as empty. Declare it from the extension's first release: adding it later is a format change.
	 */
	readonly formats?: { readonly [extension: string]: number };
	/**
	 * Environment variables the harness's tools need, such as an API token; tools still read them from the
	 * environment. `runCli` exits 78 at startup when one is unset or empty. The shell masks exact values before Pi
	 * stores tool results. Output text uses `[secret NAME]` only when it fits without growing the text.
	 */
	readonly secrets?: readonly string[];
};

/** Types a harness definition; pass harnesses to `runCli` (see examples/tally). */
export const defineHarness = (spec: HarnessSpec): HarnessSpec => spec;
