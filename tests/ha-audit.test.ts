import {describe, expect, it, vi} from 'vitest';
import type {AuditData} from '../src/audit/collection.js';
import {buildAuditInventory} from '../src/audit/inventory.js';
import {formatAuditReport} from '../src/audit/presentation.js';
import {auditInventory, type AuditReport} from '../src/audit/rules.js';
import {runHaAuditCli} from '../src/cli/ha-audit.js';
import type {HomeAssistantState} from '../src/home-assistant/schemas.js';

const state = (
	entityId: string,
	name = 'Example Lamp',
	value = 'on',
	deviceClass?: string,
): HomeAssistantState => ({
	entity_id: entityId,
	state: value,
	attributes: {friendly_name: name, device_class: deviceClass, unit_of_measurement: '°C'},
	last_changed: '2000-01-01T00:00:00Z',
	last_updated: '2000-01-01T00:00:00Z',
});

const fixture = (states = [state('light.example_lamp')]): AuditData => ({
	states,
	registries: {
		status: 'available',
		entities: states.map(({entity_id: entityId}) => ({
			entity_id: entityId,
			device_id: 'example_device',
			area_id: null,
			labels: [],
			disabled_by: null,
		})),
		devices: [{id: 'example_device', area_id: 'example_room', labels: [], disabled_by: null}],
		areas: [
			{area_id: 'example_room', name: 'Example Room', aliases: ['Example Alias'], labels: []},
			{area_id: 'example_other', name: 'Other Room', aliases: [], labels: []},
		],
		labels: [],
	},
	policy: {
		version: 1,
		allow: [{domain: 'light'}, {domain: 'switch'}, {domain: 'sensor'}, {domain: 'binary_sensor'}],
		deny: [],
	},
	redactions: [],
});

const report = (data: AuditData) => auditInventory(buildAuditInventory(data));
const findings = (data: AuditData, code: string) =>
	report(data).findings.filter((finding) => finding.code === code);
const registries = (data: AuditData) => {
	if (data.registries.status !== 'available') {
		throw new Error('Test requires available registry.');
	}

	return data.registries;
};

