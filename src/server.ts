import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { HttpWahaClient } from './services/wahaClient.js';

async function main() {
  const config = loadConfig();
  const db = createDatabase(config.databasePath);
  const wahaClient = new HttpWahaClient(config.wahaBaseUrl, config.wahaApiKey);

  const { app, worker } = buildApp({
    config,
    db,
    wahaClient,
  });

  if (config.workerEnabled) {
    worker.start();
    app.log.info(
      `Worker de lotes iniciado (jitter ${config.workerMinDelayMs}-${config.workerMaxDelayMs} ms)`
    );
  } else {
    app.log.info('Worker embebido deshabilitado (WORKER_ENABLED=false)');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`Recibida señal ${signal}, cerrando servidor y worker...`);
    try {
      await worker.stop();
      await app.close();
      db.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error durante el cierre controlado');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({
    port: config.port,
    host: config.host,
  });
}

main().catch((err) => {
  console.error('Error fatal al iniciar Masivos-wsp:', err);
  process.exit(1);
});
