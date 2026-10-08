import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import {getSupportedActions} from '../home-assistant/capabilities.js';
import {planningRequestBytes} from './planner.js';
import type {SetScopeContext} from './intents.js';
import type {PlanningIntentMode} from './schemas.js';
import {isObservationCandidate, toObservationState, type ObservationState} from './observations.js';

export type RelevanceCandidate = {
	state: NormalizedEntityState;
	areaAliases: readonly string[];
};

export type SelectionResult =
	| {
			kind: 'ready';
			states: NormalizedEntityState[];
			observations: ObservationState[];
			contextEntityIds: ReadonlySet<string>;
			mode: 'targeted' | 'broad' | 'fallback';
			reasons: readonly string[];
			requestBytes: number;
			setScopes: SetScopeContext[];
			requiresSetIntent: boolean;
			intentMode: PlanningIntentMode;
	  }
	| {
			kind: 'insufficient_context';
			reason: 'no_permitted_match' | 'over_budget' | 'missing_observations';
	  };

export type SelectionOptions = {
	model: string;
	maxRequestBytes: number;
	getSetScopes?: (entityIds: ReadonlySet<string>) => SetScopeContext[];
};

export const outputHeadroomBytes = 4096;

const domainTerms = {
	light: ['light', 'lights', 'lamp', 'lamps'],
	switch: ['switch', 'switches', 'plug', 'plugs', 'outlet', 'outlets'],
} as const;

const presenceTerms = [
	'anyone',
	'anybody',
	'someone',
	'nobody',
	'no one',
	'who is home',
	'presence',
	'occupancy',
	'occupied',
	'unoccupied',
	'empty',
	'vacant',
];
const temperatureTerms = ['temperature', 'temperatures', 'temp'];
const humidityTerms = ['humidity', 'humid'];
const broadTerms = ['all', 'every', 'each', 'whole', 'entire'];
const actionTerms = new Set([
	'turn',
	'on',
	'off',
	'switch',
	'enable',
	'disable',
	'the',
	'a',
	'an',
	'all',
	'every',
	'each',
	'permitted',
	'allowed',
	'please',
	'lights',
	'light',
	'lamp',
	'lamps',
	'plugs',
	'plug',
	'outlets',
	'outlet',
	'switches',
	'house',
	'home',
]);

const words = (value: string): string[] =>
	value
		.normalize('NFKC')
		.toLowerCase()
		.match(/[\p{Letter}\p{Number}]+/gv) ?? [];

const normalize = (value: string): string => words(value).join(' ');

const hasPhrase = (instruction: string, phrase: string): boolean => {
	const normalizedPhrase = normalize(phrase);

	return normalizedPhrase.length > 0 && ` ${instruction} `.includes(` ${normalizedPhrase} `);
};

const hasAnyPhrase = (instruction: string, phrases: readonly string[]): boolean =>
	phrases.some((phrase) => hasPhrase(instruction, phrase));

// A universal word inside an installation's area name is metadata, not a scope quantifier.
const hasBroadScope = (instruction: string, candidates: RelevanceCandidate[]): boolean => {
	const areaPhrases = candidates
		.flatMap((candidate) => [candidate.state.area, ...candidate.areaAliases])
		.filter((name) => name !== undefined)
		.map((name) => normalize(name))
		.filter((name) => name.length > 0)
		.toSorted((a, b) => b.length - a.length);
	let remaining = ` ${normalize(instruction)} `;
	for (const phrase of areaPhrases) {
		remaining = remaining.replaceAll(` ${phrase} `, ' ');
	}

	return hasAnyPhrase(remaining, broadTerms);
};

type AreaMatch = {
	candidate: RelevanceCandidate;
	start: number;
	end: number;
};

const matchedAreas = (instruction: string, candidate: RelevanceCandidate): AreaMatch[] => {
	const matches: AreaMatch[] = [];
	for (const name of [candidate.state.area, ...candidate.areaAliases]) {
		if (name === undefined) {
			continue;
		}

		const phrase = normalize(name);
		if (phrase.length === 0) {
			continue;
		}

		const boundedPhrase = ` ${phrase} `;
		let start = instruction.indexOf(boundedPhrase);
		while (start !== -1) {
			matches.push({candidate, start: start + 1, end: start + 1 + phrase.length});
			start = instruction.indexOf(boundedPhrase, start + 1);
		}
	}

	return matches;
};

const areaCandidates = (
	instruction: string,
	candidates: RelevanceCandidate[],
): RelevanceCandidate[] => {
	const matches = candidates.flatMap((candidate) => matchedAreas(` ${instruction} `, candidate));
	const unshadowed = matches.filter((match) =>
		matches.every(
			(other) =>
				other.end - other.start <= match.end - match.start ||
				other.start >= match.end ||
				match.start >= other.end,
		),
	);

	return candidates.filter((candidate) =>
		unshadowed.some((match) => match.candidate === candidate),
	);
};

type ObservationProfile = 'presence' | 'temperature' | 'humidity';

