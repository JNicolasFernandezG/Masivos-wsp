import type { FastifyPluginAsync } from 'fastify';
import type { EventBus } from '../services/eventBus.js';

export function createEventRoutes(eventBus: EventBus): FastifyPluginAsync {
  return async (fastify) => {
    fastify.get('/api/events', async (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const writeEvent = (event: string, data: unknown) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      writeEvent('connected', { timestamp: new Date().toISOString() });

      const unsubscribe = eventBus.subscribe((appEvent) => {
        writeEvent(appEvent.type, appEvent);
      });

      const heartbeat = setInterval(() => {
        reply.raw.write(': keepalive\n\n');
      }, 20000);

      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      return reply;
    });
  };
}
