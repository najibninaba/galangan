// Opt-in foreground reasoning help. Pi owns each child and its request, so replay reattaches instead of spawning again.
// The budget is a conversation document keyed by the run's first entry, not process memory or a truncated transcript.
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import {
	AssistantEntry, configure, defineDoc, defineExtension, defineTool, LiveDoc,
	type EntryId, type Extension, type ModelRef, type TaskId,
} from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { SECRETS_EXTENSION } from "./secrets.ts";

const Budget = defineDoc<{ first?: EntryId; calls: TaskId[] }>({
	kind: "galangan.helper.budget",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ calls: [] }),
	checkpointWhen: () => true,
});

/** Defaults to Sol high; inject a registered model and supported level for offline tests or another provider. */
export function helper({
	model = { provider: "openai", modelId: "gpt-6.1-sol" },
	thinkingLevel = "high",
	extensions = [],
}: {
	readonly model?: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
	/** Explicit child capabilities; these extensions must also be installed in the harness registry. */
	readonly extensions?: readonly Extension[];
} = {}) {
	const extension = defineExtension({
		name: "galangan.helper",
		tools: [defineTool({
			name: "delegate",
			description: "Get findings from a reasoning helper for hard reasoning or long multi-step work. " +
				"Give it a self-contained task; it cannot see this conversation. You write the final answer. " +
				"Do not delegate easy requests or send duplicate checks of the same work. At most three calls per answer.",
			parameters: obj({ task: str() }),
			replay: "safe",
			execute: async (args, api, context) => {
				if (api.models.getProvider(model.provider) === undefined) {
					throw new Error(`helper provider ${model.provider} is not registered; register it in the shell's Models`);
				}
				const resolved = api.models.getModel(model.provider, model.modelId);
				if (resolved === undefined) {
					throw new Error(`helper model ${model.provider}/${model.modelId} is not registered`);
				}
				const supported = getSupportedThinkingLevels(resolved);
				if (!supported.includes(thinkingLevel)) {
					throw new Error(`helper thinkingLevel is "${thinkingLevel}"; ` +
						`${model.provider}/${model.modelId} supports ${supported.join(", ")}`);
				}
				if (await api.models.checkAuth(model.provider) === undefined) {
					throw new Error(`helper provider ${model.provider} has no credentials configured`);
				}
				const childId = await api.commit(async (tx) => {
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					const live = await tx.doc(LiveDoc, api.conversationId);
					const budget = await tx.doc(Budget, api.conversationId);
					// Pi can resume a legacy tool round without first; do not silently share its budget with another run.
					const first = live.run?.first;
					if (first === undefined) throw new Error("helper cannot identify this answer's budget: run.first is missing");
					if (budget.first !== first) {
						budget.first = first;
						budget.calls = [];
					}
					if (budget.calls.length >= 3) throw new Error("Three helper calls used; finish with the available findings.");
					budget.calls.push(api.taskId);
					const child = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					await configure(tx, child.id, {
						model, thinkingLevel,
						// Stored by name, so this selects the shell's installed secrets extension: a child's tool
						// results are committed in the child and need redacting there too.
						extensions: [
							...extensions.filter((candidate) => candidate.name !== extension.name && candidate.name !== SECRETS_EXTENSION),
							{ name: SECRETS_EXTENSION },
						],
						tools: { remove: extension.tools! },
						modelTools: null,
						instructions: "Return concise findings for the task, including uncertainties. The parent writes the user-facing answer.",
					});
					return child.id;
				}, context);
				await api.details({ conversationId: childId, model, thinkingLevel }, context);
				const child = (await api.conversation(childId, context))!;
				const settled = await (await child.submit({
					type: "input", content: args.task, requestId: `subagent:${api.taskId}`,
				}, context)).wait(context);
				if (settled.status !== "done" || settled.type !== "input") {
					throw new Error(`helper did not answer: ${JSON.stringify(settled)}`);
				}
				const answer = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
				const text = (answer?.model ?? [])
					.flatMap((message) => message.role === "assistant" ? message.content : [])
					.map((part) => part.type === "text" ? part.text : "").join("").trim();
				return { output: [{ type: "text", text }] };
			},
		})],
	});
	return extension;
}