const observationProfiles = (instruction: string): ObservationProfile[] => {
	const profiles: ObservationProfile[] = [];
	if (hasAnyPhrase(instruction, presenceTerms)) {
		profiles.push('presence');
	}

	if (hasAnyPhrase(instruction, temperatureTerms)) {
		profiles.push('temperature');
	}

	if (hasAnyPhrase(instruction, humidityTerms)) {
		profiles.push('humidity');
	}

	return profiles;
};

const hasProfile = (deviceClass: string | undefined, profile: ObservationProfile): boolean =>
	profile === 'presence'
		? deviceClass === 'occupancy' || deviceClass === 'presence'
		: deviceClass === profile;

const hasUnresolvedQualifier = (instruction: string): boolean => {
	if (!/^(?:turn on|turn off|switch on|switch off|enable|disable) /v.test(instruction)) {
		return false;
	}

	return words(instruction).some((word) => !actionTerms.has(word));
};

const exactEntityIds = (instruction: string): string[] =>
	instruction.match(/\b\w+\.\w+\b/giv) ?? [];

// Entity ID words are metadata, not evidence vocabulary, action intent, or scope quantifiers.
const instructionText = (instruction: string): string =>
	normalize(instruction.replaceAll(/\b\w+\.\w+\b/giv, ' '));

type CandidateChoice = {
	selected: RelevanceCandidate[];
	mode: 'targeted' | 'broad' | 'fallback';
	reason: string;
};

const chooseCandidates = (
	instruction: string,
	candidates: RelevanceCandidate[],
	hasEvidenceTarget: boolean,
): CandidateChoice => {
	const explicitIds = exactEntityIds(instruction).filter(
		(id) => getSupportedActions(id.split('.', 1)[0]!.toLowerCase()).length > 0,
	);
	if (explicitIds.length > 0) {
		return {
			selected: candidates.filter((candidate) =>
				explicitIds.some((id) => id.toLowerCase() === candidate.state.entityId.toLowerCase()),
			),
			mode: 'targeted',
			reason: 'exact_entity',
		};
	}

	const normalizedInstruction = instructionText(instruction);
	const areas = areaCandidates(normalizedInstruction, candidates);
	const isBroad = hasBroadScope(normalizedInstruction, candidates);
	const exactNames = candidates.filter(
		(candidate) =>
			candidate.state.name !== undefined && hasPhrase(normalizedInstruction, candidate.state.name),
	);
	const hasPluralDomain = hasAnyPhrase(normalizedInstruction, [
		'lights',
		'lamps',
		'switches',
		'plugs',
		'outlets',
	]);
	if (exactNames.length > 0 && !isBroad && !(areas.length > 0 && hasPluralDomain)) {
		return {selected: exactNames, mode: 'targeted', reason: 'friendly_name'};
	}

	const domains = Object.entries(domainTerms)
		.filter(([, terms]) => hasAnyPhrase(normalizedInstruction, terms))
		.map(([domain]) => domain);
	if (domains.length === 0 && hasEvidenceTarget) {
		return {selected: [], mode: 'targeted', reason: 'observation'};
	}

	if (areas.length > 0) {
		const scoped =
			domains.length > 0
				? areas.filter((candidate) => domains.includes(candidate.state.domain))
				: areas;
		const hasLampTerm = hasAnyPhrase(normalizedInstruction, ['lamp', 'lamps']);
		const lamps = hasLampTerm
			? scoped.filter((candidate) =>
					hasAnyPhrase(normalize(`${candidate.state.name ?? ''} ${candidate.state.entityId}`), [
						'lamp',
						'lamps',
					]),
				)
			: [];

		return {
			selected: lamps.length > 0 && !isBroad ? lamps : scoped,
			mode: 'targeted',
			reason: domains.length > 0 ? 'area_domain' : 'area',
		};
	}

	if (domains.length > 0) {
		if (!isBroad && !hasEvidenceTarget && hasUnresolvedQualifier(normalizedInstruction)) {
			return {selected: [], mode: 'targeted', reason: 'unresolved_qualifier'};
		}

		return {
			selected: candidates.filter((candidate) => domains.includes(candidate.state.domain)),
			mode: 'broad',
			reason: 'domain',
		};
	}

	return {selected: candidates, mode: 'fallback', reason: 'ambiguous_fallback'};
};

const hasRequiredEvidence = (
	states: NormalizedEntityState[],
	observations: ObservationState[],
	profiles: ObservationProfile[],
	scopedAreas: ReadonlySet<string>,
): boolean =>
	profiles.every((profile) =>
		observations.some((observation) => hasProfile(observation.deviceClass, profile)),
	) &&
	[...scopedAreas].every((area) =>
		profiles.every((profile) =>
			observations.some(
				(observation) => observation.area === area && hasProfile(observation.deviceClass, profile),
			),
		),
	) &&
	states.every(
		(state) =>
			state.area !== undefined &&
			profiles.every((profile) =>
				observations.some(
					(observation) =>
						observation.area === state.area && hasProfile(observation.deviceClass, profile),
				),
			),
	);

