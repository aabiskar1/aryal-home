import {evaluateDarkness, MAX_MEASUREMENT_AGE_MS} from '../lighting-thresholds/evaluation.js';
import {getSupportedActions} from '../home-assistant/capabilities.js';
import {evidenceStatus, presenceFrom, type SelectedAssessment} from './context.js';
import type {AssessmentContext, AssessmentProposal} from './schemas.js';

export type AssessmentIssue =
	| 'stale_snapshot'
	| 'missing_threshold'
	| 'missing_illuminance'
	| 'unusable_illuminance'
	| 'conflicting_illuminance'
	| 'conflicting_presence'
	| 'no_permitted_lights'
	| 'presence_mismatch'
	| 'condition_not_met'
	| 'presence_clear'
	| 'unknown_target'
	| 'duplicate_target'
	| 'redundant_action';
export type AdvisoryRecommendation = {
	kind: 'advisory_lighting_recommendation';
	entityId: string;
	proposedAction: 'turn_on';
	rationale: string;
	requiresPresenceConfirmation: boolean;
};
export type AssessmentDecision = {
	outcome: AssessmentProposal['outcome'];
	validation: 'accepted' | 'rejected';
	issues: AssessmentIssue[];
	recommendations: AdvisoryRecommendation[];
	presence: AssessmentContext['presence'];
	executionAuthority: 'none';
};

const darknessEvidence = (context: AssessmentContext, now: number) => {
	const issues: AssessmentIssue[] = [];
	if (
		now < Date.parse(context.capturedAt) ||
		now - Date.parse(context.capturedAt) > MAX_MEASUREMENT_AGE_MS ||
		!Number.isFinite(now)
	) {
		issues.push('stale_snapshot');
	}

	if (context.states.length === 0) {
		issues.push('no_permitted_lights');
	}

	const lux = context.observations.filter((item) => item.deviceClass === 'illuminance');
	if (lux.length === 0) {
		issues.push('missing_illuminance');
	}

	if (
		lux.some(
			(item) =>
				item.status !== 'available' ||
				evidenceStatus(item.measuredAt, item.updatedAt, now) !== 'available',
		)
	) {
		issues.push('unusable_illuminance');
	}

	if (context.preference.status !== 'approved') {
		issues.push('missing_threshold');
		return {issues, isDark: false};
	}

	const {thresholdLux} = context.preference;
	const assessments = lux.map((item) =>
		evaluateDarkness({
			thresholdLux,
			now,
			measurement:
				item.status === 'available'
					? {
							domain: 'sensor',
							deviceClass: item.deviceClass,
							unit: item.unit,
							state: String(item.value),
							measuredAt: item.measuredAt,
							updatedAt: item.updatedAt,
						}
					: undefined,
		}),
	);
	if (assessments.some((item) => item.assessment === 'insufficient_context')) {
		issues.push('unusable_illuminance');
	}

	const results = new Set(assessments.map((item) => item.assessment));
	if (results.has('dark') && results.has('not_dark')) {
		issues.push('conflicting_illuminance');
	}

	return {
		issues,
		isDark: assessments.length > 0 && assessments.every((item) => item.assessment === 'dark'),
	};
};

/** Advisory snapshot validation only. No readiness/command types or execution imports. */
export const validateAssessment = (
	selected: SelectedAssessment,
	proposal: AssessmentProposal,
	now: number,
): AssessmentDecision => {
	const {context, targets} = selected;
	const {issues, isDark} = darknessEvidence(context, now);
	const presence = presenceFrom(context.observations, now);
	if (presence === 'conflicting') {
		issues.push('conflicting_presence');
	}

	if (proposal.presence !== presence) {
		issues.push('presence_mismatch');
	}

	const isIncomplete = issues.length > 0;
	if (proposal.outcome === 'suggest_action') {
		if (!isDark && !isIncomplete) {
			issues.push('condition_not_met');
		}

		if (presence === 'clear') {
			issues.push('presence_clear');
		}

		const seen = new Set<string>();
		for (const action of proposal.actions) {
			const state = context.states.find((item) => item.ref === action.lightRef);
			if (
				state === undefined ||
				!targets.has(action.lightRef) ||
				!state.supportedActions.includes(action.action) ||
				!getSupportedActions('light').includes(action.action)
			) {
				issues.push('unknown_target');
			} else if (state.state !== 'off') {
				issues.push('redundant_action');
			}

			if (seen.has(action.lightRef)) {
				issues.push('duplicate_target');
			}

			seen.add(action.lightRef);
		}
	}

	return {
		outcome: issues.length > 0 ? 'insufficient_context' : proposal.outcome,
		validation:
			issues.length === 0 ||
			(proposal.outcome === 'insufficient_context' &&
				isIncomplete &&
				proposal.presence === presence)
				? 'accepted'
				: 'rejected',
		issues: [...new Set(issues)],
		presence,
		executionAuthority: 'none',
		recommendations:
			issues.length > 0
				? []
				: proposal.actions.map((action) => ({
						kind: 'advisory_lighting_recommendation',
						entityId: targets.get(action.lightRef)!,
						proposedAction: action.action,
						rationale: `Fresh illuminance is below the approved room threshold. ${presence === 'unknown' ? 'Presence was not established; confirm room use before considering lighting.' : 'Presence is detected; lighting preference still requires user review.'}`,
						requiresPresenceConfirmation: presence === 'unknown',
					})),
	};
};