describe('deterministic Home Assistant metadata audit', () => {
	it.each([
		state('light.example_lamp'),
		state('binary_sensor.example_occupancy', 'Example Occupancy', 'off', 'occupancy'),
		state('sensor.example_temperature', 'Example Temperature', '21', 'temperature'),
	])('reports missing effective area for $entity_id without inferring from a name', (reading) => {
		const data = fixture([reading]);
		registries(data).devices[0]!.area_id = null;
		reading.attributes.area_name = 'Untrusted Room';
		const missing = findings(data, 'missing_area');
		expect(missing).toHaveLength(1);
		expect(missing[0]).toMatchObject({
			severity: 'warn',
			entityId: reading.entity_id,
			details: {area: undefined, areaSource: 'none'},
		});
		expect(formatAuditReport(report(data), true)).not.toContain('Untrusted Room');
	});

	it('distinguishes missing entity assignment from inherited device area', () => {
		const data = fixture();
		expect(findings(data, 'missing_area')).toEqual([]);
		expect(buildAuditInventory(data).entities[0]).toMatchObject({
			entityArea: undefined,
			deviceArea: 'Example Room',
			area: 'Example Room',
			areaSource: 'device',
		});
	});

	it('reuses parent-device inheritance and registry area policy', () => {
		const data = fixture();
		registries(data).devices[0]!.area_id = null;
		registries(data).devices[0]!.parent_device_id = 'example_parent';
		registries(data).devices.push({
			id: 'example_parent',
			area_id: 'example_room',
			labels: [],
			disabled_by: null,
		});
		data.policy = {version: 2, allow: [{areaId: 'example_room'}], deny: []};
		expect(buildAuditInventory(data).entities[0]).toMatchObject({
			areaSource: 'parent_device',
			area: 'Example Room',
			parentDeviceArea: 'Example Room',
			policyPermitted: true,
		});
		expect(findings(data, 'missing_area')).toEqual([]);
	});

	it('warns about entity/device overrides and multiple effective areas on one device', () => {
		const data = fixture([
			state('light.example_first'),
			state('light.example_second', 'Second Lamp'),
		]);
		registries(data).entities[0]!.area_id = 'example_other';
		expect(findings(data, 'entity_device_area_mismatch')).toHaveLength(1);
		expect(findings(data, 'device_entities_multiple_areas')[0]).toMatchObject({
			severity: 'warn',
			deviceId: 'example_device',
			details: {areas: ['Example Room', 'Other Room']},
		});
		expect(buildAuditInventory(data).entities[0]?.area).toBe('Other Room');
	});

	it.each(['Example Lamp', 'EXAMPLE LAMP', '  Example Lamp  '])(
		'detects duplicate names including %s',
		(secondName) => {
			const duplicates = findings(
				fixture([state('light.example_first'), state('light.example_second', secondName)]),
				'duplicate_friendly_name',
			);
			expect(duplicates).toHaveLength(2);
			expect(duplicates[0]?.details).toMatchObject({
				match: secondName === 'Example Lamp' ? 'exact' : 'normalized',
				entityIds: ['light.example_first', 'light.example_second'],
			});
		},
	);

	it('limits generic-name warnings to exact class names', () => {
		const data = fixture([
			state('light.example_generic', 'Light'),
			state('light.example_ordinary', 'Example Light'),
		]);
		expect(findings(data, 'generic_friendly_name').map(({entityId}) => entityId)).toEqual([
			'light.example_generic',
		]);
	});

	it.each(['unavailable', 'unknown'])('reports %s separately from disablement', (value) => {
		const data = fixture([state('light.example_lamp', 'Example Lamp', value)]);
		expect(findings(data, 'unusable_current_state')).toHaveLength(1);
		expect(findings(data, 'registry_disabled')).toEqual([]);
		expect(findings(data, 'actionable_readiness')[0]?.details).toMatchObject({
			policyPermitted: false,
			currentStateUsable: false,
			supportedActions: ['turn_on', 'turn_off'],
		});
	});

	it('surfaces registry disablement without claiming that old timestamps prove staleness', () => {
		const data = fixture();
		registries(data).entities[0]!.disabled_by = 'integration';
		expect(findings(data, 'registry_disabled')[0]?.details.disabledSources).toEqual([
			{source: 'entity', by: 'integration'},
		]);
		expect(findings(data, 'actionable_readiness')[0]?.details.policyPermitted).toBe(false);
		expect(report(fixture()).findings.some(({code}) => code.includes('stale'))).toBe(false);
	});

	it.each([
		state('binary_sensor.example_occupancy', 'Example Occupancy', 'off', 'occupancy'),
		state('binary_sensor.example_presence', 'Example Presence', 'on', 'presence'),
		state('sensor.example_temperature', 'Example Temperature', '21.5', 'temperature'),
		state('sensor.example_humidity', 'Example Humidity', '45', 'humidity'),
	])('reports usable $entity_id as read-only evidence with no action authority', (reading) => {
		const data = fixture([reading]);
		expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
			normalizable: true,
			currentStateUsable: true,
			hasArea: true,
			policyExposed: true,
			eligibleForPlanning: true,
			areaReasoningReady: true,
			omissionReasons: [],
		});
		expect(findings(data, 'actionable_readiness')).toEqual([]);
		expect(findings(data, 'observation_readiness')[0]?.reason).toContain('never action authority');
		expect(buildAuditInventory(data).entities[0]?.supportedActions).toEqual([]);
	});

	it.each([
		state('binary_sensor.example_motion', 'Example Motion', 'off', 'motion'),
		state('sensor.example_energy', 'Example Energy', '5', 'energy'),
		state('sensor.example_presence', 'Example Presence', 'on', 'presence'),
		state('binary_sensor.example_temperature', 'Example Temperature', 'on', 'temperature'),
	])('omits unsupported $entity_id from observation-readiness findings', (reading) => {
		expect(findings(fixture([reading]), 'observation_readiness')).toEqual([]);
	});

	it.each(['unknown', 'unavailable', 'NaN', 'Infinity', 'warm'])(
		'explains unusable numeric observation state %s',
		(value) => {
			const data = fixture([
				state('sensor.example_temperature', 'Example Temperature', value, 'temperature'),
			]);
			expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
				normalizable: false,
				currentStateUsable: false,
				eligibleForPlanning: false,
			});
			expect(findings(data, 'observation_readiness')[0]?.details.omissionReasons).toContain(
				'unusable_observation_state',
			);
		},
	);

	it('keeps unscoped evidence eligible while explaining missing area-conditioned readiness', () => {
		const data = fixture([
			state('sensor.example_temperature', 'Example Temperature', '21', 'temperature'),
		]);
		registries(data).devices[0]!.area_id = null;
		expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
			eligibleForPlanning: true,
			areaReasoningReady: false,
			hasArea: false,
			omissionReasons: [],
		});
	});

	it('reports supported observations not exposed by allow/deny policy', () => {
		const data = fixture([
			state('sensor.example_temperature', 'Example Temperature', '21', 'temperature'),
		]);
		data.policy = {version: 1, allow: [{domain: 'light'}], deny: []};
		expect(findings(data, 'observation_not_exposed')).toHaveLength(1);
		expect(findings(data, 'observation_readiness')[0]?.details.omissionReasons).toEqual([
			'not_policy_permitted',
		]);
		data.policy.allow = [{domain: 'sensor'}];
		data.policy.deny = [{entityId: 'sensor.example_temperature'}];
		expect(findings(data, 'observation_not_exposed')).toHaveLength(1);
	});

	it('preserves version 2 area/label policy and deny-overrides-allow', () => {
		const data = fixture();
		data.policy = {
			version: 2,
			allow: [{areaId: 'example_room'}],
			deny: [{labelId: 'example_critical'}],
		};
		registries(data).entities[0]!.labels = ['example_critical'];
		registries(data).labels = [{label_id: 'example_critical'}];
		expect(buildAuditInventory(data).entities[0]?.policyPermitted).toBe(false);
	});

	it('reports dangling explicit allow and deny references once without rewriting policy', () => {
		const data = fixture();
		data.policy = {
			version: 1,
			allow: [{entityId: 'light.example_missing'}, {entityId: 'light.example_missing'}],
			deny: [{entityId: 'switch.example_missing'}],
		};
		const before = JSON.stringify(data);
		expect(findings(data, 'policy_allow_entity_not_discovered')).toHaveLength(1);
		expect(findings(data, 'policy_deny_entity_not_discovered')).toHaveLength(1);
		expect(findings(data, 'policy_allow_entity_not_discovered')[0]?.details.registryPresent).toBe(
			false,
		);
		expect(JSON.stringify(data)).toBe(before);
	});

	it('audits registry-only disabled lights and distinguishes absence from unknown', () => {
		const data = fixture();
		registries(data).entities.push({
			entity_id: 'light.example_registry_only',
			device_id: 'example_device',
			area_id: null,
			labels: [],
			disabled_by: 'user',
		});
		data.policy = {version: 1, allow: [{entityId: 'light.example_registry_only'}], deny: []};
		expect(report(data).summary).toMatchObject({entitiesScanned: 2, stateEntitiesScanned: 1});
		expect(findings(data, 'registry_entity_without_state')[0]).toMatchObject({
			entityId: 'light.example_registry_only',
			details: {state: 'no_current_state'},
		});
		expect(findings(data, 'unusable_current_state')).toEqual([]);
		expect(findings(data, 'policy_allow_entity_not_discovered')[0]?.details.registryPresent).toBe(
			true,
		);
		const human = formatAuditReport(report(data), false);
		expect(human).toContain('registry_disabled=1, registry_entity_without_state=1');
		expect(human).not.toContain('[INFO] REGISTRY_DISABLED');
		expect(formatAuditReport(report(data), true)).toContain('"code": "registry_disabled"');
	});

	it.each(['status', 'indicator', 'diagnostic', 'debug'])(
		'warns conservatively about whole actionable name token %s',
		(term) => {
			const data = fixture([state(`light.example_${term}_light`, `Example ${term} light`)]);
			expect(findings(data, 'suspicious_actionable_name')[0]).toMatchObject({
				severity: 'warn',
				details: {matchedTerms: [term]},
			});
			expect(buildAuditInventory(data).entities[0]?.policyPermitted).toBe(true);
		},
	);

	it.each(['Example Ceiling Light', 'Example Statuslight', 'Example Debugger'])(
		'does not flag ordinary or substring-only names: %s',
		(name) => {
			const data = fixture([state('light.example_ordinary', name)]);
			expect(findings(data, 'suspicious_actionable_name')).toEqual([]);
		},
	);

	it('does not apply suspicious actionable warnings to observation sensors', () => {
		const data = fixture([
			state('sensor.example_status_temperature', 'Status Reading', '21', 'temperature'),
		]);
		expect(findings(data, 'suspicious_actionable_name')).toEqual([]);
	});

	it('reports incomplete references without trusting fallback area attributes', () => {
		const data = fixture([
			state('sensor.example_temperature', 'Example Temperature', '21', 'temperature'),
		]);
		registries(data).devices = [];
		data.states[0]!.attributes.area_name = 'Untrusted Room';
		expect(findings(data, 'incomplete_metadata')).toHaveLength(1);
		expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
			normalizable: true,
			hasArea: false,
			eligibleForPlanning: false,
			policyExposed: false,
		});
		expect(findings(data, 'observation_readiness')[0]?.details.omissionReasons).toContain(
			'incomplete_metadata',
		);
	});

	it('uses default-deny when the optional policy is missing', () => {
		const data = fixture();
		data.policy = undefined;
		expect(findings(data, 'policy_not_configured')).toHaveLength(1);
		expect(buildAuditInventory(data).entities[0]?.policyPermitted).toBe(false);
	});

	it('produces stable JSON/human output independent of HA response order and does not mutate inputs', () => {
		const data = fixture([
			state('light.example_second', 'Same Lamp'),
			state('light.example_first', 'same lamp'),
		]);
		const before = JSON.stringify(data);
		const first = report(data);
		expect(JSON.stringify(data)).toBe(before);
		data.states.reverse();
		registries(data).entities.reverse();
		registries(data).areas.reverse();
		for (const mode of [false, true]) {
			expect(formatAuditReport(report(data), mode)).toBe(formatAuditReport(first, mode));
		}

		expect(JSON.parse(formatAuditReport(first, true))).toMatchObject({
			summary: {
				entitiesScanned: 2,
				devicesScanned: 1,
				areasScanned: 2,
				errors: 0,
				warnings: 2,
				info: 2,
			},
		});
		expect(formatAuditReport(first, false)).toContain(
			'[WARN] DUPLICATE_FRIENDLY_NAME light.example_first',
		);
	});

	it('redacts credentials, URLs, addresses, terminal controls, and arbitrary attributes', () => {
		const data = fixture([
			state('light.example_lamp', 'Example secret-token https://ha.example.test\n\u{1B}[31m'),
		]);
		data.redactions = ['secret-token', 'https://ha.example.test', 'ha.example.test'];
		data.states[0]!.attributes.private_value = 'private-raw-marker';
		data.states[0]!.attributes.area_name = 'Untrusted Secret';
		registries(data).areas[0]!.name = 'Example 192.0.2.10 2001:db8::1 https://other.example.test';
		for (const mode of [false, true]) {
			const output = formatAuditReport(report(data), mode, data.redactions);
			for (const secret of [
				'secret-token',
				'ha.example.test',
				'private-raw-marker',
				'192.0.2.10',
				'2001:db8::1',
				'https://other.example.test',
				'\u{1B}',
			]) {
				expect(output).not.toContain(secret);
			}

			expect(output).toContain('[redacted]');
		}

		expect(() => {
			JSON.parse(formatAuditReport(report(data), true, data.redactions));
		}).not.toThrow();
	});
});

