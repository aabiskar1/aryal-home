import {describe, expect, it} from 'vitest';
import {validatePlan} from '../src/planning/policy.js';

const makeAction = (entityId: string, action: 'turn_on' | 'turn_off' = 'turn_off') => ({
	entityId,
	action,
	reason: 'The example entity should change power state.',
});

describe('validatePlan', () => {
	it.each([
		{entityId: 'light.example_light', action: 'turn_off' as const, domain: 'light'},
		{entityId: 'switch.example_switch', action: 'turn_on' as const, domain: 'switch'},
	])('resolves $entityId to an application-derived service', ({entityId, action, domain}) => {
		const proposedAction = makeAction(entityId, action);
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change the allowed example entity.',
				actions: [proposedAction],
			},
			{
				allowedEntityIds: new Set([entityId]),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.outcome).toBe('propose_actions');
		expect(result.actions).toEqual([{...proposedAction, domain, service: action}]);
		expect(result.rejectedActions).toEqual([]);
	});

	it('rejects an action for an unlisted entity', () => {
		const action = makeAction('light.example_unlisted');
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Turn off an unlisted example light.',
				actions: [action],
			},
			{
				allowedEntityIds: new Set(['light.example_allowed']),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.outcome).toBe('no_action');
		expect(result.summary).toContain('deterministic post-model validation');
		expect(result.actions).toEqual([]);
		expect(result.rejectedActions).toEqual([{action, reason: 'not_allowed'}]);
	});

	it('gives the deny list precedence over allow and capability validation', () => {
		const entityId = 'sensor.example_denied';
		const action = makeAction(entityId);
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change a denied example entity.',
				actions: [action],
			},
			{
				allowedEntityIds: new Set([entityId]),
				deniedEntityIds: new Set([entityId]),
			},
		);

		expect(result.actions).toEqual([]);
		expect(result.rejectedActions).toEqual([{action, reason: 'denied'}]);
	});

	it('checks allow policy before capability validation', () => {
		const action = makeAction('sensor.example_unlisted');
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change an unlisted example sensor.',
				actions: [action],
			},
			{
				allowedEntityIds: new Set(),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.rejectedActions).toEqual([{action, reason: 'not_allowed'}]);
	});

	it('rejects canonical actions for unsupported domains', () => {
		const action = makeAction('sensor.example_temperature');
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change an example sensor.',
				actions: [action],
			},
			{
				allowedEntityIds: new Set([action.entityId]),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.outcome).toBe('no_action');
		expect(result.actions).toEqual([]);
		expect(result.rejectedActions).toEqual([{action, reason: 'unsupported_action'}]);
	});

	it('separates accepted and rejected actions in a mixed plan', () => {
		const accepted = makeAction('light.example_allowed');
		const rejected = makeAction('sensor.example_sensor');
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Evaluate two example entities.',
				actions: [accepted, rejected],
			},
			{
				allowedEntityIds: new Set([accepted.entityId, rejected.entityId]),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.outcome).toBe('propose_actions');
		expect(result.actions).toEqual([{...accepted, domain: 'light', service: 'turn_off'}]);
		expect(result.rejectedActions).toEqual([{action: rejected, reason: 'unsupported_action'}]);
	});

	it('does not admit model-controlled routing fields into validated actions', () => {
		const proposedAction = makeAction('light.example_allowed');
		const untrustedAction = {
			...proposedAction,
			domain: 'switch',
			service: 'switch.turn_off',
			data: {unexpected: true},
		};
		const result = validatePlan(
			{
				outcome: 'propose_actions',
				summary: 'Proposed plan: Change the allowed example light.',
				actions: [untrustedAction],
			},
			{
				allowedEntityIds: new Set([proposedAction.entityId]),
				deniedEntityIds: new Set(),
			},
		);

		expect(result.actions).toEqual([{...proposedAction, domain: 'light', service: 'turn_off'}]);
		expect(JSON.stringify(result)).not.toContain('switch.turn_off');
		expect(JSON.stringify(result)).not.toContain('unexpected');
	});
});
