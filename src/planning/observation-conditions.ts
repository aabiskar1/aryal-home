import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import type {ObservationState} from './observations.js';
import type {Plan} from './schemas.js';

export type ObservationConditionIssue = {
	readonly reason: 'unresolved_illuminance_threshold';
	readonly explanation: string;
};

const unresolvedIlluminance: ObservationConditionIssue = Object.freeze({
	reason: 'unresolved_illuminance_threshold',
	explanation:
		'Illuminance is available, but no reliable darkness/brightness threshold has been established. Deterministic illuminance comparisons are not supported, including numeric thresholds supplied in an instruction.',
});

/**
 Application-owned post-schema gate, before any entity or set intent is expanded.
 No deterministic illuminance condition evaluator exists. Withhold all control in a
 mixed illuminance context, rather than trusting model semantics or parsing prose.
 */
export const validateObservationConditions = (
	plan: Plan,
	context: {
		states: readonly NormalizedEntityState[];
		observations: readonly ObservationState[];
	},
): {plan: Plan; issue?: ObservationConditionIssue} => {
	if (
		context.states.length === 0 ||
		context.observations.every((observation) => observation.deviceClass !== 'illuminance')
	) {
		return {plan};
	}

	return {
		plan: {
			outcome: 'insufficient_context',
			summary: `Proposed plan: ${unresolvedIlluminance.explanation}`,
			actions: [],
		},
		issue: unresolvedIlluminance,
	};
};