export const selectRelevantContext = (
	instruction: string,
	candidates: RelevanceCandidate[],
	options: SelectionOptions,
): SelectionResult => {
	const actionable = candidates.filter(({state}) => getSupportedActions(state.domain).length > 0);
	const observational = candidates.filter(({state}) => isObservationCandidate(state));
	const normalizedInstruction = instructionText(instruction);
	const profiles = observationProfiles(normalizedInstruction);
	const explicitIds = exactEntityIds(instruction).map((id) => id.toLowerCase());
	const areas = areaCandidates(normalizedInstruction, [...actionable, ...observational]);
	const namedObservations = observational.filter(
		({state}) => state.name !== undefined && hasPhrase(normalizedInstruction, state.name),
	);
	const hasObservationTarget =
		observational.some(({state}) => explicitIds.includes(state.entityId.toLowerCase())) ||
		namedObservations.length > 0;
	const choice = chooseCandidates(
		instruction,
		actionable,
		profiles.length > 0 || hasObservationTarget || explicitIds.length > 0,
	);
	const isSingleTarget = ['exact_entity', 'friendly_name'].includes(choice.reason);

	const states = choice.selected.map((candidate) => candidate.state);
	const targetAreas = new Set(
		states.flatMap((state) => (state.area === undefined ? [] : [state.area])),
	);
	const scopedAreas = new Set(
		areas.flatMap(({state}) => (state.area === undefined ? [] : [state.area])),
	);
	const observationCandidates = observational.filter((candidate) => {
		const {state} = candidate;
		if (explicitIds.includes(state.entityId.toLowerCase())) {
			return true;
		}

		const isInScope =
			areas.length > 0
				? areas.includes(candidate)
				: targetAreas.size === 0 || (state.area !== undefined && targetAreas.has(state.area));
		return (
			isInScope &&
			(namedObservations.includes(candidate) ||
				profiles.some((profile) => hasProfile(state.deviceClass, profile)))
		);
	});
	const observations = observationCandidates.flatMap(({state}) => {
		const observation = toObservationState(state);
		return observation === undefined ? [] : [observation];
	});
	// Explicit user-provided context still works. HA-dependent conditions need complete evidence.
	const requiresEvidence =
		profiles.length > 0 &&
		(states.length === 0 ||
			hasAnyPhrase(normalizedInstruction, [
				'if',
				'when',
				'where',
				'that are',
				'which are',
				'unoccupied rooms',
				'empty rooms',
				'vacant rooms',
			]));
	// Never omit invalid selected evidence or decide conditional changes for an uncovered area.
	const isMissingEvidence =
		explicitIds.some(
			(id) =>
				/^(?:sensor|binary_sensor)\./v.test(id) &&
				observations.every((observation) => observation.entityId.toLowerCase() !== id),
		) ||
		observationCandidates.length !== observations.length ||
		(requiresEvidence && !hasRequiredEvidence(states, observations, profiles, scopedAreas));
	if (isMissingEvidence) {
		return {kind: 'insufficient_context', reason: 'missing_observations'};
	}

	if (states.length === 0 && observations.length === 0) {
		return {kind: 'insufficient_context', reason: 'no_permitted_match'};
	}

	// Observation IDs are deliberately absent from action scope and readiness authority.
	const contextEntityIds = new Set(states.map((state) => state.entityId));
	const scopeCatalogue = options.getSetScopes?.(contextEntityIds) ?? [];
	const requiresSetIntent =
		!isSingleTarget &&
		hasBroadScope(normalizedInstruction, candidates) &&
		Object.values(domainTerms).some((terms) => hasAnyPhrase(normalizedInstruction, terms));
	const intentMode = isSingleTarget ? 'entity_only' : requiresSetIntent ? 'set_only' : 'mixed';
	const requestBytes = planningRequestBytes(
		{instruction, states, observations, setScopes: scopeCatalogue, intentMode},
		options.model,
	);
	if (requestBytes + outputHeadroomBytes > options.maxRequestBytes) {
		return {kind: 'insufficient_context', reason: 'over_budget'};
	}

	return {
		kind: 'ready',
		states,
		observations,
		contextEntityIds,
		mode: choice.mode,
		reasons: [states.length === 0 ? 'observation' : choice.reason],
		requestBytes,
		setScopes: scopeCatalogue,
		requiresSetIntent,
		intentMode,
	};
};

export const selectionDiagnostic = (selection: SelectionResult, permittedCount: number) =>
	selection.kind === 'ready'
		? {
				mode: selection.mode,
				intentMode: selection.intentMode,
				reason: selection.reasons[0],
				permittedCount,
				selectedCount: selection.states.length,
				observationCount: selection.observations.length,
				requestBytes: selection.requestBytes,
			}
		: {
				mode: 'insufficient_context',
				reason: selection.reason,
				permittedCount,
				selectedCount: 0,
				observationCount: 0,
				requestBytes: 0,
			};
