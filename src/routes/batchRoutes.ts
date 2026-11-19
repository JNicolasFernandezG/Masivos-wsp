import ExcelJS from 'exceljs';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { BatchRepository } from '../repositories/batchRepository.js';
import { prepareBatchPreview } from '../services/batchService.js';
import type { EventBus } from '../services/eventBus.js';
import { parseSpreadsheetBuffer } from '../services/fileParser.js';
import type { BatchWorker } from '../worker/batchWorker.js';

export interface BatchRouteDeps {
  batchRepo: BatchRepository;
  eventBus: EventBus;
  worker: BatchWorker;
  config: AppConfig;
}

const previewSchema = z.object({
  template: z.string().optional().default(''),
  phoneColumn: z.string().optional(),
  textColumn: z.string().optional(),
  defaultCountryCode: z.string().optional(),
  deduplicate: z.boolean().optional().default(true),
  rows: z.array(z.record(z.unknown())).min(1, 'Debes incluir al menos un destinatario.'),
});

const apiMessageItemSchema = z.object({
  to: z.string().min(1),
  text: z.string().optional(),
  variables: z.record(z.unknown()).optional(),
});

const createBatchSchema = z
  .object({
    name: z.string().trim().min(1, 'El nombre del lote es obligatorio.').max(120),
    source: z.enum(['web_file', 'web_manual', 'api']).optional().default('api'),
    template: z.string().optional().default(''),
    phoneColumn: z.string().optional(),
    textColumn: z.string().optional(),
    defaultCountryCode: z.string().optional(),
    skipInvalid: z.boolean().optional().default(false),
    deduplicate: z.boolean().optional().default(true),
    rows: z.array(z.record(z.unknown())).optional(),
    messages: z.array(apiMessageItemSchema).optional(),
  })
  .refine(
    (data) => (data.rows && data.rows.length > 0) || (data.messages && data.messages.length > 0),
    { message: 'Debes enviar "rows" o "messages" con al menos un destinatario.' }
  );

function flattenInputRows(input: z.infer<typeof createBatchSchema>): {
  rows: Record<string, unknown>[];
  phoneColumn?: string;
  textColumn?: string;
} {
  if (input.rows && input.rows.length > 0) {
    return {
      rows: input.rows,
      phoneColumn: input.phoneColumn,
      textColumn: input.textColumn,
    };
  }

  const rows = (input.messages ?? []).map((msg) => ({
    ...(msg.variables ?? {}),
    to: msg.to,
    ...(msg.text !== undefined ? { text: msg.text } : {}),
  }));

  return {
    rows,
    phoneColumn: 'to',
    textColumn: 'text',
  };
}

