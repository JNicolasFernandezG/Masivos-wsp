import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { WahaClient } from '../services/wahaClient.js';
import { WahaApiError } from '../services/wahaClient.js';

export interface WahaRouteDeps {
  wahaClient: WahaClient;
  config: AppConfig;
}

const requestCodeSchema = z.object({
  phoneNumber: z.string().min(6, 'Ingresa un número de teléfono válido con código de país.'),
});

export function createWahaRoutes(deps: WahaRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    const sessionName = deps.config.wahaSession;

    fastify.get('/api/waha/session', async () => {
      try {
        const session = await deps.wahaClient.getSession(sessionName);
        return {
          reachable: true,
          sessionName,
          session: session ?? { name: sessionName, status: 'STOPPED' },
        };
      } catch (err) {
        return {
          reachable: false,
          sessionName,
          session: { name: sessionName, status: 'UNREACHABLE' },
          error: err instanceof Error ? err.message : 'WAHA no disponible',
        };
      }
    });

    fastify.post('/api/waha/session/start', async (_req, reply) => {
      try {
        const session = await deps.wahaClient.startSession(sessionName);
        return { ok: true, session };
      } catch (err) {
        const code = err instanceof WahaApiError ? err.statusCode : 502;
        return reply.status(code >= 400 ? code : 502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Error iniciando sesión WAHA',
        });
      }
    });

    fastify.post('/api/waha/session/stop', async (_req, reply) => {
      try {
        await deps.wahaClient.stopSession(sessionName);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Error deteniendo sesión WAHA',
        });
      }
    });

    fastify.post('/api/waha/session/restart', async (_req, reply) => {
      try {
        await deps.wahaClient.restartSession(sessionName);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Error reiniciando sesión WAHA',
        });
      }
    });

    fastify.post('/api/waha/session/logout', async (_req, reply) => {
      try {
        await deps.wahaClient.logoutSession(sessionName);
        return { ok: true };
      } catch (err) {
        return reply.status(502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Error cerrando sesión WAHA',
        });
      }
    });

    fastify.get('/api/waha/qr', async (_req, reply) => {
      try {
        const qr = await deps.wahaClient.getQrCode(sessionName);
        return { ok: true, ...qr };
      } catch (err) {
        const status = err instanceof WahaApiError ? err.statusCode : 502;
        return reply.status(status >= 400 ? status : 502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'QR no disponible en este estado.',
        });
      }
    });

    fastify.post('/api/waha/request-code', async (req, reply) => {
      const parsed = requestCodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ ok: false, error: parsed.error.issues[0]?.message });
      }
      try {
        const res = await deps.wahaClient.requestPairingCode(
          sessionName,
          parsed.data.phoneNumber
        );
        return { ok: true, code: res.code };
      } catch (err) {
        const status = err instanceof WahaApiError ? err.statusCode : 502;
        return reply.status(status >= 400 ? status : 502).send({
          ok: false,
          error: err instanceof Error ? err.message : 'Error solicitando código de vinculación.',
        });
      }
    });
  };
}