describe('ARYAL-relevant audit severity', () => {
	it.each(['not_allowed', 'denied', 'registry_only', 'disabled'])(
		'retains missing-area information for a %s switch without warning',
		(exclusion) => {
			const data = fixture([state('switch.example_addon', 'Example Add-on')]);
			registries(data).devices[0]!.area_id = null;
			switch (exclusion) {
				case 'not_allowed': {
					data.policy = {version: 1, allow: [{domain: 'light'}], deny: []};

					break;
				}

				case 'denied': {
					data.policy!.deny = [{entityId: 'switch.example_addon'}];

					break;
				}

				case 'registry_only': {
					data.states = [];

					break;
				}

				default: {
					registries(data).entities[0]!.disabled_by = 'integration';
				}
			}

			expect(findings(data, 'missing_area')[0]).toMatchObject({
				severity: 'info',
				details: {policyPermitted: false, aryalRelevant: false},
			});
			expect(report(data).summary.warnings).toBe(0);
			expect(formatAuditReport(report(data), true)).toContain('"code": "missing_area"');
		},
	);

	it('keeps a permitted room light missing an area worth reviewing', () => {
		const data = fixture();
		registries(data).devices[0]!.area_id = null;
		expect(findings(data, 'missing_area')[0]).toMatchObject({
			severity: 'warn',
			details: {policyPermitted: true, aryalRelevant: true},
		});
	});

	it('downgrades unexposed observation metadata without changing exposure', () => {
		const data = fixture([
			state('sensor.example_temperature', 'Example Temperature', '21', 'temperature'),
		]);
		data.policy = {version: 1, allow: [{domain: 'light'}], deny: []};
		registries(data).devices[0]!.area_id = null;
		expect(findings(data, 'missing_area')[0]?.severity).toBe('info');
		expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
			policyExposed: false,
			eligibleForPlanning: false,
			aryalRelevant: false,
		});
	});

	it.each([
		state('light.example_lamp', 'Example Lamp', 'unknown'),
		state('switch.example_switch', 'Example Switch', 'unavailable'),
		state('binary_sensor.example_presence', 'Example Presence', 'unknown', 'presence'),
		state('sensor.example_temperature', 'Example Temperature', 'unavailable', 'temperature'),
	])('warns about configured but unusable $entity_id without granting permission', (reading) => {
		const data = fixture([reading]);
		const before = JSON.stringify(data);
		expect(findings(data, 'unusable_current_state')[0]).toMatchObject({
			severity: 'warn',
			details: {aryalRelevant: true, policyPermitted: false},
		});
		expect(buildAuditInventory(data).entities[0]?.policyPermitted).toBe(false);
		expect(JSON.stringify(data)).toBe(before);
	});

	it.each(['button', 'notify', 'scene', 'conversation', 'tts', 'ai_task', 'device_tracker'])(
		'keeps unknown-state %s inventory facts informational even with an allow selector',
		(domain) => {
			const data = fixture([state(`${domain}.example_entity`, 'Example Entity', 'unknown')]);
			data.policy = {version: 1, allow: [{domain}], deny: []};
			expect(findings(data, 'unusable_current_state')[0]).toMatchObject({
				severity: 'info',
				details: {aryalRelevant: false},
			});
			expect(report(data).summary.warnings).toBe(0);
		},
	);

	it.each(['not_allowed', 'denied', 'disabled'])(
		'keeps an unavailable %s light informational',
		(exclusion) => {
			const data = fixture([state('light.example_lamp', 'Example Lamp', 'unavailable')]);
			if (exclusion === 'not_allowed') {
				data.policy = {version: 1, allow: [], deny: []};
			} else if (exclusion === 'denied') {
				data.policy!.deny = [{domain: 'light'}];
			} else {
				registries(data).devices[0]!.disabled_by = 'user';
			}

			expect(findings(data, 'unusable_current_state')[0]?.severity).toBe('info');
		},
	);

	it.each(['warm', 'NaN', 'on'])(
		'warns about invalid exposed temperature %s while retaining read-only readiness',
		(value) => {
			const data = fixture([
				state('sensor.example_temperature', 'Example Temperature', value, 'temperature'),
			]);
			expect(findings(data, 'unusable_observation_state')[0]?.severity).toBe('warn');
			expect(findings(data, 'observation_readiness')[0]?.details).toMatchObject({
				normalizable: false,
				eligibleForPlanning: false,
			});
			expect(buildAuditInventory(data).entities[0]?.supportedActions).toEqual([]);
			data.policy = {version: 1, allow: [], deny: []};
			expect(findings(data, 'unusable_observation_state')[0]?.severity).toBe('info');
		},
	);

	it.each([
		{
			readings: [
				state('binary_sensor.example_status', 'Example Status', 'on', 'connectivity'),
				state('sensor.example_status', 'Example Status', '1', 'energy'),
			],
		},
		{
			readings: [
				state('device_tracker.example_phone', 'Example Phone'),
				state('notify.example_phone', 'Example Phone'),
			],
		},
		{
			readings: [
				state('light.example_lamp', 'Example Lamp'),
				state('notify.example_lamp', 'Example Lamp'),
			],
		},
	])('retains expected cross-domain duplicate groups as INFO: $readings', ({readings}) => {
		const data = fixture(readings);
		const duplicates = findings(data, 'duplicate_friendly_name');
		expect(duplicates).toHaveLength(2);
		expect(duplicates.every(({severity}) => severity === 'info')).toBe(true);
		expect(duplicates[0]?.details.entityIds).toHaveLength(2);
	});

	it('keeps ambiguous configured lights WARN including an unavailable member, while unrelated members stay INFO', () => {
		const data = fixture([
			state('light.example_first', 'Example Room Light'),
			state('light.example_second', 'Example Room Light', 'unavailable'),
			state('notify.example_light', 'Example Room Light'),
		]);
		const duplicates = findings(data, 'duplicate_friendly_name');
		expect(duplicates.map(({entityId, severity}) => ({entityId, severity}))).toEqual([
			{entityId: 'light.example_first', severity: 'warn'},
			{entityId: 'light.example_second', severity: 'warn'},
			{entityId: 'notify.example_light', severity: 'info'},
		]);
		expect(duplicates[0]?.details).toMatchObject({
			entityIds: ['light.example_first', 'light.example_second', 'notify.example_light'],
			ambiguityEntityIds: ['light.example_first', 'light.example_second'],
		});
		expect(findings(data, 'unusable_current_state')[0]?.severity).toBe('warn');
	});

	it('warns for duplicate exposed observations, but not when only one is exposed', () => {
		const data = fixture([
			state('sensor.example_first', 'Example Reading', '21', 'temperature'),
			state('sensor.example_second', 'Example Reading', '45', 'humidity'),
		]);
		expect(findings(data, 'duplicate_friendly_name').map(({severity}) => severity)).toEqual([
			'warn',
			'warn',
		]);
		data.policy!.deny = [{entityId: 'sensor.example_second'}];
		expect(findings(data, 'duplicate_friendly_name').map(({severity}) => severity)).toEqual([
			'info',
			'info',
		]);
	});

	it.each(['not_allowed', 'unavailable', 'disabled'])(
		'keeps suspicious status-light hints informational when %s',
		(exclusion) => {
			const data = fixture([
				state(
					'light.example_status_light',
					'Example Status Light',
					exclusion === 'unavailable' ? 'unavailable' : 'on',
				),
			]);
			if (exclusion === 'not_allowed') {
				data.policy = {version: 1, allow: [], deny: []};
			} else if (exclusion === 'disabled') {
				registries(data).entities[0]!.disabled_by = 'user';
			}

			expect(findings(data, 'suspicious_actionable_name')[0]?.severity).toBe('info');
		},
	);

	it('does not elevate device-wide area conflicts caused only by an unrelated member', () => {
		const data = fixture([
			state('light.example_lamp'),
			state('switch.example_addon', 'Example Add-on'),
		]);
		data.policy = {version: 1, allow: [{domain: 'light'}], deny: []};
		registries(data).entities[1]!.area_id = 'example_other';
		expect(findings(data, 'entity_device_area_mismatch')[0]?.severity).toBe('info');
		expect(findings(data, 'device_entities_multiple_areas')[0]).toMatchObject({
			severity: 'info',
			details: {aryalRelevantEntityIds: ['light.example_lamp']},
		});
		data.policy.allow.push({domain: 'switch'});
		expect(findings(data, 'entity_device_area_mismatch')[0]?.severity).toBe('warn');
		expect(findings(data, 'device_entities_multiple_areas')[0]?.severity).toBe('warn');
	});

	it('warns for incomplete metadata on an explicit configured target without authorizing it', () => {
		const data = fixture();
		data.policy = {version: 2, allow: [{entityId: 'light.example_lamp'}], deny: []};
		registries(data).devices = [];
		const before = JSON.stringify(data);
		expect(findings(data, 'incomplete_metadata')[0]).toMatchObject({
			severity: 'warn',
			details: {aryalRelevant: true, policyPermitted: false},
		});
		expect(JSON.stringify(data)).toBe(before);
		data.policy.deny = [{labelId: 'example_critical'}];
		expect(findings(data, 'incomplete_metadata')[0]?.severity).toBe('info');
		data.policy = {version: 2, allow: [{areaId: 'example_room'}], deny: []};
		expect(findings(data, 'incomplete_metadata')[0]?.severity).toBe('info');
	});

	it.each([{areaId: 'example_room'}, {deviceId: 'example_device'}, {labelId: 'example_label'}])(
		'reuses registry selector matching for an unavailable configured target: %j',
		(selector) => {
			const data = fixture([state('light.example_lamp', 'Example Lamp', 'unavailable')]);
			registries(data).entities[0]!.labels = ['example_label'];
			registries(data).labels = [{label_id: 'example_label'}];
			data.policy = {version: 2, allow: [selector], deny: []};
			expect(findings(data, 'unusable_current_state')[0]?.severity).toBe('warn');
			data.policy.deny = [selector];
			expect(findings(data, 'unusable_current_state')[0]?.severity).toBe('info');
		},
	);

	it('prioritizes human warnings while keeping all INFO and stable JSON inventory facts', () => {
		const data = fixture([
			state('switch.example_addon', 'Example Add-on'),
			state('light.example_status', 'Example Status Light'),
		]);
		data.policy = {version: 1, allow: [{domain: 'light'}], deny: []};
		registries(data).devices[0]!.area_id = null;
		const result = report(data);
		const human = formatAuditReport(result, false);
		expect(human.indexOf('[WARN]')).toBeLessThan(human.indexOf('[INFO]'));
		expect(human.lastIndexOf('[WARN]')).toBeLessThan(human.indexOf('[INFO]'));
		const json = JSON.parse(formatAuditReport(result, true)) as AuditReport;
		expect(json.findings).toHaveLength(result.findings.length);
		expect(
			json.findings.filter(({code}) => code === 'missing_area').map(({severity}) => severity),
		).toEqual(['warn', 'info']);
	});
});

