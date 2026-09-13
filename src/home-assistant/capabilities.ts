export const canonicalActions = ['turn_on', 'turn_off'] as const;

export type CanonicalAction = (typeof canonicalActions)[number];
export type HomeAssistantService = 'turn_on' | 'turn_off';

const domainActionServices = {
	light: {
		turn_on: 'turn_on',
		turn_off: 'turn_off',
	},
	switch: {
		turn_on: 'turn_on',
		turn_off: 'turn_off',
	},
} as const satisfies Record<string, Partial<Record<CanonicalAction, HomeAssistantService>>>;

type SupportedDomain = keyof typeof domainActionServices;

export type ResolvedAction = {
	domain: SupportedDomain;
	service: HomeAssistantService;
};

const isSupportedDomain = (domain: string): domain is SupportedDomain =>
	Object.hasOwn(domainActionServices, domain);

export const getSupportedActions = (domain: string): CanonicalAction[] => {
	if (!isSupportedDomain(domain)) {
		return [];
	}

	return canonicalActions.filter((action) => domainActionServices[domain][action] !== undefined);
};

export const resolveAction = (
	domain: string,
	action: CanonicalAction,
): ResolvedAction | undefined => {
	if (!isSupportedDomain(domain)) {
		return undefined;
	}

	const service = domainActionServices[domain][action];

	return service === undefined ? undefined : {domain, service};
};
