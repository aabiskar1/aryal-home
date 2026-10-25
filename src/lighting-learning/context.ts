/* eslint-disable @stylistic/no-mixed-operators -- Preserve the conventional NOAA solar equations. */
import type {LearningLocation} from '../home-assistant/history-schemas.js';

export type Daylight = 'daylight' | 'civil_twilight' | 'night' | 'boundary_uncertain';
export type EpisodeContext = {
	localDate: string;
	localTime: string;
	utcOffset: string;
	timeOfDay: 'night' | 'morning' | 'afternoon' | 'evening';
	daylight: Daylight;
	solarElevation: number;
	solarReliability: 'approximate_configured_location';
	weather: 'not_collected';
};

/** NOAA fractional-year approximation; geometric elevation, no refraction or terrain model. */
export const solarElevationAt = (
	timestamp: number,
	latitude: number,
	longitude: number,
): number => {
	const date = new Date(timestamp);
	const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
	const daysInYear =
		new Date(Date.UTC(date.getUTCFullYear(), 1, 29)).getUTCMonth() === 1 ? 366 : 365;
	const day = Math.floor((timestamp - yearStart) / 86_400_000);
	const utcHour = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
	const gamma = ((2 * Math.PI) / daysInYear) * (day + (utcHour - 12) / 24);
	const equation =
		229.18 *
		(0.000075 +
			0.001868 * Math.cos(gamma) -
			0.032077 * Math.sin(gamma) -
			0.014615 * Math.cos(2 * gamma) -
			0.040849 * Math.sin(2 * gamma));
	const declination =
		0.006918 -
		0.399912 * Math.cos(gamma) +
		0.070257 * Math.sin(gamma) -
		0.006758 * Math.cos(2 * gamma) +
		0.000907 * Math.sin(2 * gamma) -
		0.002697 * Math.cos(3 * gamma) +
		0.00148 * Math.sin(3 * gamma);
	const hourAngle = (utcHour * 60 + equation + 4 * longitude) / 4 - 180;
	const radians = Math.PI / 180;
	const sine =
		Math.sin(latitude * radians) * Math.sin(declination) +
		Math.cos(latitude * radians) * Math.cos(declination) * Math.cos(hourAngle * radians);
	return Math.asin(Math.max(-1, Math.min(1, sine))) / radians;
};

// One-degree uncertainty bands avoid treating approximate sunrise/twilight boundaries as exact.
export const classifyDaylight = (elevation: number): Daylight => {
	if (Math.abs(elevation) <= 1 || Math.abs(elevation + 6) <= 1) {
		return 'boundary_uncertain';
	}

	if (elevation > 1) {
		return 'daylight';
	}

	return elevation < -7 ? 'night' : 'civil_twilight';
};

export const enrichEpisode = (timestamp: number, location: LearningLocation): EpisodeContext => {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: location.time_zone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hourCycle: 'h23',
		timeZoneName: 'longOffset',
	}).formatToParts(timestamp);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((entry) => entry.type === type)!.value;
	const hour = Number(part('hour'));
	const elevation = solarElevationAt(timestamp, location.latitude, location.longitude);
	return {
		localDate: `${part('year')}-${part('month')}-${part('day')}`,
		localTime: `${part('hour')}:${part('minute')}:${part('second')}`,
		utcOffset: part('timeZoneName'),
		timeOfDay: hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening',
		daylight: classifyDaylight(elevation),
		solarElevation: elevation,
		solarReliability: 'approximate_configured_location',
		weather: 'not_collected',
	};
};
