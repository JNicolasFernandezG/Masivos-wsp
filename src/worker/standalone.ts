import { loadConfig } from '../config.js';
import { createDatabase } from '../db/database.js';
import { BatchRepository } from '../repositories/batchRepository.js';
import { EventBus } from '../services/eventBus.js';
import { HttpWahaClient } from '../services/wahaClient.js';
import { BatchWorker } from './batchWorker.js';

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const batchRepo = new BatchRepository(db);
  const wahaClient = new HttpWahaClient(
    config.wahaBaseUrl,
    config.wahaApiKey,
    config.wahaTimeoutMs
  );
  const eventBus = new EventBus();

  const worker = new BatchWorker({
    batchRepo,
    wahaClient,
    eventBus,
    config,
  });

  worker.start();
  console.log(
    `[worker] Iniciado en modo independiente (jitter ${config.workerMinDelayMs}-${config.workerMaxDelayMs} ms)`
  );

  const shutdown = async (signal: string) => {
    console.log(`[worker] Recibida señal ${signal}, deteniendo...`);
    await worker.stop();
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] Error fatal:', err);
  process.exit(1);
});
