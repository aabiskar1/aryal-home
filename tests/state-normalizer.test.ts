import {describe, expect, it} from 'vitest';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import {normalizeState, normalizeStates} from '../src/home-assistant/state-normalizer.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';

const makeState = (
	entityId: string,
	state: string,
	attributes: Record<string, unknown> = {},
): HomeAssistantState => ({
	entity_id: entityId,
	state,
	attributes,
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

describe('state normalization', () => {
	it('normalizes a discovered entity', () => {
		const [entity] = discoverEntities([
			makeState('light.example_kitchen_light', 'on', {
				friendly_name: 'Example Kitchen Light',
			}),
		]);

		expect(entity).toBeDefined();
		expect(normalizeState(entity!)).toEqual({
			entityId: 'light.example_kitchen_light',
			domain: 'light',
			state: 'on',
			name: 'Example Kitchen Light',
			area: undefined,
			deviceClass: undefined,
			unit: undefined,
			supportedActions: ['turn_on', 'turn_off'],
		});
	});

	it('exposes no supported actions for an unknown domain', () => {
		const [entity] = discoverEntities([makeState('sensor.example_temperature', '21')]);

		expect(normalizeState(entity!).supportedActions).toEqual([]);
	});

	it.each(['unavailable', 'unknown'])('exposes no supported actions for a %s light', (value) => {
		const [entity] = discoverEntities([makeState('light.example_light', value)]);

		expect(normalizeState(entity!).supportedActions).toEqual([]);
	});

	it('normalizes a collection of discovered entities', () => {
		const entities = discoverEntities([
			makeState('light.example_kitchen_light', 'on'),
			makeState('light.example_hallway', 'off'),
		]);

		expect(normalizeStates(entities).map((entity) => entity.entityId)).toEqual([
			'light.example_kitchen_light',
			'light.example_hallway',
		]);
	});

	it('uses the validated effective area name and narrow observation attributes', () => {
		const [entity] = discoverEntities(
			[
				makeState('sensor.example_temperature', '21', {
					friendly_name: 'Room Reading',
					area_name: 'Stale Room',
					device_class: 'temperature',
					unit_of_measurement: '°C',
				}),
			],
			{
				status: 'available',
				entities: [
					{
						entity_id: 'sensor.example_temperature',
						device_id: null,
						area_id: 'example_area',
						labels: [],
						disabled_by: null,
					},
				],
				devices: [],
				areas: [
					{area_id: 'example_area', name: 'Example Room', aliases: ['Example Alias'], labels: []},
				],
				labels: [],
			},
		);

		expect(normalizeState(entity!)).toMatchObject({
			area: 'Example Room',
			deviceClass: 'temperature',
			unit: '°C',
			supportedActions: [],
		});
	});
});
