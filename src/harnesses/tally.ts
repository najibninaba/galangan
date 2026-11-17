// Example harness: one tool whose state is durable. `tally({ label })` adds one to a per-conversation counter kept in
// a Pi document, so counts survive restarts and the increment commits atomically with the tool call's own record.
// Copy this file to start a new harness, then list it in src/harnesses/index.ts.
import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { defineHarness } from "../harness.ts";

/** Counts by label, one document per conversation. A fork keeps its parent's counts. */
export const Tallies = defineDoc<{ counts: Record<string, number> }>({
	kind: "galangan.tally",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ counts: {} }),
	checkpointWhen: () => true,
});

const tally = defineTool({
	name: "tally",
	description: "Add one to the counter named `label` and return its new value.",
	parameters: obj({ label: str() }),
	// Not replay-safe: a crash mid-call gives the model an `interrupted` result instead of counting twice.
	execute: async (args, api, context) => {
		const count = await api.commit(async (tx) => {
			const doc = await tx.doc(Tallies, api.conversationId);
			const next = (doc.counts[args.label] ?? 0) + 1;
			doc.counts[args.label] = next;
			return next;
		}, context);
		return { output: [{ type: "text", text: `${args.label} = ${count}` }] };
	},
});

export const tallyHarness = defineHarness({
	name: "tally",
	extensions: [
		defineExtension({
			name: "galangan.tally",
			tools: [tally],
			sections: [section("tally", () => "You keep tallies. Use the `tally` tool whenever the user counts something.")],
		}),
	],
});
