import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import type {FixSnapshot} from '../src/audit/fixes/planning.js';
import {fingerprint} from '../src/audit/fixes/fingerprint.js';

export const fixState = (
	entityId: string,
	state = 'on',
	name = 'Example Lamp',
): HomeAssistantState => ({
	entity_id: entityId,
	state,
	attributes: {friendly_name: name},
	last_changed: '2000-01-01',
	last_updated: '2000-01-01',
});

export const fixFixture = (
	states = [fixState('light.example_stale', 'unavailable'), fixState('light.example_live')],
): FixSnapshot => {
	const policy = {version: 1 as const, allow: [{domain: 'light'}, {domain: 'switch'}], deny: []};
	const entities = states.map((state) => ({
		entity_id: state.entity_id,
		device_id: 'example_device',
		area_id: null,
		labels: [],
		disabled_by: null,
	}));
	return {
		data: {
			states,
			policy,
			redactions: [],
			registries: {
				status: 'available',
				entities,
				devices: [{id: 'example_device', area_id: 'example_room', labels: [], disabled_by: null}],
				areas: [{area_id: 'example_room', name: 'Example Room', aliases: [], labels: []}],
				labels: [],
			},
		},
		policyText: JSON.stringify(policy),
		registryEvidence: Object.fromEntries(
			entities.map((entry) => [
				entry.entity_id,
				{
					entry: structuredClone(entry),
					digest: fingerprint({...entry, unique_id: `example-${entry.entity_id}`}),
				},
			]),
		),
	};
};

export const fixRegistries = (snapshot: FixSnapshot) => {
	if (snapshot.data.registries.status !== 'available') {
		throw new Error('Fixture requires registries.');
	}

	return snapshot.data.registries;
};
