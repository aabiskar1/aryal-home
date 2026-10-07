import {Buffer} from 'node:buffer';
import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import type {OllamaChatMessage, OllamaChatRequest, OllamaChatTransport} from '../ollama/client.js';
import {createOllamaChatPayload} from '../ollama/request.js';
import {planningJsonSchemas, planSchema, type Plan, type PlanningIntentMode} from './schemas.js';
import type {SetScopeContext} from './intents.js';

export type PlanningRequest = {
	instruction: string;
	states: NormalizedEntityState[];
	setScopes?: readonly SetScopeContext[];
	intentMode?: PlanningIntentMode;
};

const systemMessage = `You are a read-only home automation planner.
Return a proposed plan as JSON matching the supplied schema.
Use only the user instruction and entity state context supplied by the application.

You propose actions; you never execute them.
The summary must begin exactly with "Proposed plan:" and use prospective language.
Never claim or imply that an action was executed, completed, or attempted.

Choose the outcome before writing the summary and actions:
- Use "propose_actions" when one or more concrete actions are appropriate. Include at least one action.
- Use "no_action" when sufficient context exists and no change is appropriate. Return an empty actions array.
- Use "insufficient_context" when the requested decision cannot be made from the supplied context. Return an empty actions array.

Follow the user's planning instruction. Do not default to an empty plan when the instruction and supplied context provide a sufficient reason for a proposal.
When the user explicitly states a target outcome and supplied entity states identify relevant non-no-op changes, use "propose_actions" and include those actions. Do not return only descriptive text.
Use current state to determine whether a proposed change is relevant and to avoid no-op proposals; do not infer intent from current state alone.
Do not normally propose control actions for entities whose state is "unavailable" or "unknown".
Propose only an action listed in the target entity's supportedActions array and copy it exactly.
An empty supportedActions array means that no control action may be proposed for that entity.
The only canonical actions are "turn_on" and "turn_off". Do not use state values such as "on" or "off", domain-qualified services such as "light.turn_off", or service parameters.

Express scope explicitly in actions:
- When intentMode is entity_only, use only specific entity proposals. When it is set_only, use only complete set_action intents. mixed allows either form according to the instruction. Never change a specific target into a collection.
- For a specific entity ID or uniquely identified friendly name, use {entityId, action, reason}. Keep explicit single-entity requests single-target.
- For a complete area/domain collection, use {type: "set_action", action, scope: {area, domain}, reason}. Copy an area name or alias and domain from setScopes. The application, not you, expands the complete permitted set and checks each member's current state.
- Requests for all/every light or switch in an area require a set_action. Never enumerate an arbitrary subset of a requested collection, and never reduce a set to one entity because other members are already in the requested state.
- A contextual instruction can justify a complete set: when the user states an area is empty and its lights are on, propose turning off that area's light set if the intended scope and desired change are clear.
- A plural mention alone does not mean all. If one, some, a subtype, or a complete collection cannot be distinguished, use insufficient_context. Do not guess scope or action from state alone.
- Only area plus domain scopes are supported. Do not invent whole-home scopes, labels, device IDs, registry IDs, selectors, service data, or execution payloads. If the requested set is absent from setScopes, use insufficient_context.

A set_action is one item in actions, not a list of entity proposals. Its exact JSON shape is:
{"type":"set_action","action":"turn_off","scope":{"area":"<copy from setScopes>","domain":"light"},"reason":"The instruction requests the complete area light set."}
Replace the placeholder area with the matching supplied name or alias and choose the requested supported domain/action. Do not output placeholder text.
For a complete collection, include the set intent even if some members are already in the requested state. If any eligible member needs the requested change, the outcome is propose_actions, not no_action.

Do not invent missing context.
If the requested decision depends on context that was not supplied, return an empty actions array and clearly state in the summary that there is insufficient context.
If no action is appropriate for another reason, return an empty actions array and explain the proposed decision without implying execution.

Before returning the JSON, verify that the summary starts exactly with "Proposed plan:" and that the selected outcome is consistent with the number of actions. Rewrite the plan if necessary.`;

const createMessages = (request: PlanningRequest): OllamaChatMessage[] => {
	const instruction = request.instruction.trim();

	if (instruction.length === 0) {
		throw new Error('A planning instruction is required.');
	}

	const states = request.states.map((state) => ({
		entityId: state.entityId,
		domain: state.domain,
		state: state.state,
		name: state.name,
		area: state.area,
		deviceClass: state.deviceClass,
		unit: state.unit,
		supportedActions: state.supportedActions,
	}));

	return [
		{role: 'system', content: systemMessage},
		{
			role: 'user',
			content: JSON.stringify({
				instruction,
				states,
				...(request.intentMode !== undefined && {intentMode: request.intentMode}),
				...(request.setScopes !== undefined &&
					request.setScopes.length > 0 && {
						setScopes: request.setScopes.map(({area, aliases, domain}) => ({
							area,
							aliases,
							domain,
						})),
					}),
			}),
		},
	];
};

export const createPlanningChatRequest = (request: PlanningRequest): OllamaChatRequest => ({
	messages: createMessages(request),
	format: planningJsonSchemas[request.intentMode ?? 'mixed'],
});

export const planningRequestBytes = (request: PlanningRequest, model: string): number => {
	const chatRequest = createPlanningChatRequest(request);
	const payload = createOllamaChatPayload(chatRequest, model);

	return Buffer.byteLength(JSON.stringify(payload));
};

export const createPlan = async (
	request: PlanningRequest,
	chat: OllamaChatTransport,
): Promise<Plan> => {
	const content = await chat(createPlanningChatRequest(request));
	const parsed: unknown = JSON.parse(content);

	// Parse every response strictly; deterministic expansion also checks its contextual intent mode.
	return planSchema.parse(parsed);
};
