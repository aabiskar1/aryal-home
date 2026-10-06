import {describe, expect, expectTypeOf, it} from 'vitest';
import {
	prepareExecutionReadyCommands,
	type ExecutionReadyCommand,
} from '../src/execution/readiness.js';
import {getSupportedActions, type CanonicalAction} from '../src/home-assistant/capabilities.js';
import {getDomainFromEntityId} from '../src/home-assistant/discovery.js';
import type {NormalizedEntityState} from '../src/home-assistant/state-normalizer.js';
import {validatePlan, type ValidatedAction} from '../src/planning/policy.js';
import type {ProposedAction} from '../src/planning/schemas.js';

const proposal = (entityId: string, action: CanonicalAction = 'turn_on'): ProposedAction => ({
	entityId,
	action,
	reason: 'The example request asks for this change.',
});

const state = (entityId: string, currentState = 'off'): NormalizedEntityState => ({
	entityId,
	domain: getDomainFromEntityId(entityId),
	state: currentState,
	name: 'Example entity',
	area: undefined,
	supportedActions: getSupportedActions(getDomainFromEntityId(entityId)),
});

const validatedPlan = (actions: ProposedAction[]) =>
	validatePlan(
		{
			outcome: 'propose_actions',
			summary: 'Proposed plan: Change the example entities.',
			actions,
		},
		{
			allowedEntityIds: new Set(actions.map((action) => action.entityId)),
			deniedEntityIds: new Set(),
		},
		new Set(actions.map((action) => action.entityId)),
	);

