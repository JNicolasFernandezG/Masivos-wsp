import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';

export const SESSION_COOKIE_NAME = 'masivos_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 horas
const MAX_LOGIN_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 60 * 1000;

export function constantTimeEquals(expected: string, provided: string): boolean {
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(expectedHash, providedHash);
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(val);
      } catch {
        cookies[key] = val;
      }
    }
  }
  return cookies;
}

function getCookieSigningKey(adminToken: string): Buffer {
  return crypto
    .createHash('sha256')
    .update(`masivos-session-v1:${adminToken}`)
    .digest();
}

export function createSessionCookieValue(adminToken: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS;
  const payloadB64 = Buffer.from(JSON.stringify({ exp }), 'utf8').toString('base64url');
  const sigHex = crypto
    .createHmac('sha256', getCookieSigningKey(adminToken))
    .update(payloadB64)
    .digest('hex');
  return `${payloadB64}.${sigHex}`;
}

export function verifySessionCookieValue(
  cookieVal: string | undefined,
  adminToken: string,
  nowMs = Date.now()
): boolean {
  if (!cookieVal || !adminToken) return false;
  const dotIdx = cookieVal.indexOf('.');
  if (dotIdx <= 0) return false;

  const payloadB64 = cookieVal.slice(0, dotIdx);
  const sigHex = cookieVal.slice(dotIdx + 1);
  if (!payloadB64 || !sigHex) return false;

  const expectedSig = crypto
    .createHmac('sha256', getCookieSigningKey(adminToken))
    .update(payloadB64)
    .digest('hex');

  const sigBuf = Buffer.from(sigHex, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return false;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof parsed.exp === 'number' && parsed.exp > Math.floor(nowMs / 1000);
  } catch {
    return false;
  }
}

export function isRequestAuthenticated(
  headers: Record<string, string | string[] | undefined>,
  adminToken: string
): boolean {
  if (!adminToken) return true;

  const headerToken = headers['x-admin-token'];
  const authHeader = headers.authorization;
  let provided = '';

  if (typeof headerToken === 'string') {
    provided = headerToken;
  } else if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    provided = authHeader.slice(7).trim();
  }

  if (provided && constantTimeEquals(adminToken, provided)) {
    return true;
  }

  const rawCookie = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
  const cookies = parseCookies(rawCookie);
  return verifySessionCookieValue(cookies[SESSION_COOKIE_NAME], adminToken);
}

const loginSchema = z.object({
  password: z.string().min(1, 'Ingresa la clave de acceso.').optional(),
  token: z.string().min(1).optional(),
});

export function createAuthRoutes(config: AppConfig): FastifyPluginAsync {
  const attemptsByIp = new Map<string, { count: number; resetAt: number }>();

  return async (fastify) => {
    fastify.get('/api/auth/status', async (req) => {
      const authRequired = Boolean(config.adminApiToken);
      const authenticated = isRequestAuthenticated(req.headers, config.adminApiToken);
      return { authRequired, authenticated };
    });

    fastify.post('/api/auth/login', async (req, reply) => {
      if (!config.adminApiToken) {
        return { ok: true, authRequired: false, authenticated: true };
      }

      const ip = req.ip || 'unknown';
      const now = Date.now();
      const entry = attemptsByIp.get(ip);
      if (entry && entry.resetAt > now && entry.count >= MAX_LOGIN_ATTEMPTS) {
        return reply.status(429).send({
          ok: false,
          error: 'Demasiados intentos fallidos. Espera 1 minuto e intenta nuevamente.',
        });
      }

      const parsed = loginSchema.safeParse(req.body);
      const candidate = parsed.success
        ? parsed.data.password ?? parsed.data.token ?? ''
        : '';

      if (!candidate || !constantTimeEquals(config.adminApiToken, candidate)) {
        const nextCount = entry && entry.resetAt > now ? entry.count + 1 : 1;
        attemptsByIp.set(ip, {
          count: nextCount,
          resetAt: entry && entry.resetAt > now ? entry.resetAt : now + LOGIN_WINDOW_MS,
        });
        return reply.status(401).send({
          ok: false,
          error: 'Clave incorrecta.',
        });
      }

      attemptsByIp.delete(ip);
      const cookieVal = createSessionCookieValue(config.adminApiToken, now);
      reply.header(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`
      );
      return { ok: true, authRequired: true, authenticated: true };
    });

    fastify.post('/api/auth/logout', async (_req, reply) => {
      reply.header(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      );
      return { ok: true };
    });
  };
}
