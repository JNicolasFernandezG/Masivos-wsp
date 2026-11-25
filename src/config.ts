import 'dotenv/config';
import { z } from 'zod';

export const FALLBACK_DEFAULT_MESSAGE_TEMPLATE =
  'Usted, {{nombre}} registra deuda con Asistodo, regularice enviando un mensaje de whatsapp al 1176560109';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_PATH: z.string().default('./data/app/masivos.db'),
  TZ: z.string().default('America/Argentina/Buenos_Aires'),

  WAHA_BASE_URL: z.string().url().default('http://localhost:3000'),
  WAHA_API_KEY: z.string().default(''),
  WAHA_SESSION: z.string().min(1).default('default'),
  WAHA_WEBHOOK_HMAC_KEY: z.string().default(''),
  WAHA_TIMEOUT_MS: z.coerce.number().int().min(5000).default(60000),

  DEFAULT_COUNTRY_CODE: z.string().default('549'),
  DEFAULT_MESSAGE_TEMPLATE: z
    .string()
    .default(
      'Usted, {{nombre}} registra deuda con Asistodo, regularice enviando un mensaje de whatsapp al 1176560109'
    ),

  WORKER_MIN_DELAY_MS: z.coerce.number().int().min(0).default(20000),
  WORKER_MAX_DELAY_MS: z.coerce.number().int().min(0).default(60000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(200).default(3000),
  WORKER_CHUNK_SIZE: z.coerce.number().int().min(1).default(25),
  WORKER_CHUNK_PAUSE_MIN_MS: z.coerce.number().int().min(0).default(2700000),
  WORKER_CHUNK_PAUSE_MAX_MS: z.coerce.number().int().min(0).default(3600000),
  WORKER_DAILY_LIMIT: z.coerce.number().int().min(1).default(125),
  WORKER_SUGGESTED_BATCH_SIZE: z.coerce.number().int().min(1).default(25),
  WORKER_MAX_BATCH_SIZE: z.coerce.number().int().min(1).default(4000),
  WORKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),

  BUSINESS_HOURS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),
  BUSINESS_HOURS_START: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('09:00'),
  BUSINESS_HOURS_END: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default('19:00'),
  BUSINESS_ALLOWED_DAYS: z.string().default('1,2,3,4,5,6'),

  AUTH_REQUIRED: z
    .string()
    .default('false')
    .transform((v) => v.toLowerCase() === 'true' || v === '1'),
  ADMIN_API_TOKEN: z.string().default(''),
  SSO_SECRET: z.string().default(''),
  SSO_MAX_TTL_SECONDS: z.coerce.number().int().min(10).max(600).default(300),
  SSO_ALLOWED_ISSUER: z.string().default(''),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  databasePath: string;
  timezone: string;
  wahaBaseUrl: string;
  wahaApiKey: string;
  wahaSession: string;
  wahaWebhookHmacKey: string;
  wahaTimeoutMs: number;
  defaultCountryCode: string;
  defaultMessageTemplate: string;
  workerMinDelayMs: number;
  workerMaxDelayMs: number;
  workerPollIntervalMs: number;
  workerChunkSize: number;
  workerChunkPauseMinMs: number;
  workerChunkPauseMaxMs: number;
  workerDailyLimit: number;
  workerSuggestedBatchSize: number;
  workerMaxBatchSize: number;
  workerEnabled: boolean;
  businessHoursEnabled: boolean;
  businessHoursStart: string;
  businessHoursEnd: string;
  businessAllowedDays: number[];
  authRequired: boolean;
  adminApiToken: string;
  ssoSecret: string;
  ssoMaxTtlSeconds: number;
  ssoAllowedIssuer: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (
    parsed.AUTH_REQUIRED &&
    (!parsed.ADMIN_API_TOKEN.trim() ||
      parsed.ADMIN_API_TOKEN.trim() === 'cambia_esta_clave_de_acceso')
  ) {
    throw new Error(
      'AUTH_REQUIRED=true exige configurar un ADMIN_API_TOKEN seguro y distinto del placeholder en .env.'
    );
  }
  const minDelay = parsed.WORKER_MIN_DELAY_MS;
  const maxDelay = Math.max(minDelay, parsed.WORKER_MAX_DELAY_MS);
  const chunkPauseMin = parsed.WORKER_CHUNK_PAUSE_MIN_MS;
  const chunkPauseMax = Math.max(chunkPauseMin, parsed.WORKER_CHUNK_PAUSE_MAX_MS);
  const maxBatchSize = Math.max(
    parsed.WORKER_SUGGESTED_BATCH_SIZE,
    parsed.WORKER_MAX_BATCH_SIZE
  );

  const allowedDays = parsed.BUSINESS_ALLOWED_DAYS.split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);

  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    host: parsed.HOST,
    databasePath: parsed.DATABASE_PATH,
    timezone: parsed.TZ,
    wahaBaseUrl: parsed.WAHA_BASE_URL.replace(/\/+$/, ''),
    wahaApiKey: parsed.WAHA_API_KEY,
    wahaSession: parsed.WAHA_SESSION,
    wahaWebhookHmacKey: parsed.WAHA_WEBHOOK_HMAC_KEY,
    wahaTimeoutMs: parsed.WAHA_TIMEOUT_MS,
    defaultCountryCode: parsed.DEFAULT_COUNTRY_CODE.replace(/\D/g, ''),
    defaultMessageTemplate:
      parsed.DEFAULT_MESSAGE_TEMPLATE.trim() || FALLBACK_DEFAULT_MESSAGE_TEMPLATE,
    workerMinDelayMs: minDelay,
    workerMaxDelayMs: maxDelay,
    workerPollIntervalMs: parsed.WORKER_POLL_INTERVAL_MS,
    workerChunkSize: parsed.WORKER_CHUNK_SIZE,
    workerChunkPauseMinMs: chunkPauseMin,
    workerChunkPauseMaxMs: chunkPauseMax,
    workerDailyLimit: parsed.WORKER_DAILY_LIMIT,
    workerSuggestedBatchSize: parsed.WORKER_SUGGESTED_BATCH_SIZE,
    workerMaxBatchSize: maxBatchSize,
    workerEnabled: parsed.WORKER_ENABLED,
    businessHoursEnabled: parsed.BUSINESS_HOURS_ENABLED,
    businessHoursStart: parsed.BUSINESS_HOURS_START,
    businessHoursEnd: parsed.BUSINESS_HOURS_END,
    businessAllowedDays: allowedDays.length > 0 ? allowedDays : [1, 2, 3, 4, 5, 6],
    authRequired: parsed.AUTH_REQUIRED,
    adminApiToken: parsed.ADMIN_API_TOKEN,
    ssoSecret: parsed.SSO_SECRET.trim(),
    ssoMaxTtlSeconds: parsed.SSO_MAX_TTL_SECONDS,
    ssoAllowedIssuer: parsed.SSO_ALLOWED_ISSUER.trim(),
  };
}
