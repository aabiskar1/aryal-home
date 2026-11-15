import {z} from 'zod';
import {areStateTimestampsValid} from '../home-assistant/state-timestamps.js';
import {historyTimestampSchema} from '../home-assistant/history-schemas.js';

const ageLimitSchema = z.number().int().min(1).max(86_400);
export const environmentReportingPolicySchema = z.strictObject({
	source: z
		.literal('application_advisory_policy_not_measurement_guarantee')
		.default('application_advisory_policy_not_measurement_guarantee'),
	indoorMaxReportAgeSeconds: ageLimitSchema.default(900),
	weatherMaxUpdateAgeSeconds: ageLimitSchema.default(1800),
});
export type EnvironmentReportingPolicy = z.infer<typeof environmentReportingPolicySchema>;
export const environmentalFreshnessSchema = z.enum([
	'recently_reported',
	'last_known_unverified',
	'unavailable_or_invalid',
]);
export type EnvironmentalFreshness = z.infer<typeof environmentalFreshnessSchema>;
export const environmentTimestampSchema = historyTimestampSchema.nullable();
type ActivityTimestamp = z.infer<typeof environmentTimestampSchema>;
export type EnvironmentTimestamps = {
	lastChangedAt: ActivityTimestamp;
	updatedAt: ActivityTimestamp;
	lastReportedAt?: string | undefined;
};

export const areEnvironmentTimestampsValid = (
	timestamps: EnvironmentTimestamps,
	now: number,
): boolean =>
	timestamps.lastChangedAt !== null &&
	timestamps.updatedAt !== null &&
	areStateTimestampsValid(
		{
			last_changed: timestamps.lastChangedAt,
			last_updated: timestamps.updatedAt,
			...(timestamps.lastReportedAt !== undefined && {last_reported: timestamps.lastReportedAt}),
		},
		now,
	);

/** Recent HA activity may be a cached report: physical measurement age remains unknown. */
export const indoorReportingFreshness = (
	timestamps: EnvironmentTimestamps,
	policy: EnvironmentReportingPolicy,
	now: number,
): EnvironmentalFreshness => {
	if (!areEnvironmentTimestampsValid(timestamps, now)) {
		return 'unavailable_or_invalid';
	}

	const activity = timestamps.lastReportedAt ?? timestamps.updatedAt!;
	return now - Date.parse(activity) <= policy.indoorMaxReportAgeSeconds * 1000
		? 'recently_reported'
		: 'last_known_unverified';
};

/** Weather attribute updates have their own window; an unchanged report cannot refresh them. */
export const weatherUpdateFreshness = (
	timestamps: EnvironmentTimestamps,
	policy: EnvironmentReportingPolicy,
	now: number,
): 'available' | 'stale' | 'invalid' => {
	if (!areEnvironmentTimestampsValid(timestamps, now)) {
		return 'invalid';
	}

	return now - Date.parse(timestamps.updatedAt!) <= policy.weatherMaxUpdateAgeSeconds * 1000
		? 'available'
		: 'stale';
};

export const environmentReportingPolicyFromEnv = (): EnvironmentReportingPolicy => {
	const env = z
		.object({
			ENVIRONMENT_INDOOR_REPORT_MAX_AGE_SECONDS: z.coerce
				.number()
				.int()
				.min(1)
				.max(86_400)
				.optional(),
			ENVIRONMENT_WEATHER_UPDATE_MAX_AGE_SECONDS: z.coerce
				.number()
				.int()
				.min(1)
				.max(86_400)
				.optional(),
		})
		.parse(process.env);
	return environmentReportingPolicySchema.parse({
		...(env.ENVIRONMENT_INDOOR_REPORT_MAX_AGE_SECONDS !== undefined && {
			indoorMaxReportAgeSeconds: env.ENVIRONMENT_INDOOR_REPORT_MAX_AGE_SECONDS,
		}),
		...(env.ENVIRONMENT_WEATHER_UPDATE_MAX_AGE_SECONDS !== undefined && {
			weatherMaxUpdateAgeSeconds: env.ENVIRONMENT_WEATHER_UPDATE_MAX_AGE_SECONDS,
		}),
	});
};
