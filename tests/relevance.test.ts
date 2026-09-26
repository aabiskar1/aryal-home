import {describe, expect, it} from 'vitest';
import {planningRequestBytes} from '../src/planning/planner.js';
import {
	outputHeadroomBytes,
	selectRelevantContext,
	type RelevanceCandidate,
} from '../src/planning/relevance.js';

const candidate = (
	entityId: string,
	name: string,
	area?: string,
	options: {areaAliases?: string[]; deviceClass?: string} = {},
): RelevanceCandidate => {
	const domain = entityId.split('.', 1)[0] ?? '';

	return {
		state: {
			entityId,
			domain,
			state: 'on',
			name,
			area,
			deviceClass: options.deviceClass,
			supportedActions: domain === 'light' || domain === 'switch' ? ['turn_on', 'turn_off'] : [],
		},
		areaAliases: options.areaAliases ?? [],
	};
};

const candidates = [
	candidate('light.example_kitchen_ceiling', 'Ceiling Light', 'Kitchen', {areaAliases: ['Galley']}),
	candidate('light.example_kitchen_counter', 'Counter Light', 'Kitchen', {areaAliases: ['Galley']}),
	candidate('light.example_bedroom_lamp', 'Bedroom Lamp', 'Bedroom'),
	candidate('light.example_bedroom_ceiling', 'Ceiling Light', 'Bedroom'),
	candidate('sensor.example_bedroom_temperature', 'Room Reading', 'Bedroom', {
		deviceClass: 'temperature',
	}),
	candidate('sensor.example_kitchen_temperature', 'Kitchen Temperature', 'Kitchen', {
		deviceClass: 'temperature',
	}),
	candidate('person.example_person', 'Example Person'),
	candidate('binary_sensor.example_occupancy', 'Occupancy', 'Hall', {deviceClass: 'occupancy'}),
	candidate('binary_sensor.example_motion', 'Motion', 'Hall'),
	candidate('weather.example_forecast', 'Forecast'),
];

const options = {model: 'example-model', maxRequestBytes: 100_000};

const selectedIds = (instruction: string, input = candidates): string[] => {
	const result = selectRelevantContext(instruction, input, options);
	expect(result.kind).toBe('ready');

	return result.kind === 'ready' ? result.states.map((state) => state.entityId) : [];
};

describe('selectRelevantContext', () => {
	it('selects an exact entity ID without using substring matches', () => {
		expect(selectedIds('Turn on light.example_bedroom_lamp')).toEqual([
			'light.example_bedroom_lamp',
		]);
		expect(selectRelevantContext('Turn on kitchenettes lights', candidates, options)).toEqual({
			kind: 'insufficient_context',
			reason: 'no_permitted_match',
		});
	});

	it('includes every permitted entity sharing an exact friendly name', () => {
		expect(selectedIds('Turn on Ceiling Light')).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_bedroom_ceiling',
		]);
	});

	it('intersects area and domain, including an area alias', () => {
		expect(selectedIds('Turn on kitchen lights')).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_kitchen_counter',
		]);
		expect(selectedIds('Turn off all Galley lights')).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_kitchen_counter',
		]);
	});

	it('includes all room lights even if one entity is literally named Kitchen Lights', () => {
		const withGroup = [
			...candidates,
			candidate('light.example_kitchen_group', 'Kitchen Lights', 'Kitchen'),
		];

		expect(selectedIds('Turn on kitchen lights', withGroup)).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_kitchen_counter',
			'light.example_kitchen_group',
		]);
	});

	it('selects a named bedroom lamp without selecting every bedroom light', () => {
		expect(selectedIds('Turn on bedroom lamp')).toEqual(['light.example_bedroom_lamp']);
	});

	it('treats all lights as whole-home unless an area also matches', () => {
		expect(selectedIds('Turn off all lights')).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_kitchen_counter',
			'light.example_bedroom_lamp',
			'light.example_bedroom_ceiling',
		]);
		expect(selectedIds('Turn off all kitchen lights')).toEqual([
			'light.example_kitchen_ceiling',
			'light.example_kitchen_counter',
		]);
	});

	it('selects permitted temperature observations in the named area', () => {
		expect(selectedIds("What's the bedroom temperature?")).toEqual([
			'sensor.example_bedroom_temperature',
		]);
	});

	it('selects presence observations without treating motion as proof of presence', () => {
		expect(selectedIds('Is anyone home?')).toEqual([
			'person.example_person',
			'binary_sensor.example_occupancy',
		]);
	});

	it('selects weather observations', () => {
		expect(selectedIds("What's the weather?")).toEqual(['weather.example_forecast']);
	});

	it('falls back to complete permitted context for ambiguous requests', () => {
		for (const instruction of ["I'm going to bed", 'Please assess the home']) {
			const result = selectRelevantContext(instruction, candidates, options);
			expect(result.kind).toBe('ready');
			if (result.kind === 'ready') {
				expect(result.mode).toBe('fallback');
				expect(result.states).toHaveLength(candidates.length);
			}
		}
	});

	it('does not broaden a clearly targeted request when metadata or permitted matches are missing', () => {
		const noArea = [candidate('light.example_other', 'Ceiling Light')];
		expect(selectRelevantContext('Turn on kitchen lights', noArea, options)).toEqual({
			kind: 'insufficient_context',
			reason: 'no_permitted_match',
		});
		expect(selectRelevantContext('Turn on light.example_missing', candidates, options)).toEqual({
			kind: 'insufficient_context',
			reason: 'no_permitted_match',
		});
		expect(selectRelevantContext('Is anyone home?', [candidates[8]!], options)).toEqual({
			kind: 'insufficient_context',
			reason: 'no_permitted_match',
		});
	});

	it('measures the complete request and never silently truncates an over-budget selection', () => {
		const instruction = 'Turn off all lights';
		const states = candidates.slice(0, 4).map((item) => item.state);
		const exactBytes = planningRequestBytes({instruction, states}, options.model);
		const ready = selectRelevantContext(instruction, candidates, {
			...options,
			maxRequestBytes: exactBytes + outputHeadroomBytes,
		});
		const overflow = selectRelevantContext(instruction, candidates, {
			...options,
			maxRequestBytes: exactBytes + outputHeadroomBytes - 1,
		});

		expect(exactBytes).toBeGreaterThan(JSON.stringify(states).length);
		expect(ready.kind).toBe('ready');
		expect(overflow).toEqual({kind: 'insufficient_context', reason: 'over_budget'});
	});
});
