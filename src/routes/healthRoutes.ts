import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { WahaClient } from '../services/wahaClient.js';
import type { BatchWorker } from '../worker/batchWorker.js';
import { isRequestAuthenticated } from './authRoutes.js';

export interface HealthRouteDeps {
  db: SqliteDb;
  wahaClient: WahaClient;
  worker: BatchWorker;
  config: AppConfig;
}

export function createHealthRoutes(deps: HealthRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/api/health', async (req) => {
      let dbOk = false;
      try {
        deps.db.prepare('SELECT 1 AS ok').get();
        dbOk = true;
      } catch {
        dbOk = false;
      }

      const authenticated = isRequestAuthenticated(req.headers, deps.config.adminApiToken);
      if (!authenticated) {
        return {
          ok: dbOk,
          db: dbOk ? 'ok' : 'error',
          authRequired: true,
        };
      }

      const wahaReachable = await deps.wahaClient.ping();
      return {
        ok: dbOk,
        db: dbOk ? 'ok' : 'error',
        wahaReachable,
        worker: deps.worker.getStatus(),
        config: {
          wahaSession: deps.config.wahaSession,
          minDelayMs: deps.config.workerMinDelayMs,
          maxDelayMs: deps.config.workerMaxDelayMs,
          chunkSize: deps.config.workerChunkSize,
          chunkPauseMinMs: deps.config.workerChunkPauseMinMs,
          chunkPauseMaxMs: deps.config.workerChunkPauseMaxMs,
          dailyLimit: deps.config.workerDailyLimit,
          suggestedBatchSize: deps.config.workerSuggestedBatchSize,
          maxBatchSize: deps.config.workerMaxBatchSize,
          defaultCountryCode: deps.config.defaultCountryCode,
          defaultMessageTemplate: deps.config.defaultMessageTemplate,
          businessHoursEnabled: deps.config.businessHoursEnabled,
          businessHoursStart: deps.config.businessHoursStart,
          businessHoursEnd: deps.config.businessHoursEnd,
          businessAllowedDays: deps.config.businessAllowedDays,
          timezone: deps.config.timezone,
          authRequired: Boolean(deps.config.adminApiToken),
        },
      };
    });
  };
}
