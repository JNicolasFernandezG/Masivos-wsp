import crypto from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';

export const SESSION_COOKIE_NAME = 'masivos_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 horas
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 30;

export interface SsoTokenPayload {
  sub: string;
  jti: string;
  exp: number;
  iat?: number;
  nbf?: number;
  iss?: string;
}

export type SsoVerifyResult =
  | { ok: true; payload: SsoTokenPayload }
  | { ok: false; code: 'invalid' | 'expired'; error: string };

function isHttpsRequest(headers: Record<string, string | string[] | undefined>, protocol: string): boolean {
  if (protocol === 'https') return true;
  const xfp = headers['x-forwarded-proto'];
  const val = Array.isArray(xfp) ? xfp[0] : xfp;
  return typeof val === 'string' && val.split(',')[0].trim().toLowerCase() === 'https';
}

function wantsJsonResponse(acceptHeader: string | string[] | undefined): boolean {
  const accept = Array.isArray(acceptHeader) ? acceptHeader[0] : acceptHeader ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

export function createSsoToken(
  input: {
    sub: string;
    jti?: string;
    iss?: string;
    iat?: number;
    exp?: number;
  },
  secret: string,
  ttlSeconds = 60,
  nowMs = Date.now()
): string {
  const nowSec = Math.floor(nowMs / 1000);
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
    'base64url'
  );
  const payload: SsoTokenPayload = {
    sub: input.sub,
    jti: input.jti ?? crypto.randomUUID(),
    iat: input.iat ?? nowSec,
    exp: input.exp ?? nowSec + ttlSeconds,
    ...(input.iss ? { iss: input.iss } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${signingInput}.${sigB64}`;
}

export function verifySsoToken(
  token: string,
  options: {
    secret: string;
    maxTtlSeconds: number;
    allowedIssuer?: string;
    nowMs?: number;
  }
): SsoVerifyResult {
  if (!token || !options.secret) {
    return { ok: false, code: 'invalid', error: 'Token SSO faltante o secreto no configurado.' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { ok: false, code: 'invalid', error: 'Formato de token SSO inválido (se espera JWT).' };
  }

  const [headerB64, payloadB64, sigB64] = parts;
  if (!headerB64 || !payloadB64 || !sigB64) {
    return { ok: false, code: 'invalid', error: 'Token SSO malformado.' };
  }

  let header: { alg?: unknown; typ?: unknown };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
      alg?: unknown;
      typ?: unknown;
    };
  } catch {
    return { ok: false, code: 'invalid', error: 'Cabecera de token SSO inválida.' };
  }

  if (header.alg !== 'HS256') {
    return { ok: false, code: 'invalid', error: 'Algoritmo JWT no permitido (solo HS256).' };
  }

  const expectedSigB64 = crypto
    .createHmac('sha256', options.secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuf = Buffer.from(sigB64, 'utf8');
  const expectedBuf = Buffer.from(expectedSigB64, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, code: 'invalid', error: 'Firma del token SSO inválida.' };
  }

  let rawPayload: Record<string, unknown>;
  try {
    rawPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'invalid', error: 'Payload del token SSO inválido.' };
  }

  const sub = typeof rawPayload.sub === 'string' ? rawPayload.sub.trim() : '';
  const jti = typeof rawPayload.jti === 'string' ? rawPayload.jti.trim() : '';
  const exp = typeof rawPayload.exp === 'number' && Number.isFinite(rawPayload.exp) ? rawPayload.exp : NaN;
  const iat =
    rawPayload.iat === undefined
      ? undefined
      : typeof rawPayload.iat === 'number' && Number.isFinite(rawPayload.iat)
        ? rawPayload.iat
        : NaN;
  const nbf =
    rawPayload.nbf === undefined
      ? undefined
      : typeof rawPayload.nbf === 'number' && Number.isFinite(rawPayload.nbf)
        ? rawPayload.nbf
        : NaN;
  const iss = typeof rawPayload.iss === 'string' ? rawPayload.iss.trim() : undefined;

  if (!sub || sub.length > 200) {
    return { ok: false, code: 'invalid', error: 'El token SSO debe incluir un "sub" válido.' };
  }
  if (!jti || jti.length > 128) {
    return { ok: false, code: 'invalid', error: 'El token SSO debe incluir un "jti" único.' };
  }
  if (!Number.isFinite(exp)) {
    return { ok: false, code: 'invalid', error: 'El token SSO debe incluir "exp".' };
  }
  if (iat !== undefined && !Number.isFinite(iat)) {
    return { ok: false, code: 'invalid', error: 'El campo "iat" del token SSO es inválido.' };
  }
  if (nbf !== undefined && !Number.isFinite(nbf)) {
    return { ok: false, code: 'invalid', error: 'El campo "nbf" del token SSO es inválido.' };
  }

  if (options.allowedIssuer && iss !== options.allowedIssuer) {
    return { ok: false, code: 'invalid', error: 'Emisor (iss) del token SSO no autorizado.' };
  }

  const nowSec = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (exp <= nowSec) {
    return { ok: false, code: 'expired', error: 'El token SSO ha expirado.' };
  }
  if (exp - nowSec > options.maxTtlSeconds) {
    return {
      ok: false,
      code: 'invalid',
      error: `La vigencia del token SSO excede el máximo permitido (${options.maxTtlSeconds}s).`,
    };
  }
  if (iat !== undefined && iat > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'invalid', error: 'El token SSO tiene fecha de emisión futura.' };
  }
  if (nbf !== undefined && nbf > nowSec + CLOCK_SKEW_SECONDS) {
    return { ok: false, code: 'invalid', error: 'El token SSO aún no es válido (nbf).' };
  }

  return {
    ok: true,
    payload: {
      sub,
      jti,
      exp,
      ...(iat !== undefined ? { iat } : {}),
      ...(nbf !== undefined ? { nbf } : {}),
      ...(iss ? { iss } : {}),
    },
  };
}

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

export function createAuthRoutes(config: AppConfig, db?: SqliteDb): FastifyPluginAsync {
  const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
  const usedJtisMemory = new Map<string, number>();

  const consumeJti = (jti: string, expiresAtSec: number, nowSec: number): boolean => {
    if (db) {
      db.prepare('DELETE FROM sso_used_jtis WHERE expires_at <= ?').run(nowSec);
      const res = db
        .prepare('INSERT OR IGNORE INTO sso_used_jtis (jti, expires_at) VALUES (?, ?)')
        .run(jti, expiresAtSec);
      return Number(res.changes) > 0;
    }

    for (const [k, exp] of usedJtisMemory) {
      if (exp <= nowSec) usedJtisMemory.delete(k);
    }
    if (usedJtisMemory.has(jti)) {
      return false;
    }
    usedJtisMemory.set(jti, expiresAtSec);
    return true;
  };

  const setSessionCookie = (req: FastifyRequest, reply: FastifyReply, nowMs: number) => {
    if (!config.adminApiToken) return;
    const cookieVal = createSessionCookieValue(config.adminApiToken, nowMs);
    const secureFlag = isHttpsRequest(req.headers, req.protocol) ? '; Secure' : '';
    reply.header(
      'Set-Cookie',
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(cookieVal)}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=${SESSION_TTL_SECONDS}`
    );
  };

  const handleSsoRequest = async (
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    isPost: boolean
  ) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Referrer-Policy', 'no-referrer');

    const preferJson = wantsJsonResponse(req.headers.accept);
    const fail = (statusCode: number, code: string, error: string) => {
      if (preferJson) {
        return reply.status(statusCode).send({ ok: false, code, error });
      }
      return reply.redirect(`/?sso_error=${encodeURIComponent(code)}`, 302);
    };

    if (!config.ssoSecret) {
      return fail(503, 'disabled', 'El acceso SSO no está habilitado en este servidor.');
    }

    const ip = req.ip || 'unknown';
    const now = Date.now();
    for (const [k, v] of attemptsByIp) {
      if (v.resetAt <= now) attemptsByIp.delete(k);
    }
    const entry = attemptsByIp.get(ip);
    if (entry && entry.resetAt > now && entry.count >= MAX_LOGIN_ATTEMPTS) {
      return fail(
        429,
        'rate_limited',
        'Demasiados intentos SSO fallidos. Espera unos minutos e intenta nuevamente.'
      );
    }

    const recordFailure = () => {
      const nextCount = entry && entry.resetAt > now ? entry.count + 1 : 1;
      attemptsByIp.set(ip, {
        count: nextCount,
        resetAt: entry && entry.resetAt > now ? entry.resetAt : now + LOGIN_WINDOW_MS,
      });
    };

    const verified = verifySsoToken(token, {
      secret: config.ssoSecret,
      maxTtlSeconds: config.ssoMaxTtlSeconds,
      allowedIssuer: config.ssoAllowedIssuer || undefined,
      nowMs: now,
    });

    if (!verified.ok) {
      recordFailure();
      return fail(401, verified.code, verified.error);
    }

    const nowSec = Math.floor(now / 1000);
    const fresh = consumeJti(verified.payload.jti, verified.payload.exp, nowSec);
    if (!fresh) {
      recordFailure();
      return fail(401, 'used', 'Este enlace SSO ya fue utilizado. Genera uno nuevo.');
    }

    attemptsByIp.delete(ip);
    setSessionCookie(req, reply, now);
    req.log.info(
      { sub: verified.payload.sub, iss: verified.payload.iss ?? null, jti: verified.payload.jti },
      'Inicio de sesión SSO exitoso'
    );

    if (preferJson) {
      return {
        ok: true,
        authRequired: Boolean(config.adminApiToken),
        authenticated: true,
        user: verified.payload.sub,
      };
    }

    return reply.redirect('/', isPost ? 303 : 302);
  };

  return async (fastify) => {
    fastify.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        try {
          const parsed = Object.fromEntries(new URLSearchParams(String(body)).entries());
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );

    fastify.get('/api/auth/status', async (req) => {
      const authRequired = Boolean(config.adminApiToken);
      const authenticated = isRequestAuthenticated(req.headers, config.adminApiToken);
      return { authRequired, authenticated };
    });

    fastify.get('/api/auth/sso', async (req, reply) => {
      const query = req.query as { token?: unknown };
      const token = typeof query?.token === 'string' ? query.token : '';
      return handleSsoRequest(req, reply, token, false);
    });

    fastify.post('/api/auth/sso', async (req, reply) => {
      const body = (req.body ?? {}) as { token?: unknown };
      const token = typeof body?.token === 'string' ? body.token : '';
      return handleSsoRequest(req, reply, token, true);
    });

    fastify.post('/api/auth/login', async (req, reply) => {
      if (!config.adminApiToken) {
        return { ok: true, authRequired: false, authenticated: true };
      }

      const ip = req.ip || 'unknown';
      const now = Date.now();
      for (const [k, v] of attemptsByIp) {
        if (v.resetAt <= now) attemptsByIp.delete(k);
      }
      const entry = attemptsByIp.get(ip);
      if (entry && entry.resetAt > now && entry.count >= MAX_LOGIN_ATTEMPTS) {
        return reply.status(429).send({
          ok: false,
          error: 'Demasiados intentos fallidos. Espera unos minutos e intenta nuevamente.',
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
      setSessionCookie(req, reply, now);
      return { ok: true, authRequired: true, authenticated: true };
    });

    fastify.post('/api/auth/logout', async (req, reply) => {
      const secureFlag = isHttpsRequest(req.headers, req.protocol) ? '; Secure' : '';
      reply.header(
        'Set-Cookie',
        `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`
      );
      return { ok: true };
    });
  };
}
