import {describe, expect, it} from 'vitest';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {RegistrySnapshot} from '../src/home-assistant/registry-client.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';

const state = (entityId: string, value = 'on'): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {},
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

const snapshot = (): Extract<RegistrySnapshot, {status: 'available'}> => ({
	status: 'available',
	entities: [
		{
			entity_id: 'light.example_one',
			device_id: 'device_child',
			area_id: 'area_override',
			labels: ['label_entity'],
			disabled_by: null,
		},
		{
			entity_id: 'light.example_two',
			device_id: 'device_child',
			area_id: null,
			labels: [],
			disabled_by: null,
		},
	],
	devices: [
		{
			id: 'device_child',
			area_id: null,
			parent_device_id: 'device_parent',
			labels: ['label_device'],
			disabled_by: null,
		},
		{
			id: 'device_parent',
			area_id: 'area_parent',
			parent_device_id: null,
			labels: ['label_parent'],
			disabled_by: null,
		},
	],
	areas: [
		{
			area_id: 'area_override',
			name: 'Example Override',
			aliases: ['Example Alias'],
			labels: ['label_area'],
		},
		{area_id: 'area_parent', name: 'Example Parent', aliases: [], labels: []},
	],
	labels: ['label_entity', 'label_device', 'label_parent', 'label_area'].map((label_id) => ({
		label_id,
	})),
});

describe('registry-backed discovery', () => {
	it('joins only REST states and preserves label provenance and entity area override', () => {
		const registries = snapshot();
		registries.entities.push({
			entity_id: 'light.registry_only',
			device_id: null,
			area_id: null,
			labels: [],
			disabled_by: null,
		});
		const entities = discoverEntities([state('light.example_one')], registries);

		expect(entities).toHaveLength(1);
		expect(entities[0]?.metadata).toEqual({
			status: 'available',
			deviceId: 'device_child',
			areaId: 'area_override',
			areaName: 'Example Override',
			areaAliases: ['Example Alias'],
			labels: {entity: ['label_entity'], device: ['label_device'], area: ['label_area']},
			disabled: false,
		});
	});

	it('inherits a parent area only when the child has no area, never parent labels', () => {
		const [entity] = discoverEntities([state('light.example_two')], snapshot());

		expect(entity?.metadata).toMatchObject({
			areaId: 'area_parent',
			labels: {entity: [], device: ['label_device'], area: []},
		});
	});

	it('uses a direct device area before parent area', () => {
		const registries = snapshot();
		registries.devices[0]!.area_id = 'area_override';
		const [entity] = discoverEntities([state('light.example_two')], registries);

		expect(entity?.metadata).toMatchObject({areaId: 'area_override'});
	});

	it('treats a state without a registry entry as known to have no registry selectors', () => {
		const [entity] = discoverEntities([state('light.unregistered')], snapshot());

		expect(entity?.metadata).toEqual({
			status: 'available',
			deviceId: undefined,
			areaId: undefined,
			areaName: undefined,
			areaAliases: [],
			labels: {entity: [], device: [], area: []},
			disabled: false,
		});
	});

	it.each(['missing device', 'missing area', 'missing label', 'missing parent'])(
		'withholds incomplete %s metadata',
		(caseName) => {
			const registries = snapshot();

			switch (caseName) {
				case 'missing device': {
					registries.devices.shift();
					break;
				}

				case 'missing area': {
					registries.areas.shift();
					break;
				}

				case 'missing label': {
					registries.labels.shift();
					break;
				}

				default: {
					registries.devices.pop();
				}
			}

			expect(discoverEntities([state('light.example_one')], registries)[0]?.metadata).toEqual({
				status: 'unavailable',
				reason: 'incomplete',
			});
		},
	);

	it('excludes disabled entities and devices from authorization', () => {
		const registries = snapshot();
		registries.entities[0]!.disabled_by = 'user';
		registries.devices[0]!.disabled_by = 'integration';
		const entities = discoverEntities(
			[state('light.example_one'), state('light.example_two')],
			registries,
		);
		const result = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{domain: 'light'}],
			deny: [],
		});

		expect([...result.allowedEntityIds]).toEqual([]);
		expect([...result.deniedEntityIds]).toEqual(['light.example_one', 'light.example_two']);
	});

	it('withholds control even for a v1 policy when a present registry relationship is incomplete', () => {
		const registries = snapshot();
		registries.devices.shift();
		const entities = discoverEntities([state('light.example_one')], registries);
		const result = resolveEntityPolicy(entities, {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [],
		});

		expect(result.allowedEntityIds.size).toBe(0);
		expect([...result.deniedEntityIds]).toEqual(['light.example_one']);
	});

	it('rejects unavailable and unknown REST states even if the policy allows them', () => {
		const entities = discoverEntities(
			[state('light.example_one', 'unavailable'), state('light.example_two', 'unknown')],
			snapshot(),
		);
		const result = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{domain: 'light'}],
			deny: [],
		});

		expect([...result.allowedEntityIds]).toEqual([]);
		expect(result.deniedEntityIds.size).toBe(2);
	});

	it('matches entity, device, and effective-area labels but not parent-device labels', () => {
		const [entity] = discoverEntities([state('light.example_one')], snapshot());

		for (const labelId of ['label_entity', 'label_device', 'label_area']) {
			const result = resolveEntityPolicy([entity!], {
				version: 2,
				allow: [{labelId}],
				deny: [],
			});
			expect(result.allowedEntityIds.has(entity!.entityId)).toBe(true);
		}

		const parentOnly = resolveEntityPolicy([entity!], {
			version: 2,
			allow: [{labelId: 'label_parent'}],
			deny: [],
		});
		expect(parentOnly.allowedEntityIds.size).toBe(0);
	});

	it('applies device-wide denies and AND within a selector', () => {
		const entities = discoverEntities(
			[state('light.example_one'), state('light.example_two')],
			snapshot(),
		);
		const result = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{domain: 'light', areaId: 'area_override'}, {entityId: 'light.example_two'}],
			deny: [{deviceId: 'device_child'}],
		});

		expect(result.allowedEntityIds.size).toBe(0);
		expect(result.deniedEntityIds.size).toBe(2);
	});

	it('allows REST-only v1 rules but blocks uncertain registry-dependent denies', () => {
		const entities = discoverEntities([state('light.example_one')], {status: 'unavailable'});
		const fallback = resolveEntityPolicy(entities, {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [{entityId: 'light.other'}],
		});
		const uncertainDeny = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{domain: 'light'}],
			deny: [{domain: 'light', areaId: 'area_override'}],
		});
		const certainMismatch = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{domain: 'light'}],
			deny: [{domain: 'switch', areaId: 'area_override'}],
		});

		expect([...fallback.allowedEntityIds]).toEqual(['light.example_one']);
		expect([...uncertainDeny.deniedEntityIds]).toEqual(['light.example_one']);
		expect([...certainMismatch.allowedEntityIds]).toEqual(['light.example_one']);
	});

	it('never grants on uncertain registry-dependent allow selectors', () => {
		const entities = discoverEntities([state('light.example_one')], {status: 'unavailable'});
		const result = resolveEntityPolicy(entities, {
			version: 2,
			allow: [{deviceId: 'device_child'}, {domain: 'switch', labelId: 'label_area'}],
			deny: [],
		});

		expect(result.allowedEntityIds.size).toBe(0);
	});
});
