import {describe, expect, it, vi} from 'vitest';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {RegistrySnapshot} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {createSetScopeContext, expandPlanIntents} from '../src/planning/intents.js';
import {runPlanningPipeline} from '../src/planning/pipeline.js';
import type {OllamaChatTransport} from '../src/ollama/client.js';
import {
	createPlan,
	createPlanningChatRequest,
	planningRequestBytes,
} from '../src/planning/planner.js';
import {outputHeadroomBytes} from '../src/planning/relevance.js';
import {planSchema, type Plan, type SetAction} from '../src/planning/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';

// Generated, sanitized fixtures: no installation-specific inventory or expected device count.
const fixture = (
	count: number,
	area = 'Studio',
	domain: 'light' | 'switch' = 'light',
	conditions: {noOp?: number; unavailable?: number; denied?: number; disabled?: number} = {},
) => {
	const states: HomeAssistantState[] = Array.from({length: count}, (_, index) => ({
		entity_id: `${domain}.example_${index}`,
		state:
			index === conditions.noOp ? 'off' : index === conditions.unavailable ? 'unavailable' : 'on',
		attributes: {friendly_name: `${area} ${domain} ${index + 1}`},
		last_changed: '2026-10-07T00:00:00+00:00',
		last_updated: '2026-10-07T00:00:00+00:00',
	}));
	const registries: Extract<RegistrySnapshot, {status: 'available'}> = {
		status: 'available',
		entities: states.map((state, index) => ({
			entity_id: state.entity_id,
			device_id: null,
			area_id: 'fixture_area',
			labels: [],
			disabled_by: index === conditions.disabled ? 'user' : null,
		})),
		devices: [],
		areas: [{area_id: 'fixture_area', name: area, aliases: ['Making Space'], labels: []}],
		labels: [],
	};
	const entities = discoverEntities(states, registries);
	const policy = resolveEntityPolicy(entities, {
		version: 1,
		allow: [{domain: 'light'}, {domain: 'switch'}],
		deny: conditions.denied === undefined ? [] : [{entityId: states[conditions.denied]!.entity_id}],
	});
	return {states, registries, entities, policy};
};

const setIntent = (area = 'Studio', domain: 'light' | 'switch' = 'light'): SetAction => ({
	type: 'set_action',
	action: 'turn_off',
	scope: {area, domain},
	reason: 'The user requests the complete scoped set.',
});
const plan = (actions: Plan['actions']): Plan => ({
	outcome: 'propose_actions',
	summary: 'Proposed plan: Change the requested collection.',
	actions,
});
const options = {model: 'example-model', maxRequestBytes: 1_000_000};
const run = async (
	input: ReturnType<typeof fixture>,
	instruction = 'Turn off all Studio lights',
	actions: Plan['actions'] = [setIntent()],
) =>
	runPlanningPipeline(instruction, input.entities, input.policy, {
		...options,
		chat: async () => JSON.stringify(plan(actions)),
	});

const expand = (input: ReturnType<typeof fixture>, actions = [setIntent()]) => {
	const entityIds = input.policy.allowedEntityIds;
	return expandPlanIntents(plan(actions), input.entities, input.policy, {
		entityIds,
		setScopes: createSetScopeContext(input.entities, input.policy, entityIds),
		singleTarget: false,
		requiresSetIntent: true,
	});
};

