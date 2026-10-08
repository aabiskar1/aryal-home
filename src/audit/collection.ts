import {z} from 'zod';
import {loadEntityPolicy} from '../config/policy.js';
import {
	getHomeAssistantRegistries,
	type RegistrySnapshot,
} from '../home-assistant/registry-client.js';
import {createHomeAssistantStateReader} from '../home-assistant/state-reader.js';
import type {HomeAssistantState} from '../home-assistant/schemas.js';
import type {EntityPolicy} from '../policy/schemas.js';

export type AuditData = {
	states: HomeAssistantState[];
	registries: RegistrySnapshot;
	policy: EntityPolicy | undefined;
	redactions: readonly string[];
};

const auditConfigSchema = z.object({HA_URL: z.url(), HA_TOKEN: z.string().min(1)});

const readOptionalPolicy = async (): Promise<EntityPolicy | undefined> => {
	try {
		return await loadEntityPolicy();
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}

		throw new Error('Audit policy could not be read.', {cause: error});
	}
};

/** GET states, read-only registry lists, and a local policy read. No model or execution imports. */
export const collectAuditData = async (): Promise<AuditData> => {
	const config = auditConfigSchema.parse(process.env);
	const readStates = createHomeAssistantStateReader(config.HA_URL, config.HA_TOKEN);
	const [states, registries, policy] = await Promise.all([
		readStates(),
		getHomeAssistantRegistries(config.HA_URL, config.HA_TOKEN),
		readOptionalPolicy(),
	]);
	if (registries.status !== 'available') {
		throw new Error('Audit requires available Home Assistant registries.');
	}

	return {
		states,
		registries,
		policy,
		redactions: [config.HA_TOKEN, config.HA_URL, new URL(config.HA_URL).hostname],
	};
};