describe('read-only audit CLI', () => {
	it('completes with exit 0 even when metadata warnings exist', async () => {
		const data = fixture();
		registries(data).devices = [];
		const result = await runHaAuditCli(['--json'], async () => data);
		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.output) as AuditReport;
		expect(parsed.summary.errors).toBe(0);
		expect(parsed.summary.warnings).toBe(1);
	});

	it.each([{args: []}, {args: ['--json']}])(
		'supports human or JSON output: $args',
		async ({args}) => {
			const result = await runHaAuditCli(args, async () => fixture());
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(args.length === 0 ? 'HA metadata audit' : '"summary"');
		},
	);

	it.each([
		{args: ['--domain', 'light']},
		{args: ['--json', '--json']},
		{args: ['--execute']},
		{args: ['instruction']},
		{args: ['--json', '--help']},
	])('rejects invalid arguments without reading HA: $args', async ({args}) => {
		const collect = vi.fn(async () => fixture());
		const result = await runHaAuditCli(args, collect);
		expect(result.exitCode).toBe(2);
		expect(collect).not.toHaveBeenCalled();
	});

	it('offers help without HA credentials or collection', async () => {
		const collect = vi.fn(async () => fixture());
		expect(await runHaAuditCli(['--help'], collect)).toMatchObject({exitCode: 0});
		expect(collect).not.toHaveBeenCalled();
	});

	it('returns sanitized exit 1 for access failures', async () => {
		const result = await runHaAuditCli(['--json'], async () => {
			throw new Error('secret-token https://ha.example.test private raw response');
		});
		expect(result.exitCode).toBe(1);
		expect(result.output).not.toContain('secret-token');
		expect(JSON.parse(result.output)).toEqual({
			outcome: 'audit_failed',
			reason: 'ha_config_registry_or_policy_unavailable',
			exitCode: 1,
		});
	});

	it('fails closed on unavailable registries instead of presenting missing-area conclusions', async () => {
		const data = fixture();
		data.registries = {status: 'unavailable'};
		const result = await runHaAuditCli([], async () => data);
		expect(result.exitCode).toBe(1);
	});

	it('rejects duplicate state IDs instead of silently collapsing entities', async () => {
		const data = fixture([state('light.example_duplicate'), state('light.example_duplicate')]);
		const result = await runHaAuditCli([], async () => data);
		expect(result.exitCode).toBe(1);
	});
});