describe('strict semantic planner schema', () => {
	it.each(['entity_only', 'set_only', 'mixed'] as const)(
		'constrains the model generation shape for %s context',
		(intentMode) => {
			const request = createPlanningChatRequest({
				instruction: 'Review the supplied context.',
				states: [],
				intentMode,
			});
			const format = JSON.stringify(request.format);
			expect(format.includes('entityId')).toBe(intentMode !== 'set_only');
			expect(format.includes('set_action')).toBe(intentMode !== 'entity_only');
			expect(request.messages[1]?.content).toContain(intentMode);
		},
	);
	it('preserves the existing single entity representation', () => {
		const single = {
			entityId: 'light.example_target',
			action: 'turn_off',
			reason: 'Explicit target.',
		};
		expect(planSchema.parse(plan([single as Plan['actions'][number]])).actions).toEqual([single]);
	});

	it('parses a set without requiring model-enumerated entity IDs', async () => {
		const result = await createPlan(
			{instruction: 'Turn off all Studio lights', states: []},
			async () => JSON.stringify(plan([setIntent()])),
		);
		expect(result.actions).toEqual([setIntent()]);
		expect(JSON.stringify(result.actions)).not.toContain('entityId');
	});

	it.each([
		{scope: {}},
		{scope: {area: 'Studio'}},
		{scope: {domain: 'light'}},
		{scope: {area: '', domain: 'light'}},
		{scope: {area: 'Studio', domain: 'lock'}},
		{scope: {area: 'Studio', domain: 'sensor'}},
		{scope: {area: 'Studio', domain: 'light', area_id: 'fixture_area'}},
		{scope: {area: 'Studio', domain: 'light', label: 'Example label'}},
		{action: 'toggle'},
		{action: 'light.turn_off'},
		{type: 'entity_action'},
		{service: 'turn_off'},
		{data: {brightness: 10}},
		{entityId: 'light.example_target'},
		{deviceId: 'fixture_device'},
	])('rejects malformed or model-owned routing fields %j', (change) => {
		expect(
			planSchema.safeParse({...plan([]), actions: [{...setIntent(), ...change}]}).success,
		).toBe(false);
	});

	it('requires ambiguous scope to be an empty insufficient-context plan', () => {
		expect(
			planSchema.safeParse({
				outcome: 'insufficient_context',
				summary: 'Proposed plan: Scope is ambiguous.',
				actions: [],
			}).success,
		).toBe(true);
		const inconsistent = {...plan([setIntent()]), outcome: 'insufficient_context'};
		expect(planSchema.safeParse(inconsistent).success).toBe(false);
	});
});

describe('deterministic, policy-constrained expansion', () => {
	it.each([
		{count: 1, area: 'Studio', domain: 'light' as const},
		{count: 3, area: 'Atrium', domain: 'light' as const},
		{count: 20, area: 'Workshop', domain: 'switch' as const},
		{count: 75, area: 'North Wing', domain: 'light' as const},
	])(
		'expands every permitted member: $count $domain entities in $area',
		({count, area, domain}) => {
			const input = fixture(count, area, domain);
			const result = expand(input, [setIntent(area, domain)]);
			expect(result.plan.actions).toHaveLength(count);
			expect(result.sets[0]?.matchedCount).toBe(count);
			const ids = result.plan.actions.map((action) => action.entityId);
			expect(ids).toEqual(expect.arrayContaining(input.states.map((state) => state.entity_id)));
			for (const [index, id] of ids.entries()) {
				if (index > 0) {
					expect(ids[index - 1]! < id).toBe(true);
				}
			}
		},
	);

	it('resolves a validated area alias and emits only the canonical area name', () => {
		const result = expand(fixture(3), [setIntent('Making Space')]);
		expect(result.sets[0]?.scope).toEqual({area: 'Studio', domain: 'light'});
		expect(result.plan.actions).toHaveLength(3);
	});

	it('never includes a denied member, even with a conflicting allowed set', () => {
		const input = fixture(4, 'Studio', 'light', {denied: 2});
		input.policy.allowedEntityIds = new Set(input.states.map((state) => state.entity_id));
		const result = expand(input);
		expect(result.plan.actions.map((action) => action.entityId)).not.toContain(
			input.states[2]!.entity_id,
		);
		expect(result.sets[0]).toMatchObject({matchedCount: 3, excludedCounts: {notPermitted: 1}});
	});

	it('filters a mixed area by the requested domain', () => {
		const input = fixture(3);
		const switches = fixture(4, 'Studio', 'switch');
		input.entities.push(...switches.entities);
		input.policy.allowedEntityIds = new Set([
			...input.policy.allowedEntityIds,
			...switches.policy.allowedEntityIds,
		]);
		const result = expand(input);
		expect(result.plan.actions).toHaveLength(3);
		expect(result.plan.actions.every((action) => action.entityId.startsWith('light.'))).toBe(true);
	});

	it('fails closed for zero permitted matches', () => {
		const result = expand(fixture(1), [setIntent('Studio', 'switch')]);
		expect(result.plan.actions).toEqual([]);
		expect(result.plan.outcome).toBe('insufficient_context');
		expect(result.rejectedIntents[0]?.reason).toBe('zero_permitted_matches');
	});

	it('rejects invented names and raw registry IDs', () => {
		for (const area of ['Missing Area', 'fixture_area']) {
			expect(expand(fixture(3), [setIntent(area)]).rejectedIntents[0]?.reason).toBe(
				'unknown_scope',
			);
		}
	});

	it.each(['alias', 'canonical'])(
		'rejects ambiguous %s scope across distinct effective areas',
		(collision) => {
			const input = fixture(3);
			input.registries.areas.push({
				area_id: 'other_fixture_area',
				name: collision === 'canonical' ? 'Studio' : 'Annex',
				aliases: ['Making Space'],
				labels: [],
			});
			input.registries.entities[2]!.area_id = 'other_fixture_area';
			input.entities = discoverEntities(input.states, input.registries);
			const result = expand(input, [
				setIntent(collision === 'canonical' ? 'Studio' : 'Making Space'),
			]);
			expect(result.rejectedIntents[0]?.reason).toBe('ambiguous_scope');
			expect(result.plan.actions).toEqual([]);
		},
	);

	it('refuses a partial context even if the caller advertises a scope', () => {
		const input = fixture(3);
		const entityIds = new Set([input.states[0]!.entity_id]);
		expect(createSetScopeContext(input.entities, input.policy, entityIds)).toEqual([]);
		const result = expandPlanIntents(plan([setIntent()]), input.entities, input.policy, {
			entityIds,
			setScopes: [{area: 'Studio', aliases: [], domain: 'light'}],
			singleTarget: false,
			requiresSetIntent: false,
		});
		expect(result.plan.actions).toEqual([]);
		expect(result.rejectedIntents[0]?.reason).toBe('incomplete_scope_context');
	});

	it('refuses a complete but unshown scope', () => {
		const input = fixture(3);
		const result = expandPlanIntents(plan([setIntent()]), input.entities, input.policy, {
			entityIds: input.policy.allowedEntityIds,
			setScopes: [],
			singleTarget: false,
			requiresSetIntent: false,
		});
		expect(result.plan.actions).toEqual([]);
		expect(result.rejectedIntents[0]?.reason).toBe('incomplete_scope_context');
	});
});

