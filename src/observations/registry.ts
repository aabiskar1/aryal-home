import {z} from 'zod';

export type ObservationDefinition = {
	readonly domain: 'sensor' | 'binary_sensor';
	readonly deviceClass: string;
	readonly kind: 'numeric' | 'binary';
	readonly profile: {readonly id: string; readonly phrases: readonly string[]};
};

/** Internal catalogue constructor, also used to exercise future registrations in isolation. */
export const defineObservationRegistry = <
	const Definitions extends readonly [ObservationDefinition, ...ObservationDefinition[]],
>(
	definitions: Definitions,
) => {
	const catalogue = Object.freeze(
		definitions.map((definition): Readonly<Definitions[number]> =>
			Object.freeze({
				...definition,
				profile: Object.freeze({
					...definition.profile,
					phrases: Object.freeze([...definition.profile.phrases]),
				}),
			}),
		),
	);
	const deviceClassSchema = z.enum(
		definitions.map((definition) => definition.deviceClass) as Array<
			Definitions[number]['deviceClass']
		>,
	);
	return Object.freeze({
		definitions: catalogue,
		deviceClassSchema,
		find: (domain: string, deviceClass: string | undefined) =>
			catalogue.find(
				(definition) => definition.domain === domain && definition.deviceClass === deviceClass,
			),
	});
};

const presenceProfile = {
	id: 'presence',
	phrases: [
		'anyone',
		'anybody',
		'someone',
		'no one',
		'noone',
		'nobody',
		'who is home',
		'presence',
		'occupancy',
		'occupied',
		'unoccupied',
		'empty',
		'vacant',
	],
} as const;

// Compile-time registrations only: no user configuration, class inference, or execution fields.
export const observationRegistry = defineObservationRegistry([
	{domain: 'binary_sensor', deviceClass: 'occupancy', kind: 'binary', profile: presenceProfile},
	{domain: 'binary_sensor', deviceClass: 'presence', kind: 'binary', profile: presenceProfile},
	{
		domain: 'sensor',
		deviceClass: 'temperature',
		kind: 'numeric',
		profile: {id: 'temperature', phrases: ['temperature', 'temperatures', 'temp']},
	},
	{
		domain: 'sensor',
		deviceClass: 'humidity',
		kind: 'numeric',
		profile: {id: 'humidity', phrases: ['humidity', 'humid']},
	},
	{
		domain: 'sensor',
		deviceClass: 'illuminance',
		kind: 'numeric',
		profile: {
			id: 'illuminance',
			phrases: [
				'illuminance',
				'lux',
				'lx',
				'light level',
				'how bright',
				'how dark',
				'brightness level',
				'bright',
				'dark',
				'dim',
			],
		},
	},
]);

export const observationDeviceClassSchema = observationRegistry.deviceClassSchema;
export type ObservationDeviceClass = z.infer<typeof observationDeviceClassSchema>;
export type ObservationProfile = (typeof observationRegistry.definitions)[number]['profile']['id'];

/** Preserve the original numeric string; reject non-decimal syntax and non-finite values. */
export const normalizeObservationValue = (
	definition: Pick<ObservationDefinition, 'kind'>,
	value: string,
): string | undefined => {
	const isValid =
		definition.kind === 'binary'
			? value === 'on' || value === 'off'
			: /^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+\-]?\d+)?$/iv.test(value.trim()) &&
				Number.isFinite(Number(value));
	return isValid ? value : undefined;
};

const unitSchema = z.string().trim().min(1).max(16);
export const normalizeObservationUnit = (value: unknown): string | undefined => {
	const unit = unitSchema.safeParse(value);
	return unit.success ? unit.data : undefined;
};
