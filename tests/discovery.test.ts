import {describe, expect, it} from 'vitest';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';

const makeState = (entityId: string): HomeAssistantState => ({
	entity_id: entityId,
	state: 'on',
	attributes: {},
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

describe('discoverEntities', () => {
	it('discovers current entities and derives their domains from entity IDs', () => {
		const states = [makeState('light.example_light'), makeState('switch.example_switch')];

		expect(discoverEntities(states)).toEqual([
			{
				entityId: 'light.example_light',
				domain: 'light',
				homeAssistantState: states[0],
				metadata: {status: 'unavailable', reason: 'registry_failure'},
			},
			{
				entityId: 'switch.example_switch',
				domain: 'switch',
				homeAssistantState: states[1],
				metadata: {status: 'unavailable', reason: 'registry_failure'},
			},
		]);
	});
});
