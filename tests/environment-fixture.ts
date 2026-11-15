import type {AuditData} from '../src/audit/collection.js';
import {selectEnvironmentContext} from '../src/assessment/environment-context.js';
import {environmentProposalSchema} from '../src/assessment/environment-schemas.js';
import {assessmentData, addEntity, now} from './assessment-fixture.js';
import {historical, location} from './lighting-learning-fixture.js';

export const temperatureId = 'sensor.example_room_temperature';
export const humidityId = 'sensor.example_room_humidity';
export const weatherId = 'weather.example_current';
export const stateFor = (data: AuditData, id: string) =>
	data.states.find((state) => state.entity_id === id)!;
export const registriesFor = (data: AuditData) => {
	if (data.registries.status !== 'available') {
		throw new Error('fixture');
	}

	return data.registries;
};

export const environmentData = () => {
	const data = assessmentData();
	addEntity(
		data,
		historical(temperatureId, '23', '2026-10-10T19:59:00Z', {
			device_class: 'temperature',
			unit_of_measurement: '°C',
		}),
	);
	addEntity(
		data,
		historical(humidityId, '65', '2026-10-10T19:59:00Z', {
			device_class: 'humidity',
			unit_of_measurement: '%',
		}),
	);
	addEntity(
		data,
		historical(weatherId, 'rainy', '2026-10-10T19:59:00Z', {
			temperature: 16,
			temperature_unit: '°C',
			humidity: 50,
		}),
	);
	return data;
};

export const selectedEnvironment = (
	data = environmentData(),
	extra: Partial<Parameters<typeof selectEnvironmentContext>[0]> = {},
) => selectEnvironmentContext({data, area: 'Example Room', location, now, ...extra});
export const environmentProposal = (extra: Record<string, unknown> = {}) =>
	environmentProposalSchema.parse({
		outcome: 'insight',
		category: 'temperature_comparison',
		evidenceRefs: ['indoor_2', 'weather_1', 'outdoor_temperature'],
		temperatureRelation: 'indoor_warmer',
		humidityRelation: 'not_compared',
		weatherCondition: 'rainy',
		presence: 'detected',
		rationale:
			'Compare current indoor and outdoor conditions while preserving unknown preferences.',
		...extra,
	});
