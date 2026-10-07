import type {NormalizedEntityState} from '../home-assistant/state-normalizer.js';
import {planningRequestBytes} from './planner.js';
import type {SetScopeContext} from './intents.js';
import type {PlanningIntentMode} from './schemas.js';

export type RelevanceCandidate = {
	state: NormalizedEntityState;
	areaAliases: readonly string[];
};

export type SelectionResult =
	| {
			kind: 'ready';
			states: NormalizedEntityState[];
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
			reason: 'no_permitted_match' | 'over_budget';
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

const presenceTerms = ['anyone home', 'someone home', 'who is home', 'presence', 'occupancy'];
const temperatureTerms = ['temperature', 'temperatures', 'temp'];
const weatherTerms = ['weather', 'forecast'];
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

const observationProfile = (
	instruction: string,
): 'presence' | 'temperature' | 'weather' | undefined => {
	if (hasAnyPhrase(instruction, presenceTerms)) {
		return 'presence';
	}

	if (hasAnyPhrase(instruction, temperatureTerms)) {
		return 'temperature';
	}

	if (hasAnyPhrase(instruction, weatherTerms)) {
		return 'weather';
	}

	return undefined;
};

const isObservationMatch = (
	candidate: RelevanceCandidate,
	profile: 'presence' | 'temperature' | 'weather',
): boolean => {
	const {state} = candidate;
	if (state.supportedActions.length > 0) {
		return false;
	}

	switch (profile) {
		case 'presence': {
			return (
				state.domain === 'person' ||
				state.domain === 'device_tracker' ||
				(state.domain === 'binary_sensor' &&
					(state.deviceClass === 'presence' || state.deviceClass === 'occupancy'))
			);
		}

		case 'temperature': {
			return (
				state.domain === 'sensor' &&
				(state.deviceClass === 'temperature' ||
					hasAnyPhrase(normalize(`${state.name ?? ''} ${state.entityId}`), temperatureTerms))
			);
		}

		case 'weather': {
			return state.domain === 'weather';
		}
	}
};

const hasUnresolvedQualifier = (instruction: string): boolean => {
	if (!/^(?:turn on|turn off|switch on|switch off|enable|disable) /v.test(instruction)) {
		return false;
	}

	return words(instruction).some((word) => !actionTerms.has(word));
};

const exactEntityIds = (instruction: string): string[] =>
	instruction.match(/\b\w+\.\w+\b/giv) ?? [];

type CandidateChoice = {
	selected: RelevanceCandidate[];
	mode: 'targeted' | 'broad' | 'fallback';
	reason: string;
};

const chooseCandidates = (
	instruction: string,
	candidates: RelevanceCandidate[],
): CandidateChoice => {
	const explicitIds = exactEntityIds(instruction);
	if (explicitIds.length > 0) {
		return {
			selected: candidates.filter((candidate) =>
				explicitIds.some((id) => id.toLowerCase() === candidate.state.entityId.toLowerCase()),
			),
			mode: 'targeted',
			reason: 'exact_entity',
		};
	}

	const normalizedInstruction = normalize(instruction);
	const areas = areaCandidates(normalizedInstruction, candidates);
	const isBroad = hasBroadScope(normalizedInstruction, candidates);
	const exactNames = candidates.filter(
		(candidate) =>
			candidate.state.name !== undefined && hasPhrase(normalizedInstruction, candidate.state.name),
	);
	const profile = observationProfile(normalizedInstruction);
	const hasPluralDomain = hasAnyPhrase(normalizedInstruction, [
		'lights',
		'lamps',
		'switches',
		'plugs',
		'outlets',
	]);
	if (
		exactNames.length > 0 &&
		!isBroad &&
		profile === undefined &&
		!(areas.length > 0 && hasPluralDomain)
	) {
		return {selected: exactNames, mode: 'targeted', reason: 'friendly_name'};
	}

	const domains = Object.entries(domainTerms)
		.filter(([, terms]) => hasAnyPhrase(normalizedInstruction, terms))
		.map(([domain]) => domain);

	if (profile !== undefined) {
		const scope = areas.length > 0 ? areas : candidates;

		return {
			selected: scope.filter(
				(candidate) =>
					isObservationMatch(candidate, profile) || domains.includes(candidate.state.domain),
			),
			mode: 'targeted',
			reason: `observation_${profile}`,
		};
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
		if (!isBroad && hasUnresolvedQualifier(normalizedInstruction)) {
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

export const selectRelevantContext = (
	instruction: string,
	candidates: RelevanceCandidate[],
	options: SelectionOptions,
): SelectionResult => {
	const choice = chooseCandidates(instruction, candidates);
	if (choice.selected.length === 0) {
		return {kind: 'insufficient_context', reason: 'no_permitted_match'};
	}

	const states = choice.selected.map((candidate) => candidate.state);
	const contextEntityIds = new Set(states.map((state) => state.entityId));
	const scopeCatalogue = options.getSetScopes?.(contextEntityIds) ?? [];
	const isSingleTarget = choice.reason === 'exact_entity' || choice.reason === 'friendly_name';
	const requiresSetIntent =
		!isSingleTarget &&
		hasBroadScope(instruction, candidates) &&
		Object.values(domainTerms).some((terms) => hasAnyPhrase(normalize(instruction), terms));
	const intentMode = isSingleTarget ? 'entity_only' : requiresSetIntent ? 'set_only' : 'mixed';
	const requestBytes = planningRequestBytes(
		{instruction, states, setScopes: scopeCatalogue, intentMode},
		options.model,
	);
	if (requestBytes + outputHeadroomBytes > options.maxRequestBytes) {
		return {kind: 'insufficient_context', reason: 'over_budget'};
	}

	return {
		kind: 'ready',
		states,
		contextEntityIds,
		mode: choice.mode,
		reasons: [choice.reason],
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
				reason: selection.reasons[0],
				permittedCount,
				selectedCount: selection.states.length,
				requestBytes: selection.requestBytes,
			}
		: {
				mode: 'insufficient_context',
				reason: selection.reason,
				permittedCount,
				selectedCount: 0,
				requestBytes: 0,
			};
