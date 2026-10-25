import {expect, it, vi} from 'vitest';
import type * as RegistryModule from '../src/observations/registry.js';

// Only this isolated test module receives the extended compile-time catalogue.
vi.mock('../src/observations/registry.js', async (importOriginal) => {
	const actual = await importOriginal<typeof RegistryModule>();
	const registry = actual.defineObservationRegistry([
		...actual.observationRegistry.definitions,
		{
			domain: 'sensor',
			deviceClass: 'example_test_measurement',
			kind: 'numeric',
			profile: {id: 'example_test_profile', phrases: ['example measurement']},
		},
	]);
	return {
		...actual,
		observationRegistry: registry,
		observationDeviceClassSchema: registry.deviceClassSchema,
	};
});

const {discoverEntities} = await import('../src/home-assistant/discovery.js');
const {runPlanningPipeline} = await import('../src/planning/pipeline.js');
const {resolveEntityPolicy} = await import('../src/policy/resolver.js');
const {buildAuditInventory} = await import('../src/audit/inventory.js');
const {auditInventory} = await import('../src/audit/rules.js');
const {observationDeviceClassSchema} = await import('../src/observations/registry.js');

it('a new declarative class flows through normalization, relevance, projection, planning, and audit without subsystem branches', async () => {
	const state = {
		entity_id: 'sensor.example_test_reading',
		state: '+1.5e2',
		attributes: {
			device_class: 'example_test_measurement',
			unit_of_measurement: 'example',
			friendly_name: 'example_test_measurement',
		},
		last_changed: '',
		last_updated: '',
	};
	const data = {
		states: [state],
		registries: {
			status: 'available' as const,
			entities: [
				{
					entity_id: state.entity_id,
					device_id: null,
					area_id: 'example_area',
					labels: [],
					disabled_by: null,
				},
			],
			devices: [],
			areas: [{area_id: 'example_area', name: 'Example Room', aliases: [], labels: []}],
			labels: [],
		},
		policy: {version: 1 as const, allow: [{entityId: state.entity_id}], deny: []},
		redactions: [],
	};
	const entities = discoverEntities(data.states, data.registries);
	const policy = resolveEntityPolicy(entities, data.policy);
	const chat = vi.fn(async () =>
		JSON.stringify({
			outcome: 'no_action',
			summary: 'Proposed plan: Reading is 150 example.',
			actions: [],
		}),
	);
	const result = await runPlanningPipeline(
		'What is the Example Room example measurement?',
		entities,
		policy,
		{model: 'example-model', maxRequestBytes: 100_000, chat},
	);
	expect(observationDeviceClassSchema.safeParse('example_test_measurement').success).toBe(true);
	expect(result.selection).toMatchObject({
		kind: 'ready',
		intentMode: 'observation_only',
		states: [],
		observations: [{deviceClass: 'example_test_measurement', state: '+1.5e2', unit: 'example'}],
	});
	expect(result.executionReadiness.commands).toEqual([]);
	const report = auditInventory(buildAuditInventory(data));
	expect(report.findings.find(({code}) => code === 'observation_readiness')?.details).toMatchObject(
		{normalizable: true, eligibleForPlanning: true, policyExposed: true},
	);
	expect(report.findings.some(({code}) => code === 'actionable_readiness')).toBe(false);
	expect(report.findings.some(({code}) => code === 'generic_friendly_name')).toBe(true);
	const denied = resolveEntityPolicy(entities, {
		...data.policy,
		deny: [{entityId: state.entity_id}],
	});
	chat.mockClear();
	const blocked = await runPlanningPipeline('Example Room example measurement?', entities, denied, {
		model: 'example-model',
		maxRequestBytes: 100_000,
		chat,
	});
	expect(blocked.selection).toEqual({kind: 'insufficient_context', reason: 'missing_observations'});
	expect(chat).not.toHaveBeenCalled();
});
