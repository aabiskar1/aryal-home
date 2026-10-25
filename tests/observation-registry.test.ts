import {describe, expect, expectTypeOf, it} from 'vitest';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import {normalizeState} from '../src/home-assistant/state-normalizer.js';
import {toObservationState, type ObservationState} from '../src/planning/observations.js';
import {
	observationRegistry,
	observationDeviceClassSchema,
	type ObservationDeviceClass,
} from '../src/observations/registry.js';

const normalized = (domain: string, deviceClass: string, value: string, unit?: unknown) =>
	normalizeState(
		discoverEntities(
			[
				{
					entity_id: `${domain}.example_reading`,
					state: value,
					attributes: {
						friendly_name: 'Example Reading',
						device_class: deviceClass,
						unit_of_measurement: unit,
						secret_marker: 'must_not_leak',
						supportedActions: ['turn_on'],
					},
					last_changed: '',
					last_updated: '',
				},
			],
			{status: 'unavailable'},
		)[0]!,
	);

describe('declarative observation catalogue', () => {
	it('derives exactly the supported class schema and type from immutable definitions', () => {
		expect(observationDeviceClassSchema.options).toEqual(
			observationRegistry.definitions.map(({deviceClass}) => deviceClass),
		);
		expectTypeOf<ObservationDeviceClass>().toEqualTypeOf<ObservationState['deviceClass']>();
		expect(Object.isFrozen(observationRegistry)).toBe(true);
		expect(Object.isFrozen(observationRegistry.definitions)).toBe(true);
		for (const definition of observationRegistry.definitions) {
			expect(Object.isFrozen(definition)).toBe(true);
			expect(Object.isFrozen(definition.profile.phrases)).toBe(true);
			expect(observationDeviceClassSchema.parse(definition.deviceClass)).toBe(
				definition.deviceClass,
			);
		}

		expect(observationDeviceClassSchema.safeParse('pressure').success).toBe(false);
	});

	describe.each(observationRegistry.definitions)('$domain/$deviceClass', (definition) => {
		const {domain, deviceClass, kind} = definition;
		it('requires the exact registered domain and class', () => {
			const value = kind === 'binary' ? 'on' : '12.5';
			expect(toObservationState(normalized(domain, deviceClass, value))?.deviceClass).toBe(
				deviceClass,
			);
			for (const other of [
				'light',
				'switch',
				'person',
				domain === 'sensor' ? 'binary_sensor' : 'sensor',
			]) {
				expect(toObservationState(normalized(other, deviceClass, value))).toBeUndefined();
			}

			const upperCaseClass = deviceClass.toUpperCase();
			expect(toObservationState(normalized(domain, upperCaseClass, value))).toBeUndefined();
			expect(toObservationState(normalized(domain, 'unsupported', value))).toBeUndefined();
		});
		it.each([
			'',
			' ',
			'NaN',
			'Infinity',
			'-Infinity',
			'1e999',
			'unknown',
			'unavailable',
			'0xFF',
			'12 lx',
			'12foo',
			'1.2.3',
		])('rejects invalid evidence %j', (value) => {
			expect(toObservationState(normalized(domain, deviceClass, value))).toBeUndefined();
		});
		if (kind === 'numeric') {
			it.each(['0', '-12', '+12.5', '.25', '-.5', '1.', '1e2', '-1.5E-2', '  +2.50  '])(
				'preserves finite decimal evidence %j',
				(value) => {
					expect(toObservationState(normalized(domain, deviceClass, value, ' lx '))).toEqual({
						entityId: `${domain}.example_reading`,
						name: 'Example Reading',
						area: undefined,
						state: value,
						deviceClass,
						unit: 'lx',
					});
				},
			);
			it.each(['on', 'off'])('rejects binary value %s', (value) => {
				expect(toObservationState(normalized(domain, deviceClass, value))).toBeUndefined();
			});
		} else {
			it.each(['on', 'off'])('preserves only exact binary %s without unit metadata', (value) => {
				expect(toObservationState(normalized(domain, deviceClass, value))).toEqual({
					entityId: `${domain}.example_reading`,
					name: 'Example Reading',
					area: undefined,
					state: value,
					deviceClass,
				});
			});
			it.each(['ON', ' on ', '1', '0', 'true'])('rejects noncanonical binary %j', (value) => {
				expect(toObservationState(normalized(domain, deviceClass, value))).toBeUndefined();
			});
		}
	});
	it.each([undefined, '', ' ', 'a'.repeat(17), 42, {private: true}])(
		'omits invalid units %j without leaking attributes',
		(unit) => {
			const projection = toObservationState(normalized('sensor', 'illuminance', '25', unit));
			expect(projection).not.toHaveProperty('unit');
			expect(JSON.stringify(projection)).not.toContain('must_not_leak');
			expect(Object.keys(projection!)).toEqual([
				'entityId',
				'name',
				'area',
				'state',
				'deviceClass',
			]);
		},
	);
});