export async function buildSampleWorkbookBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Destinatarios');

  ws.columns = [
    { header: 'telefono', key: 'telefono', width: 20, style: { numFmt: '@' } },
    { header: 'nombre', key: 'nombre', width: 24, style: { numFmt: '@' } },
    { header: 'observacion', key: 'observacion', width: 32, style: { numFmt: '@' } },
  ];
  ws.getRow(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

export function createBatchRoutes(deps: BatchRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/api/batches/sample.xlsx', async (_req, reply) => {
      const buffer = await buildSampleWorkbookBuffer();
      return reply
        .header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        .header('Content-Disposition', 'attachment; filename="plantilla_asistodo.xlsx"')
        .send(buffer);
    });

    fastify.get('/api/batches', async () => {
      return {
        batches: deps.batchRepo.listBatches(),
        worker: deps.worker.getStatus(),
      };
    });

    fastify.get('/api/batches/:id', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({ error: 'ID de lote inválido.' });
      }
      const batch = deps.batchRepo.getBatchById(id);
      if (!batch) {
        return reply.status(404).send({ error: 'Lote no encontrado.' });
      }
      const messages = deps.batchRepo.getBatchMessages(id);
      return { batch, messages };
    });

    fastify.post('/api/batches/parse-file', async (req, reply) => {
      const file = await req.file();
      if (!file) {
        return reply.status(400).send({ error: 'No se recibió ningún archivo.' });
      }

      try {
        const buffer = await file.toBuffer();
        const parsed = await parseSpreadsheetBuffer(buffer, file.filename);
        return {
          filename: file.filename,
          ...parsed,
        };
      } catch (err) {
        return reply.status(400).send({
          error: err instanceof Error ? err.message : 'No se pudo procesar el archivo.',
        });
      }
    });

    fastify.post('/api/batches/preview', async (req, reply) => {
      const parsed = previewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues[0]?.message ?? 'Datos de previsualización inválidos.',
        });
      }

      const preview = prepareBatchPreview({
        rows: parsed.data.rows,
        phoneColumn: parsed.data.phoneColumn,
        textColumn: parsed.data.textColumn,
        template: parsed.data.template,
        defaultCountryCode: parsed.data.defaultCountryCode,
        deduplicate: parsed.data.deduplicate,
        config: deps.config,
      });

      return preview;
    });

    fastify.post('/api/batches', async (req, reply) => {
      const parsed = createBatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: parsed.error.issues[0]?.message ?? 'Payload inválido para crear lote.',
        });
      }

      const flattened = flattenInputRows(parsed.data);
      const preview = prepareBatchPreview({
        rows: flattened.rows,
        phoneColumn: flattened.phoneColumn,
        textColumn: flattened.textColumn,
        template: parsed.data.template,
        defaultCountryCode: parsed.data.defaultCountryCode,
        deduplicate: parsed.data.deduplicate,
        config: deps.config,
      });

      if (preview.invalidCount > 0 && !parsed.data.skipInvalid) {
        return reply.status(400).send({
          error: `Hay ${preview.invalidCount} fila(s) con errores de validación.`,
          preview,
        });
      }

      if (preview.validCount === 0) {
        return reply.status(400).send({
          error: 'No hay ningún destinatario válido para encolar.',
          preview,
        });
      }

      if (preview.validCount > deps.config.workerMaxBatchSize) {
        return reply.status(400).send({
          error: `El lote tiene ${preview.validCount} mensajes válidos y excede el máximo permitido (${deps.config.workerMaxBatchSize}).`,
          preview,
        });
      }

      const batch = deps.batchRepo.createBatch({
        name: parsed.data.name,
        source: parsed.data.source,
        template: preview.effectiveTemplate,
        items: preview.validItems,
      });

      deps.eventBus.emit('batch.updated', batch);

      return reply.status(201).send({
        batch,
        chunkCount: preview.chunkCount,
        chunkSize: preview.chunkSize,
        estimatedDays: preview.estimatedDays,
        warnings: preview.warnings,
        skippedInvalidCount: preview.invalidCount,
        skippedDuplicateCount: preview.duplicateCount,
        estimatedDurationSeconds: preview.estimatedDurationSeconds,
      });
    });

    fastify.post('/api/batches/:id/pause', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({ error: 'ID inválido.' });
      }
      const batch = deps.batchRepo.pauseBatch(id);
      if (!batch) return reply.status(404).send({ error: 'Lote no encontrado.' });
      deps.eventBus.emit('batch.updated', batch);
      return { batch };
    });

    fastify.post('/api/batches/:id/resume', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({ error: 'ID inválido.' });
      }
      const batch = deps.batchRepo.resumeBatch(id);
      if (!batch) return reply.status(404).send({ error: 'Lote no encontrado.' });
      deps.eventBus.emit('batch.updated', batch);
      return { batch };
    });

    fastify.post('/api/batches/:id/cancel', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({ error: 'ID inválido.' });
      }
      const batch = deps.batchRepo.cancelBatch(id);
      if (!batch) return reply.status(404).send({ error: 'Lote no encontrado.' });
      deps.eventBus.emit('batch.updated', batch);
      return { batch };
    });

    fastify.post('/api/batches/:id/retry-failed', async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({ error: 'ID inválido.' });
      }
      const batch = deps.batchRepo.retryFailedMessages(id);
      if (!batch) return reply.status(404).send({ error: 'Lote no encontrado.' });
      deps.eventBus.emit('batch.updated', batch);
      return { batch };
    });
  };
}
