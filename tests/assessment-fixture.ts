import type {AuditData} from '../src/audit/collection.js';
import {selectAssessmentContext} from '../src/assessment/context.js';
import {assessmentProposalSchema} from '../src/assessment/schemas.js';
import {auditData, at, historical, location} from './lighting-learning-fixture.js';

export const now = at('2026-10-10T20:00:00Z');
export const presenceId = 'binary_sensor.example_occupancy';
export const preferences = {
	version: 1 as const,
	rooms: [{areaId: 'example_area', thresholdLux: 40}],
};
export const assessmentData = (): AuditData => {
	const data = auditData();
	addEntity(
		data,
		historical(presenceId, 'on', '2026-10-10T19:59:00Z', {device_class: 'occupancy'}),
	);
	return data;
};

export const addEntity = (data: AuditData, state: AuditData['states'][number], areaId?: string) => {
	if (data.registries.status !== 'available') {
		throw new Error('fixture');
	}

	data.states.push(state);
	data.registries.entities.push({
		entity_id: state.entity_id,
		device_id: 'example_device',
		area_id: areaId ?? null,
		disabled_by: null,
		labels: [],
	});
	data.policy!.allow.push({entityId: state.entity_id});
};

export const selected = (
	data = assessmentData(),
	extra: Partial<Parameters<typeof selectAssessmentContext>[0]> = {},
) => selectAssessmentContext({data, area: 'Example Room', preferences, location, now, ...extra});
export const proposal = (
	outcome: 'suggest_action' | 'no_action' | 'insufficient_context' = 'suggest_action',
	presence = 'detected',
) =>
	assessmentProposalSchema.parse({
		outcome,
		presence,
		rationale: 'Consider lighting for the available situation; user review is required.',
		actions: outcome === 'suggest_action' ? [{lightRef: 'light_1', action: 'turn_on'}] : [],
	});
