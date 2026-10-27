import {Buffer} from 'node:buffer';
import type {OllamaChatTransport} from '../ollama/client.js';
import type {SelectedAssessment} from './context.js';
import {assessmentProposalSchema} from './schemas.js';
import {
	createAssessmentRequest,
	assessmentRequestBytes,
	ASSESSMENT_REQUEST_MAX_BYTES,
	ASSESSMENT_RESPONSE_MAX_BYTES,
} from './reasoning.js';
import {evaluateAssessmentEvidence, validateAssessment} from './validation.js';
import type {SelectedEnvironmentAssessment} from './environment-context.js';
import {createEnvironmentRequest} from './environment-reasoning.js';
import {environmentProposalSchema} from './environment-schemas.js';
import {
	evaluateEnvironmentEvidence,
	validateEnvironmentAssessment,
} from './environment-validation.js';

export const assessContext = async (input: {
	selected: SelectedAssessment | SelectedEnvironmentAssessment;
	chat: OllamaChatTransport;
	model: string;
	now: () => number;
	maxRequestBytes?: number;
}) => {
	const {selected} = input;
	const base = {
		outcome: 'insufficient_context' as const,
		recommendations: [],
		executionAuthority: 'none' as const,
	};
	const {context} = selected;
	const request =
		context.goal === 'environment_comfort'
			? createEnvironmentRequest(context)
			: createAssessmentRequest(context);
	const requestBytes = assessmentRequestBytes(request, input.model);
	if (
		requestBytes >
		Math.min(input.maxRequestBytes ?? ASSESSMENT_REQUEST_MAX_BYTES, ASSESSMENT_REQUEST_MAX_BYTES)
	) {
		return {
			...base,
			validation: 'not_run' as const,
			model: 'not_called' as const,
			issues: ['context_over_budget'],
			requestBytes,
		};
	}

	const evidence =
		context.goal === 'environment_comfort'
			? evaluateEnvironmentEvidence(context, input.now())
			: evaluateAssessmentEvidence(context, input.now());
	if (evidence.issues.length > 0) {
		return {
			...base,
			validation: 'not_run' as const,
			model: 'not_called' as const,
			issues: evidence.issues,
			presence: evidence.presence,
			requestBytes,
			...('limitations' in evidence && {limitations: evidence.limitations}),
		};
	}

	let content: string;
	try {
		content = await input.chat(request);
	} catch {
		return {
			...base,
			validation: 'not_run' as const,
			model: 'unavailable' as const,
			issues: ['model_unavailable'],
			requestBytes,
		};
	}

	try {
		if (Buffer.byteLength(content) > ASSESSMENT_RESPONSE_MAX_BYTES) {
			throw new Error('Assessment response exceeds budget.');
		}

		if (context.goal === 'environment_comfort') {
			const proposal = environmentProposalSchema.parse(JSON.parse(content));
			return {
				...validateEnvironmentAssessment(context, proposal, input.now()),
				model: 'structured_response' as const,
				modelOutcome: proposal.outcome,
				requestBytes,
			};
		}

		const proposal = assessmentProposalSchema.parse(JSON.parse(content));
		return {
			...validateAssessment({context, targets: selected.targets}, proposal, input.now()),
			model: 'structured_response' as const,
			modelOutcome: proposal.outcome,
			requestBytes,
		};
	} catch {
		return {
			...base,
			validation: 'rejected' as const,
			model: 'invalid_output' as const,
			issues: ['invalid_model_output'],
			requestBytes,
		};
	}
};
