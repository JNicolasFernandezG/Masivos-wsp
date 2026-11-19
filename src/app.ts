import fs from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import type { SqliteDb } from './db/database.js';
import { BatchRepository } from './repositories/batchRepository.js';
import { LidRepository } from './repositories/lidRepository.js';
import { MessageRepository } from './repositories/messageRepository.js';
import { createAuthRoutes, isRequestAuthenticated } from './routes/authRoutes.js';
import { createBatchRoutes } from './routes/batchRoutes.js';
import { createEventRoutes } from './routes/eventRoutes.js';
import { createHealthRoutes } from './routes/healthRoutes.js';
import { createMessageRoutes } from './routes/messageRoutes.js';
import { createWahaRoutes } from './routes/wahaRoutes.js';
import { createWebhookRoutes } from './routes/webhookRoutes.js';
import { EventBus } from './services/eventBus.js';
import type { WahaClient } from './services/wahaClient.js';
import { WebhookService } from './services/webhookService.js';
import { BatchWorker } from './worker/batchWorker.js';

export interface AppContext {
  app: FastifyInstance;
  db: SqliteDb;
  batchRepo: BatchRepository;
  messageRepo: MessageRepository;
  lidRepo: LidRepository;
  eventBus: EventBus;
  worker: BatchWorker;
}

export interface BuildAppOptions {
  config: AppConfig;
  db: SqliteDb;
  wahaClient: WahaClient;
  publicDir?: string;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): AppContext {
  const { config, db, wahaClient } = options;
  const app = Fastify({
    logger: options.logger ?? config.nodeEnv !== 'test',
  });

  const batchRepo = new BatchRepository(db);
  const messageRepo = new MessageRepository(db);
  const lidRepo = new LidRepository(db);
  const eventBus = new EventBus();
  const webhookService = new WebhookService(messageRepo, lidRepo, wahaClient, eventBus);
  const worker = new BatchWorker({
    batchRepo,
    wahaClient,
    eventBus,
    config,
  });

  app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024,
      files: 1,
    },
  });

  if (config.adminApiToken) {
    app.addHook('onRequest', async (req, reply) => {
      const urlPath = req.url.split('?')[0];
      if (!urlPath.startsWith('/api/')) {
        return;
      }
      if (
        urlPath === '/api/health' ||
        urlPath === '/api/webhooks/waha' ||
        urlPath.startsWith('/api/auth/')
      ) {
        return;
      }

      if (!isRequestAuthenticated(req.headers, config.adminApiToken)) {
        return reply.status(401).send({
          ok: false,
          error: 'No autorizado. Inicia sesión o envía ADMIN_API_TOKEN.',
        });
      }
    });
  }

  app.register(createAuthRoutes(config));
  app.register(createHealthRoutes({ db, wahaClient, worker, config }));
  app.register(createWahaRoutes({ wahaClient, config }));
  app.register(createWebhookRoutes({ webhookService, config }));
  app.register(createBatchRoutes({ batchRepo, eventBus, worker, config }));
  app.register(createMessageRoutes({ messageRepo, lidRepo, wahaClient, eventBus, config }));
  app.register(createEventRoutes(eventBus));

  const publicDir = options.publicDir ?? path.resolve(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      dotfiles: 'deny',
    });
  }

  return {
    app,
    db,
    batchRepo,
    messageRepo,
    lidRepo,
    eventBus,
    worker,
  };
}