describe('semantic planning through readiness', () => {
	it('turns off all applicable kitchen lights without model enumeration', async () => {
		const input = fixture(5, 'Kitchen');
		const result = await run(input, 'Turn off all kitchen lights', [setIntent('Kitchen')]);
		expect(result.executionReadiness.commands).toHaveLength(5);
		expect(result.intentExpansion.sets[0]).toMatchObject({
			intentType: 'set_action',
			matchedCount: 5,
		});
		expect(result.intentExpansion.outcome).toBe('complete');
	});

	it('keeps a no-op among many while preparing the other members', async () => {
		const result = await run(fixture(4, 'Studio', 'light', {noOp: 1}));
		expect(result.executionReadiness.commands).toHaveLength(3);
		expect(
			result.intentExpansion.sets[0]?.members.filter(
				(member) => member.status === 'already_satisfied',
			),
		).toHaveLength(1);
		expect(result.intentExpansion).toMatchObject({
			outcome: 'complete',
			satisfiedCount: 1,
			unprocessedCount: 0,
		});
	});

	it('treats an entirely no-op set as already satisfied without commands', async () => {
		const result = await run(fixture(1, 'Studio', 'light', {noOp: 0}));
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.intentExpansion).toMatchObject({
			outcome: 'complete',
			satisfiedCount: 1,
			unprocessedCount: 0,
		});
	});

	it.each(['unavailable', 'disabled', 'denied'] as const)(
		'reports an excluded %s member and continues eligible members',
		async (condition) => {
			const input = fixture(4, 'Studio', 'light', {[condition]: 1});
			const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(plan([setIntent()])));
			const result = await runPlanningPipeline(
				'Turn off all Studio lights',
				input.entities,
				input.policy,
				{...options, chat},
			);
			expect(result.executionReadiness.commands).toHaveLength(3);
			expect(result.intentExpansion).toMatchObject({outcome: 'partial', unprocessedCount: 1});
			expect(result.intentExpansion.sets[0]?.excludedCounts).toEqual({
				ineligible: condition === 'denied' ? 0 : 1,
				notPermitted: condition === 'denied' ? 1 : 0,
			});
			expect(JSON.stringify(chat.mock.calls)).not.toContain(input.states[1]!.entity_id);
			expect(JSON.stringify(result.intentExpansion)).not.toContain(input.states[1]!.entity_id);
		},
	);

	it('prepares ineligible members through existing readiness if present in a supplied resolved policy', async () => {
		const input = fixture(3, 'Studio', 'light', {unavailable: 1});
		input.policy.allowedEntityIds = new Set(input.states.map((state) => state.entity_id));
		input.policy.deniedEntityIds = new Set();
		const result = await run(input);
		expect(result.executionReadiness.commands).toHaveLength(2);
		expect(result.executionReadiness.rejectedActions[0]?.reason).toBe('ineligible_state');
	});

	it.each(['Turn off kitchen light 2', 'Turn off light.example_1'])(
		'keeps explicit single-target instruction %s single',
		async (instruction) => {
			const input = fixture(4, 'Kitchen');
			const result = await run(input, instruction, [
				{entityId: input.states[1]!.entity_id, action: 'turn_off', reason: 'Explicit entity.'},
			]);
			expect(result.executionReadiness.commands).toHaveLength(1);
			expect(result.intentExpansion.sets).toEqual([]);
		},
	);

	it('refuses a set intent for an explicit single target even if its area has just one member', async () => {
		const result = await run(fixture(1), 'Turn off light.example_0');
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.intentExpansion.rejectedIntents[0]?.reason).toBe('single_target_context');
	});

	it('does not treat a universal word in an arbitrary area name as all intent', async () => {
		const input = fixture(4, 'All Saints Hall');
		const result = await run(input, 'Turn off All Saints Hall light 2', [
			{entityId: input.states[1]!.entity_id, action: 'turn_off', reason: 'Explicit target.'},
		]);
		expect(result.executionReadiness.commands).toHaveLength(1);
		expect(result.intentExpansion.rejectedIntents).toEqual([]);
	});

	it('supports contextual set intent with sufficient user-provided context', async () => {
		const input = fixture(4, 'Sitting Area');
		const result = await run(
			input,
			"I'm in Study and Sitting Area is empty. The lights are on in Sitting Area",
			[setIntent('Sitting Area')],
		);
		expect(result.executionReadiness.commands).toHaveLength(4);
	});

	it('keeps the model-selected empty area separate from another mentioned occupied area', async () => {
		const input = fixture(3);
		const retreat = fixture(2, 'Retreat');
		for (const [index, state] of retreat.states.entries()) {
			state.entity_id = `light.example_retreat_${index}`;
			retreat.registries.entities[index]!.entity_id = state.entity_id;
			retreat.registries.entities[index]!.area_id = 'retreat_fixture_area';
		}

		retreat.registries.areas[0]!.area_id = 'retreat_fixture_area';
		retreat.registries.areas[0]!.aliases = [];
		input.entities = discoverEntities([...input.states, ...retreat.states], {
			...input.registries,
			entities: [...input.registries.entities, ...retreat.registries.entities],
			areas: [...input.registries.areas, ...retreat.registries.areas],
		});
		input.policy = resolveEntityPolicy(input.entities, {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [],
		});
		const result = await run(
			input,
			"I'm in Retreat and Studio is empty. The lights are on in Studio",
		);
		expect(result.selection.kind).toBe('ready');
		if (result.selection.kind === 'ready') {
			expect(result.selection.states).toHaveLength(5);
		}

		expect(result.executionReadiness.commands).toHaveLength(3);
		expect(
			result.executionReadiness.commands.every(
				(command) => !command.target.entity_id.includes('retreat'),
			),
		).toBe(true);
	});

	it('retains valid commands alongside a rejected semantic scope', async () => {
		const result = await run(fixture(3), 'Review Studio lights', [
			setIntent(),
			setIntent('Invented Area'),
		]);
		expect(result.executionReadiness.commands).toHaveLength(3);
		expect(result.intentExpansion).toMatchObject({outcome: 'partial', unprocessedCount: 1});
		expect(result.intentExpansion.sets[1]?.rejection).toBe('unknown_scope');
		expect(JSON.stringify(result.intentExpansion)).not.toContain('Invented Area');
	});

	it('shares downstream validation for a mixed entity/set plan', async () => {
		const input = fixture(3);
		const switches = fixture(1, 'Studio', 'switch');
		input.entities.push(...switches.entities);
		input.policy = resolveEntityPolicy(input.entities, {
			version: 1,
			allow: [{domain: 'light'}, {domain: 'switch'}],
			deny: [],
		});
		const result = await run(input, 'Review Studio devices', [
			setIntent(),
			{
				entityId: switches.states[0]!.entity_id,
				action: 'turn_off',
				reason: 'Explicit switch target.',
			},
		]);
		expect(result.executionReadiness.commands).toHaveLength(4);
		expect(result.intentExpansion.sets[0]?.matchedCount).toBe(3);
	});

	it('includes controls when an observation term accompanies the collection', async () => {
		const result = await run(fixture(4), 'Studio occupancy is empty and the lights are on');
		expect(result.executionReadiness.commands).toHaveLength(4);
	});

	it('repeats the same complete expanded set regardless of entity input ordering', async () => {
		const input = fixture(20, 'Workshop', 'switch');
		const first = await run(input, 'Turn off all Workshop switches', [
			setIntent('Workshop', 'switch'),
		]);
		input.entities.reverse();
		const second = await run(input, 'Turn off all Workshop switches', [
			setIntent('Workshop', 'switch'),
		]);
		expect(second.executionReadiness.commands).toEqual(first.executionReadiness.commands);
	});

	it.each(['turn_on', 'turn_off'] as const)(
		'rejects overlapping %s intents through existing readiness',
		async (action) => {
			const result = await run(fixture(3), 'Turn off all Studio lights', [
				setIntent(),
				{...setIntent(), action},
			]);
			expect(result.executionReadiness.commands).toEqual([]);
			expect(result.executionReadiness.rejectedActions).toHaveLength(6);
			expect(
				result.executionReadiness.rejectedActions.every(
					(member) =>
						member.reason === (action === 'turn_on' ? 'conflicting_actions' : 'duplicate_action'),
				),
			).toBe(true);
		},
	);

	it('never executes an individual model subset of an explicit all request', async () => {
		const result = await run(fixture(4), 'Turn off all Studio lights', [
			{entityId: 'light.example_0', action: 'turn_off', reason: 'Model picked just one.'},
		]);
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.intentExpansion.rejectedIntents[0]?.reason).toBe('set_intent_required');
	});

	it('preserves ambiguous plural insufficient context without assuming all', async () => {
		const input = fixture(3);
		const result = await runPlanningPipeline(
			'Some Studio lights could change',
			input.entities,
			input.policy,
			{
				...options,
				chat: async () =>
					JSON.stringify({
						outcome: 'insufficient_context',
						summary: 'Proposed plan: Intended scope is ambiguous.',
						actions: [],
					}),
			},
		);
		expect(result.executionReadiness.outcome).toBe('insufficient_context');
		expect(result.executionReadiness.commands).toEqual([]);
	});

	it('budgets the complete scope catalogue and rejects overflow before model invocation', async () => {
		const input = fixture(20);
		const first = await run(input);
		expect(first.selection.kind).toBe('ready');
		if (first.selection.kind !== 'ready') {
			return;
		}

		const bytes = planningRequestBytes(
			{
				instruction: 'Turn off all Studio lights',
				states: first.selection.states,
				setScopes: first.selection.setScopes,
				intentMode: first.selection.intentMode,
			},
			options.model,
		);
		expect(first.selection.requestBytes).toBe(bytes);
		const chat = vi.fn<OllamaChatTransport>(async () => JSON.stringify(plan([setIntent()])));
		const second = await runPlanningPipeline(
			'Turn off all Studio lights',
			input.entities,
			input.policy,
			{...options, maxRequestBytes: bytes + outputHeadroomBytes - 1, chat},
		);
		expect(second.selection).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
		expect(second.executionReadiness.commands).toEqual([]);
		expect(chat).not.toHaveBeenCalled();
	});

	it('keeps registry IDs and excluded inventory out of model scope metadata', async () => {
		const input = fixture(3);
		const chat = vi.fn<OllamaChatTransport>(async () =>
			JSON.stringify(plan([setIntent('Making Space')])),
		);
		const result = await runPlanningPipeline(
			'Turn off all Making Space lights',
			input.entities,
			input.policy,
			{...options, chat},
		);
		const user = JSON.parse(chat.mock.calls[0]![0].messages[1]!.content) as {setScopes: unknown};
		expect(user.setScopes).toEqual([{area: 'Studio', aliases: ['Making Space'], domain: 'light'}]);
		expect(JSON.stringify(chat.mock.calls)).not.toContain('fixture_area');
		expect(result.executionReadiness.commands).toHaveLength(3);
	});

	it('refuses state-attribute area text without validated registry membership', async () => {
		const input = fixture(3);
		for (const state of input.states) {
			state.attributes.area_name = 'Studio';
		}

		input.entities = discoverEntities(input.states);
		const result = await run(input);
		expect(result.executionReadiness.commands).toEqual([]);
		expect(result.intentExpansion.rejectedIntents[0]?.reason).toBe('unknown_scope');
	});
});
