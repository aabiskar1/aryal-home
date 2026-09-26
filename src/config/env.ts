import {z} from 'zod';

const envSchema = z.object({
	HA_URL: z.url(),
	HA_TOKEN: z.string().min(1),
	OLLAMA_URL: z.url().default('http://localhost:11434'),
	OLLAMA_MODEL: z.string().default('gemma4:e2b'),
	PLANNING_REQUEST_MAX_BYTES: z.coerce.number().int().min(8192).default(24_576),
	DRY_RUN: z
		.enum(['true', 'false'])
		.default('true')
		.transform((value) => value === 'true'),
});

export const env = envSchema.parse(process.env);
