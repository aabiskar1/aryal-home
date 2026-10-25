import type {AuditData} from '../src/audit/collection.js';
import type {HistoricalState, LearningLocation} from '../src/home-assistant/history-schemas.js';
import type {LightingEpisode} from '../src/lighting-learning/events.js';
import {enrichEpisode} from '../src/lighting-learning/context.js';

export const location: LearningLocation = {time_zone: 'Europe/London', latitude: 0, longitude: 0};
export const at = (value: string) => Date.parse(value);
export const lightId = 'light.example_lamp';
export const sensorId = 'sensor.example_illuminance';
export const historical = (
	entity_id: string,
	state: string,
	time = '2026-10-10T20:00:00Z',
	attributes: Record<string, unknown> = {},
): HistoricalState => ({entity_id, state, attributes, last_changed: time, last_updated: time});
export const lux = (state = '30', time = '2026-10-10T19:59:00Z') =>
	historical(sensorId, state, time, {
		device_class: 'illuminance',
		unit_of_measurement: 'lx',
	});
export const transition = (time = '2026-10-10T20:00:00Z', id = lightId) => [
	historical(id, 'off', new Date(at(time) - 600_000).toISOString()),
	historical(id, 'on', time),
];
export const episode = (time = '2026-10-10T20:00:00Z', reading = 30): LightingEpisode => ({
	timestamp: at(time),
	entityIds: [lightId],
	provenance: 'interaction_supported',
	independent: true,
	lux: reading,
	luxAgeMs: 60_000,
	luxIssue: undefined,
	context: enrichEpisode(at(time), location),
});
export const stableEpisodes = () =>
	Array.from({length: 12}, (_, index) =>
		episode(
			`2026-10-${String(10 + Math.floor(index / 2)).padStart(2, '0')}T${index % 2 === 0 ? '20' : '21'}:00:00Z`,
			28 + (index % 5),
		),
	);

export const auditData = (): AuditData => ({
	states: [
		{...historical(lightId, 'off'), attributes: {friendly_name: 'Example Lamp'}},
		{...lux(), attributes: {...lux().attributes, friendly_name: 'Example Sensor'}},
	],
	registries: {
		status: 'available',
		entities: [lightId, sensorId].map((entity_id) => ({
			entity_id,
			device_id: 'example_device',
			area_id: null,
			labels: [],
			disabled_by: null,
		})),
		devices: [{id: 'example_device', area_id: 'example_area', labels: [], disabled_by: null}],
		areas: [
			{area_id: 'example_area', name: 'Example Room', aliases: ['Example Alias'], labels: []},
		],
		labels: [],
	},
	policy: {version: 1, allow: [{domain: 'light'}, {entityId: sensorId}], deny: []},
	redactions: ['private-test-token', 'https://ha.example.test'],
});