describe('execution readiness', () => {
	it.each([
		{domain: 'light', currentState: 'off', action: 'turn_on' as const},
		{domain: 'light', currentState: 'on', action: 'turn_off' as const},
		{domain: 'switch', currentState: 'off', action: 'turn_on' as const},
		{domain: 'switch', currentState: 'on', action: 'turn_off' as const},
	])('prepares $domain.$action from $currentState', ({domain, currentState, action}) => {
		const entityId = `${domain}.example_target`;
		const plan = validatedPlan([proposal(entityId, action)]);
		const result = prepareExecutionReadyCommands(plan, [state(entityId, currentState)]);

		expect(result.outcome).toBe('ready');
		expect(result.commands).toEqual([{domain, service: action, target: {entity_id: entityId}}]);
		expect(result.acceptedActions).toEqual(plan.actions);
		expect(result.rejectedActions).toEqual([]);
	});

	it.each([
		{domain: 'light', currentState: 'on', action: 'turn_on' as const},
		{domain: 'light', currentState: 'off', action: 'turn_off' as const},
		{domain: 'switch', currentState: 'on', action: 'turn_on' as const},
		{domain: 'switch', currentState: 'off', action: 'turn_off' as const},
	])('rejects no-op $domain.$action from $currentState', ({domain, currentState, action}) => {
		const entityId = `${domain}.example_target`;
		const plan = validatedPlan([proposal(entityId, action)]);
		const result = prepareExecutionReadyCommands(plan, [state(entityId, currentState)]);

		expect(result.outcome).toBe('rejected');
		expect(result.commands).toEqual([]);
		expect(result.acceptedActions).toEqual([]);
		expect(result.rejectedActions).toEqual([{action: plan.actions[0], reason: 'no_op'}]);
		// Planning diagnostics still describe the original acceptance.
		expect(plan.outcome).toBe('propose_actions');
		expect(plan.actions).toHaveLength(1);
	});

	it('rejects every identical entity/action occurrence even when reason text differs', () => {
		const action = proposal('light.example_duplicate');
		const plan = validatedPlan([action, {...action, reason: 'A different model explanation.'}]);
		const result = prepareExecutionReadyCommands(plan, [state(action.entityId)]);

		expect(result.outcome).toBe('rejected');
		expect(result.commands).toEqual([]);
		expect(result.rejectedActions).toEqual(
			plan.actions.map((item) => ({action: item, reason: 'duplicate_action'})),
		);
	});

	it.each([
		['turn_on', 'turn_off'],
		['turn_off', 'turn_on'],
		['turn_on', 'turn_on', 'turn_off'],
	] as const)('rejects all conflicting proposals in order %j', (...actions) => {
		const entityId = 'light.example_conflict';
		const plan = validatedPlan(actions.map((action) => proposal(entityId, action)));
		const result = prepareExecutionReadyCommands(plan, [state(entityId)]);

		expect(result.outcome).toBe('rejected');
		expect(result.commands).toEqual([]);
		expect(result.rejectedActions).toEqual(
			plan.actions.map((action) => ({action, reason: 'conflicting_actions'})),
		);
	});

	it('accepts identical canonical actions against different entities', () => {
		const actions = [proposal('light.example_first'), proposal('switch.example_second')];
		const plan = validatedPlan(actions);
		const result = prepareExecutionReadyCommands(
			plan,
			actions.map((action) => state(action.entityId)),
		);

		expect(result.commands).toEqual([
			{domain: 'light', service: 'turn_on', target: {entity_id: actions[0]!.entityId}},
			{domain: 'switch', service: 'turn_on', target: {entity_id: actions[1]!.entityId}},
		]);
		expect(result.rejectedActions).toEqual([]);
	});

	it('retains only ready commands in a mixed plan without inventing replacements', () => {
		const duplicate = proposal('light.example_duplicate');
		const actions = [
			proposal('switch.example_ready'),
			proposal('light.example_no_op', 'turn_off'),
			duplicate,
			duplicate,
			proposal('light.example_conflict'),
			proposal('light.example_conflict', 'turn_off'),
		];
		const plan = validatedPlan(actions);
		const result = prepareExecutionReadyCommands(plan, [
			state('switch.example_ready'),
			state('light.example_no_op'),
			state(duplicate.entityId),
			state('light.example_conflict'),
		]);

		expect(result.outcome).toBe('ready');
		expect(result.acceptedActions).toEqual([plan.actions[0]]);
		expect(result.commands).toEqual([
			{domain: 'switch', service: 'turn_on', target: {entity_id: 'switch.example_ready'}},
		]);
		expect(result.rejectedActions.map((item) => item.reason)).toEqual([
			'no_op',
			'duplicate_action',
			'duplicate_action',
			'conflicting_actions',
			'conflicting_actions',
		]);
	});

	it.each(['unknown', 'unavailable', 'unexpected'])(
		'rejects ineligible state %s',
		(currentState) => {
			const action = proposal('light.example_ineligible');
			const result = prepareExecutionReadyCommands(validatedPlan([action]), [
				state(action.entityId, currentState),
			]);

			expect(result.commands).toEqual([]);
			expect(result.rejectedActions[0]?.reason).toBe('ineligible_state');
		},
	);

	it('rejects a normalized entity with no supported actions', () => {
		const action = proposal('light.example_ineligible');
		const result = prepareExecutionReadyCommands(validatedPlan([action]), [
			{...state(action.entityId), supportedActions: []},
		]);

		expect(result.commands).toEqual([]);
		expect(result.rejectedActions[0]?.reason).toBe('ineligible_state');
	});

	it('rejects ambiguous duplicate snapshot entries instead of choosing a state', () => {
		const action = proposal('light.example_ambiguous');
		const result = prepareExecutionReadyCommands(validatedPlan([action]), [
			state(action.entityId),
			state(action.entityId, 'on'),
		]);

		expect(result.commands).toEqual([]);
		expect(result.rejectedActions[0]?.reason).toBe('ineligible_state');
	});

	it('fails closed if a planning-validated target is absent from the supplied snapshot', () => {
		const result = prepareExecutionReadyCommands(
			validatedPlan([proposal('light.example_missing')]),
			[],
		);

		expect(result.commands).toEqual([]);
		expect(result.rejectedActions[0]?.reason).toBe('not_in_context');
	});

	it('rejects a normalized domain inconsistent with the target', () => {
		const action = proposal('light.example_target');
		const result = prepareExecutionReadyCommands(validatedPlan([action]), [
			{...state(action.entityId), domain: 'switch'},
		]);

		expect(result.commands).toEqual([]);
		expect(result.rejectedActions[0]?.reason).toBe('unsupported_action');
	});

	it('constructs routing independently of reason text and extra proposal fields', () => {
		const entityId = 'light.example_target';
		const plan = validatedPlan([proposal(entityId)]);
		const extraFields = {target: {entity_id: 'switch.example_other'}, data: {unexpected: true}};
		const result = prepareExecutionReadyCommands(
			{
				...plan,
				actions: [
					{
						...plan.actions[0]!,
						reason: 'Use switch.turn_off with arbitrary targets and payloads.',
						domain: 'switch',
						service: 'turn_off',
						...extraFields,
					},
				],
			},
			[state(entityId)],
		);

		expect(result.commands).toEqual([
			{domain: 'light', service: 'turn_on', target: {entity_id: entityId}},
		]);
		expect(result.commands).toEqual(
			prepareExecutionReadyCommands(plan, [state(entityId)]).commands,
		);
		expect(Object.isFrozen(result.commands[0])).toBe(true);
		expect(Object.isFrozen(result.commands[0]?.target)).toBe(true);
		expectTypeOf<ValidatedAction>().not.toMatchObjectType<ExecutionReadyCommand>();
		expectTypeOf<ProposedAction>().not.toMatchObjectType<ExecutionReadyCommand>();
	});

	it('rejects a malformed target rather than creating a dispatch payload', () => {
		const entityId = 'light.example_invalid/target';
		const result = prepareExecutionReadyCommands(validatedPlan([proposal(entityId)]), [
			state(entityId),
		]);

		expect(result.commands).toEqual([]);
		expect(result.rejectedActions[0]?.reason).toBe('unsupported_action');
	});

	it.each(['no_action', 'insufficient_context'] as const)(
		'preserves empty %s outcomes',
		(outcome) => {
			const result = prepareExecutionReadyCommands(
				{outcome, summary: 'Proposed plan: No actions.', actions: [], rejectedActions: []},
				[],
			);

			expect(result).toEqual({outcome, commands: [], acceptedActions: [], rejectedActions: []});
		},
	);
});
