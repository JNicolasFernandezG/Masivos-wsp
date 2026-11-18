import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { verifyWahaHmac, type WebhookService } from '../services/webhookService.js';

export interface WebhookRouteDeps {
  webhookService: WebhookService;
  config: AppConfig;
}

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

export function createWebhookRoutes(deps: WebhookRouteDeps): FastifyPluginAsync {
  return async (fastify) => {
    fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (req, body, done) => {
        const buf = body as Buffer;
        (req as RequestWithRawBody).rawBody = buf;
        try {
          const text = buf.toString('utf8');
          const parsed = text.trim() ? JSON.parse(text) : {};
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    fastify.post('/api/webhooks/waha', async (req, reply) => {
      if (deps.config.wahaWebhookHmacKey) {
        const rawBody = (req as RequestWithRawBody).rawBody ?? Buffer.alloc(0);
        const signature = req.headers['x-webhook-hmac'];
        const algorithm = req.headers['x-webhook-hmac-algorithm'];

        const sigStr = Array.isArray(signature) ? signature[0] : signature;
        const algStr = Array.isArray(algorithm) ? algorithm[0] : algorithm;

        const valid = verifyWahaHmac(
          rawBody,
          sigStr,
          algStr,
          deps.config.wahaWebhookHmacKey
        );
        if (!valid) {
          req.log.warn('Firma HMAC de webhook WAHA inválida o ausente');
          return reply.status(401).send({ ok: false, error: 'Firma HMAC inválida.' });
        }
      }

      const result = await deps.webhookService.handleEvent(req.body);
      return reply.status(200).send({ ok: true, ...result });
    });
  };
}
