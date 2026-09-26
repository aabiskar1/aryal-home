import {describe, expect, it} from 'vitest';
import {ZodError} from 'zod';
import {discoverEntities} from '../src/home-assistant/discovery.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';
import {resolveEntityPolicy} from '../src/policy/resolver.js';
import {entityPolicySchema, type EntityPolicy} from '../src/policy/schemas.js';

const makeState = (entityId: string): HomeAssistantState => ({
	entity_id: entityId,
	state: 'on',
	attributes: {},
	last_changed: '2026-09-09T20:00:00+00:00',
	last_updated: '2026-09-09T20:00:00+00:00',
});

const resolve = (entityIds: string[], policy: EntityPolicy) =>
	resolveEntityPolicy(discoverEntities(entityIds.map((entityId) => makeState(entityId))), policy);

const entityIds = (values: ReadonlySet<string>): string[] => [...values];

describe('resolveEntityPolicy', () => {
	it('permits nothing when allow is empty', () => {
		const result = resolve(['light.example_light'], {version: 1, allow: [], deny: []});

		expect(entityIds(result.allowedEntityIds)).toEqual([]);
	});

	it('allows an explicitly selected entity', () => {
		const result = resolve(['light.example_light'], {
			version: 1,
			allow: [{entityId: 'light.example_light'}],
			deny: [],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual(['light.example_light']);
	});

	it('allows entities selected by domain', () => {
		const result = resolve(['light.example_light'], {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual(['light.example_light']);
	});

	it('allows multiple discovered entities matching a domain selector', () => {
		const result = resolve(['light.example_one', 'switch.example_switch', 'light.example_two'], {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual(['light.example_one', 'light.example_two']);
	});

	it('does not allow an entity that matches no allow selector', () => {
		const result = resolve(['switch.example_switch'], {
			version: 1,
			allow: [{domain: 'light'}, {entityId: 'switch.example_other'}],
			deny: [],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual([]);
	});

	it('denies an explicitly selected entity', () => {
		const result = resolve(['light.example_light'], {
			version: 1,
			allow: [{domain: 'light'}],
			deny: [{entityId: 'light.example_light'}],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual([]);
		expect(entityIds(result.deniedEntityIds)).toEqual(['light.example_light']);
	});

	it('denies entities selected by domain', () => {
		const result = resolve(['light.example_light', 'switch.example_switch'], {
			version: 1,
			allow: [{domain: 'light'}, {domain: 'switch'}],
			deny: [{domain: 'switch'}],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual(['light.example_light']);
		expect(entityIds(result.deniedEntityIds)).toEqual(['switch.example_switch']);
	});

	it('gives deny selectors precedence over allow selectors', () => {
		const result = resolve(['light.example_light'], {
			version: 1,
			allow: [{entityId: 'light.example_light'}],
			deny: [{domain: 'light'}],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual([]);
		expect(entityIds(result.deniedEntityIds)).toEqual(['light.example_light']);
	});

	it('requires every field in a selector to match', () => {
		const result = resolve(['light.example_light', 'switch.example_switch'], {
			version: 1,
			allow: [{entityId: 'light.example_light', domain: 'switch'}],
			deny: [],
		});

		expect(entityIds(result.allowedEntityIds)).toEqual([]);
	});
});

describe('entityPolicySchema', () => {
	it.each([
		{name: 'an empty selector', policy: {version: 1, allow: [{}], deny: []}},
		{
			name: 'an unknown policy field',
			policy: {version: 1, allow: [], deny: [], unexpected: true},
		},
		{
			name: 'an unknown selector field',
			policy: {version: 1, allow: [{areaId: 'example_area'}], deny: []},
		},
		{name: 'an unsupported version', policy: {version: 3, allow: [], deny: []}},
		{name: 'an unknown v2 selector field', policy: {version: 2, allow: [{roomId: 'x'}], deny: []}},
	])('rejects $name', ({policy}) => {
		expect(() => entityPolicySchema.parse(policy)).toThrow(ZodError);
	});
});
