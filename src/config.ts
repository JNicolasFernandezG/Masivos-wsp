import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/app/masivos.db'),

  WAHA_BASE_URL: z.string().url().default('http://localhost:3000'),
  WAHA_API_KEY: z.string().default(''),
  WAHA_SESSION: z.string().min(1).default('default'),
  WAHA_WEBHOOK_HMAC_KEY: z.string().default(''),

  DEFAULT_COUNTRY_CODE: z.string().default(''),
  WORKER_MIN_DELAY_MS: z.coerce.number().int().min(0).default(20000),
  WORKER_MAX_DELAY_MS: z.coerce.number().int().min(0).default(60000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(3000),
  WORKER_SUGGESTED_BATCH_SIZE: z.coerce.number().int().min(1).default(25),
  WORKER_MAX_BATCH_SIZE: z.coerce.number().int().min(1).default(50),
  WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),

  ADMIN_API_TOKEN: z.string().default(''),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databasePath: string;
  wahaBaseUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  wahaWebhookHmacKey: string;
  defaultCountryCode: string;
  workerMinDelayMs: number;
  workerMaxDelayMs: number;
  workerPollIntervalMs: number;
  workerSuggestedBatchSize: number;
  workerMaxBatchSize: number;
  workerEnabled: boolean;
  adminApiToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const minDelay = parsed.WORKER_MIN_DELAY_MS;
  const maxDelay = Math.max(minDelay, parsed.WORKER_MAX_DELAY_MS);
  const maxBatchSize = Math.max(
    parsed.WORKER_SUGGESTED_BATCH_SIZE,
    parsed.WORKER_MAX_BATCH_SIZE
  );

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    databasePath: parsed.DATABASE_PATH,
    wahaBaseUrl: parsed.WAHA_BASE_URL.replace(/\/+$/, ''),
    wahaApiKey: parsed.WAHA_API_KEY,
    wahaSession: parsed.WAHA_SESSION,
    wahaWebhookHmacKey: parsed.WAHA_WEBHOOK_HMAC_KEY,
    defaultCountryCode: parsed.DEFAULT_COUNTRY_CODE.replace(/\D/g, ''),
    workerMinDelayMs: minDelay,
    workerMaxDelayMs: maxDelay,
    workerPollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    workerSuggestedBatchSize: parsed.WORKER_SUGGESTED_BATCH_SIZE,
    workerMaxBatchSize: maxBatchSize,
    workerEnabled: parsed.WORKER_ENABLED,
    adminApiToken: parsed.ADMIN_API_TOKEN,
  };
}
