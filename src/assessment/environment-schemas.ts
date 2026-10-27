import {z} from 'zod';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';
import {clockSchema, presenceSchema} from './schemas.js';

// Current conditions only: https://www.home-assistant.io/integrations/weather/#condition-mapping
export const weatherConditionSchema = z.enum([
	'clear-night',
	'cloudy',
	'exceptional',
	'fog',
	'hail',
	'lightning',
	'lightning-rainy',
	'partlycloudy',
	'pouring',
	'rainy',
	'snowy',
	'snowy-rainy',
	'sunny',
	'windy',
	'windy-variant',
]);
export const environmentStatusSchema = z.enum([
	'available',
	'missing',
	'unavailable',
	'invalid',
	'stale',
]);
const timestamps = {
	measuredAt: historyTimestampSchema.nullable(),
	updatedAt: historyTimestampSchema.nullable(),
};
const valueSchema = z.union([z.number(), z.enum(['on', 'off']), z.null()]);
const unitSchema = z.enum(['°C', '%']).nullable();
const originalUnitSchema = z.enum(['°C', '°F', 'K', '%']).nullable();
const rawIndoorSchema = z.strictObject({
	ref: z.string().regex(/^indoor_\d{1,2}$/v),
	source: z.literal('home_assistant_state'),
	scope: z.literal('selected_area'),
	deviceClass: z.enum(['temperature', 'humidity', 'presence', 'occupancy']),
	status: environmentStatusSchema,
	value: valueSchema,
	unit: unitSchema,
	originalUnit: originalUnitSchema,
	freshnessBasis: z.literal('last_changed'),
	...timestamps,
});
export const indoorEnvironmentSchema = rawIndoorSchema.refine((item) => {
	if (item.status !== 'available') {
		return item.value === null;
	}

	if (item.measuredAt === null || item.updatedAt === null) {
		return false;
	}

	if (item.deviceClass === 'temperature') {
		return (
			typeof item.value === 'number' &&
			item.value >= -273.15 &&
			item.unit === '°C' &&
			['°C', '°F', 'K'].includes(item.originalUnit ?? '')
		);
	}

	if (item.deviceClass === 'humidity') {
		return (
			typeof item.value === 'number' &&
			item.value >= 0 &&
			item.value <= 100 &&
			item.unit === '%' &&
			item.originalUnit === '%'
		);
	}

	return (
		(item.value === 'on' || item.value === 'off') &&
		item.unit === null &&
		item.originalUnit === null
	);
});
const rawWeatherValueSchema = z.strictObject({
	ref: z.enum(['outdoor_temperature', 'outdoor_humidity']),
	status: environmentStatusSchema,
	value: z.number().nullable(),
	unit: unitSchema,
	originalUnit: originalUnitSchema,
});
const weatherValueSchema = rawWeatherValueSchema.refine((item) => {
	if (item.status !== 'available') {
		return item.value === null;
	}

	if (item.value === null) {
		return false;
	}

	return item.ref === 'outdoor_temperature'
		? item.value >= -273.15 &&
				item.unit === '°C' &&
				['°C', '°F', 'K'].includes(item.originalUnit ?? '')
		: item.value >= 0 && item.value <= 100 && item.unit === '%' && item.originalUnit === '%';
});
const rawWeatherSchema = z.strictObject({
	ref: z.literal('weather_1'),
	source: z.literal('home_assistant_weather_state'),
	scope: z.literal('installation'),
	status: z.enum([
		'available',
		'missing_or_not_permitted',
		'multiple_sources',
		'unavailable',
		'invalid',
		'stale',
	]),
	condition: weatherConditionSchema.nullable(),
	freshnessBasis: z.literal('last_updated_snapshot'),
	measurementTime: z.literal('provider_measurement_time_unknown'),
	...timestamps,
	temperature: weatherValueSchema,
	humidity: weatherValueSchema,
});
export const outdoorWeatherSchema = rawWeatherSchema.refine(
	(item) =>
		item.temperature.ref === 'outdoor_temperature' &&
		item.humidity.ref === 'outdoor_humidity' &&
		(item.status === 'available'
			? item.condition !== null && item.measuredAt !== null && item.updatedAt !== null
			: item.condition === null && item.temperature.value === null && item.humidity.value === null),
);
const rawEnvironmentContextSchema = z.strictObject({
	version: z.literal(1),
	goal: z.literal('environment_comfort'),
	scope: z.literal('selected_area'),
	capturedAt: historyTimestampSchema,
	states: z.array(z.never()).max(0),
	observations: z.array(indoorEnvironmentSchema).max(16),
	outdoorWeather: outdoorWeatherSchema,
	preference: z.strictObject({
		status: z.literal('unknown'),
		source: z.literal('environment_preferences_not_configured'),
	}),
	clock: clockSchema,
	presence: presenceSchema,
	comparisonPolicy: z.strictObject({
		source: z.literal('advisory_comparison_tolerance_not_comfort_preference'),
		temperatureDeltaC: z.literal(0.5),
		humidityDeltaPercent: z.literal(1),
	}),
});
export const environmentContextSchema = rawEnvironmentContextSchema.refine(
	(context) =>
		new Set(context.observations.map((item) => item.ref)).size === context.observations.length,
);
export type EnvironmentContext = z.infer<typeof environmentContextSchema>;
export type IndoorEnvironmentObservation = z.infer<typeof indoorEnvironmentSchema>;
export type OutdoorWeather = z.infer<typeof outdoorWeatherSchema>;
export type WeatherValue = OutdoorWeather['temperature'];

const evidenceRefSchema = z
	.string()
	.regex(/^(?:indoor_\d{1,2}|weather_1|outdoor_temperature|outdoor_humidity)$/v);
const evidenceRefsSchema = z.array(evidenceRefSchema).min(2).max(20);
const temperatureRelationSchema = z.enum([
	'indoor_warmer',
	'indoor_cooler',
	'similar',
	'not_compared',
]);
const humidityRelationSchema = z.enum(['indoor_higher', 'indoor_lower', 'similar', 'not_compared']);
const responseFields = {presence: presenceSchema, rationale: z.string().trim().min(1).max(320)};
const insightFields = {
	...responseFields,
	evidenceRefs: evidenceRefsSchema,
	temperatureRelation: temperatureRelationSchema,
	humidityRelation: humidityRelationSchema,
	weatherCondition: weatherConditionSchema,
};
const insightSchema = z.strictObject({
	...insightFields,
	outcome: z.literal('insight'),
	category: z.enum(['temperature_comparison', 'humidity_comparison', 'weather_caution']),
});
const reviewSchema = z.strictObject({
	...insightFields,
	outcome: z.literal('recommend_review'),
	category: z.enum(['ventilation_review', 'comfort_preferences_review']),
});
const noActionSchema = z.strictObject({...responseFields, outcome: z.literal('no_action')});
const insufficientSchema = z.strictObject({
	...responseFields,
	outcome: z.literal('insufficient_context'),
});
export const environmentProposalSchema = z.discriminatedUnion('outcome', [
	insightSchema,
	reviewSchema,
	noActionSchema,
	insufficientSchema,
]);
export type EnvironmentProposal = z.infer<typeof environmentProposalSchema>;
export const environmentProposalJsonSchema = z.toJSONSchema(environmentProposalSchema);
