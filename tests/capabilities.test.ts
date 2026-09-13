import {describe, expect, it} from 'vitest';
import {getSupportedActions, resolveAction} from '../src/home-assistant/capabilities.js';

describe('Home Assistant capabilities', () => {
	it.each(['light', 'switch'])('exposes canonical power actions for %s', (domain) => {
		expect(getSupportedActions(domain)).toEqual(['turn_on', 'turn_off']);
	});

	it('exposes no actions for unknown domains', () => {
		expect(getSupportedActions('sensor')).toEqual([]);
	});

	it.each([
		{domain: 'light', action: 'turn_on' as const},
		{domain: 'light', action: 'turn_off' as const},
		{domain: 'switch', action: 'turn_on' as const},
		{domain: 'switch', action: 'turn_off' as const},
	])('resolves $domain.$action deterministically', ({domain, action}) => {
		expect(resolveAction(domain, action)).toEqual({domain, service: action});
	});

	it('does not resolve canonical actions for unknown domains', () => {
		expect(resolveAction('sensor', 'turn_off')).toBeUndefined();
	});

	it('returns a fresh supported-actions array', () => {
		const actions = getSupportedActions('light');
		actions.pop();

		expect(getSupportedActions('light')).toEqual(['turn_on', 'turn_off']);
	});
});
