// The models factory: `GALANGAN_MODEL` picks the one model the shell runs.
//
//   unset or "faux"          the faux model below: no network, no keys; tests always use it
//   "real"                   OpenAI Terra 6.1, medium effort unless GALANGAN_THINKING overrides it
//   "<provider>/<model id>"  a pi-ai built-in provider, e.g. "anthropic/claude-opus-4-6", with that provider's usual
//                            key variable (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
//
// The faux model's answer is a pure function of the transcript, so a restarted process answers the same way:
//
//   user "call <tool> <json args>"  -> one tool call `<tool>(args)`; args default to {}
//   after a tool result             -> "<tool>: <result text>" (or "<tool> failed: <text>")
//   user anything else              -> "ack: <text>"
import type { AssistantMessage, Message, ModelThinkingLevel, TranscriptContext } from "@earendil-works/pi-ai";
import { createModels, getSupportedThinkingLevels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import type { ModelRef } from "@earendil-works/pi-durable";
import { Data, Effect } from "effect";

export type ModelChoice = {
	readonly models: Models;
	readonly model: ModelRef;
	readonly thinkingLevel?: ModelThinkingLevel;
};

export const REAL_MODEL = "openai/gpt-6.1-terra";

export class InvalidModel extends Data.TaggedError("InvalidModel")<{ readonly reason: string }> {
	override get message() {
		return this.reason;
	}
}

export const FAUX_MODEL: ModelRef = { provider: "faux", modelId: "faux-1" };

export function fauxModels(): Models {
	const faux = fauxProvider();
	// The provider consumes one step per request; each step queues the next, so the supply never runs out.
	const step: FauxResponseFactory = (context) => {
		faux.appendResponses([step]);
		return fauxAnswer(context);
	};
	faux.setResponses([step]);
	const models = createModels();
	models.setProvider(faux.provider);
	return models;
}

export function fauxAnswer(context: TranscriptContext): AssistantMessage {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") {
		const output = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		return fauxAssistantMessage(last.isError ? `${last.toolName} failed: ${output}` : `${last.toolName}: ${output}`);
	}
	const text = userText(context.messages.findLast((message) => message.role === "user"));
	const call = /^call (\S+)\s*(.*)$/s.exec(text);
	if (call === null) return fauxAssistantMessage(`ack: ${text}`);
	const args = call[2]!.trim() === "" ? {} : JSON.parse(call[2]!);
	return fauxAssistantMessage(fauxToolCall(call[1]!, args), { stopReason: "toolUse" });
}

function userText(message: Message | undefined): string {
	if (message?.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** Resolve and validate rather than letting Pi/provider code silently clamp an unsupported effort. */
export const chooseThinking = (choice: ModelChoice, level?: string): Effect.Effect<ModelThinkingLevel, InvalidModel> =>
	Effect.gen(function* () {
		const { provider, modelId } = choice.model;
		const model = choice.models.getModel(provider, modelId);
		if (model === undefined) return yield* new InvalidModel({ reason: `unknown model ${provider}/${modelId}` });
		const supported = getSupportedThinkingLevels(model);
		const selected = level ?? choice.thinkingLevel;
		if (selected === undefined) return supported.includes("medium") ? "medium" : supported[0]!;
		if (!supported.includes(selected as ModelThinkingLevel)) {
			return yield* new InvalidModel({
				reason: `${level === undefined ? "choice.thinkingLevel" : "GALANGAN_THINKING"} is "${selected}"; ` +
					`${provider}/${modelId} supports ${supported.join(", ")}`,
			});
		}
		return selected as ModelThinkingLevel;
	});

export const chooseModel = (spec = "faux", thinking?: string): Effect.Effect<ModelChoice, InvalidModel> =>
	Effect.gen(function* () {
		if (spec === "faux") {
			const choice = { models: fauxModels(), model: FAUX_MODEL };
			return { ...choice, thinkingLevel: yield* chooseThinking(choice, thinking) };
		}
		if (spec === "real") spec = REAL_MODEL;
		const slash = spec.indexOf("/");
		if (slash <= 0 || slash === spec.length - 1) {
			return yield* new InvalidModel({ reason: `GALANGAN_MODEL is "${spec}"; expected "faux", "real" or "<provider>/<model id>"` });
		}
		const model = { provider: spec.slice(0, slash), modelId: spec.slice(slash + 1) };
		// Loaded only for a real model: the built-in catalog is large.
		const { builtinProviders } = yield* Effect.promise(() => import("@earendil-works/pi-ai/providers/all"));
		const provider = builtinProviders().find((candidate) => candidate.id === model.provider);
		if (provider === undefined) return yield* new InvalidModel({ reason: `unknown model provider ${model.provider}` });
		const models = createModels();
		models.setProvider(provider);
		if (models.getModel(model.provider, model.modelId) === undefined) {
			return yield* new InvalidModel({ reason: `provider ${model.provider} has no model ${model.modelId}` });
		}
		if ((yield* Effect.promise(() => models.checkAuth(model.provider))) === undefined) {
			return yield* new InvalidModel({ reason: `provider ${model.provider} has no credentials configured` });
		}
		const choice = { models, model };
		return { ...choice, thinkingLevel: yield* chooseThinking(choice, thinking) };
	});
