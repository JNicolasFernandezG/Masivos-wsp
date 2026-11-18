export interface WahaSessionInfo {
  name: string;
  status: string;
  engine?: string;
  me?: { id?: string; pushName?: string } | null;
  raw?: unknown;
}

export interface WahaQrResponse {
  mimetype: string;
  data: string;
}

export interface WahaSendTextResult {
  id: string | null;
  raw: unknown;
}

export interface WahaClient {
  getSession(session: string): Promise<WahaSessionInfo | null>;
  startSession(session: string): Promise<WahaSessionInfo>;
  stopSession(session: string): Promise<void>;
  restartSession(session: string): Promise<void>;
  logoutSession(session: string): Promise<void>;
  getQrCode(session: string): Promise<WahaQrResponse>;
  requestPairingCode(session: string, phoneNumber: string): Promise<{ code: string }>;
  sendText(session: string, chatId: string, text: string): Promise<WahaSendTextResult>;
  resolveLidToPhone(session: string, lid: string): Promise<{ lid: string; pn: string | null } | null>;
  ping(): Promise<boolean>;
}

export class WahaApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = 'WahaApiError';
  }
}

export class HttpWahaClient implements WahaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = 15000
  ) {}

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...extra,
    };
    if (this.apiKey) {
      headers['X-Api-Key'] = this.apiKey;
    }
    return headers;
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.buildHeaders(
        body !== undefined ? { 'Content-Type': 'application/json' } : undefined
      ),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new WahaApiError(
        `WAHA ${method} ${path} respondió ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        text
      );
    }

    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  private parseSession(raw: Record<string, unknown>, fallbackName: string): WahaSessionInfo {
    const engineObj = raw.engine as Record<string, unknown> | string | undefined;
    const engineName =
      typeof engineObj === 'string'
        ? engineObj
        : typeof engineObj?.engine === 'string'
          ? engineObj.engine
          : undefined;
    const meRaw = raw.me as { id?: string; pushName?: string } | null | undefined;
    return {
      name: typeof raw.name === 'string' ? raw.name : fallbackName,
      status: typeof raw.status === 'string' ? raw.status : 'UNKNOWN',
      engine: engineName,
      me: meRaw ?? null,
      raw,
    };
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(4000),
      });
      return res.ok || res.status === 401;
    } catch {
      return false;
    }
  }

  async getSession(session: string): Promise<WahaSessionInfo | null> {
    try {
      const data = await this.requestJson<Record<string, unknown>>(
        'GET',
        `/api/sessions/${encodeURIComponent(session)}`
      );
      return this.parseSession(data, session);
    } catch (err) {
      if (err instanceof WahaApiError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async startSession(session: string): Promise<WahaSessionInfo> {
    try {
      const data = await this.requestJson<Record<string, unknown>>(
        'POST',
        `/api/sessions/${encodeURIComponent(session)}/start`
      );
      return this.parseSession(data ?? {}, session);
    } catch (err) {
      if (err instanceof WahaApiError && err.statusCode === 404) {
        const created = await this.requestJson<Record<string, unknown>>(
          'POST',
          '/api/sessions',
          { name: session, start: true }
        );
        return this.parseSession(created ?? {}, session);
      }
      if (err instanceof WahaApiError && err.statusCode === 422) {
        const existing = await this.getSession(session);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async stopSession(session: string): Promise<void> {
    await this.requestJson('POST', `/api/sessions/${encodeURIComponent(session)}/stop`);
  }

  async restartSession(session: string): Promise<void> {
    await this.requestJson('POST', `/api/sessions/${encodeURIComponent(session)}/restart`);
  }

  async logoutSession(session: string): Promise<void> {
    await this.requestJson('POST', `/api/sessions/${encodeURIComponent(session)}/logout`);
  }

  async getQrCode(session: string): Promise<WahaQrResponse> {
    const res = await fetch(
      `${this.baseUrl}/api/${encodeURIComponent(session)}/auth/qr`,
      {
        method: 'GET',
        headers: this.buildHeaders({ Accept: 'application/json' }),
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new WahaApiError(
        `No se pudo obtener el QR (${res.status}): ${text.slice(0, 300)}`,
        res.status,
        text
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const json = (await res.json()) as { mimetype?: string; data?: string };
      if (!json.data) {
        throw new WahaApiError('WAHA devolvió un JSON sin datos de QR.', 502);
      }
      return {
        mimetype: json.mimetype ?? 'image/png',
        data: json.data,
      };
    }

    const arrayBuf = await res.arrayBuffer();
    return {
      mimetype: contentType.split(';')[0] || 'image/png',
      data: Buffer.from(arrayBuf).toString('base64'),
    };
  }

  async requestPairingCode(
    session: string,
    phoneNumber: string
  ): Promise<{ code: string }> {
    const digits = phoneNumber.replace(/\D/g, '');
    const data = await this.requestJson<{ code?: string }>(
      'POST',
      `/api/${encodeURIComponent(session)}/auth/request-code`,
      { phoneNumber: digits }
    );
    return { code: data?.code ?? '' };
  }

  async sendText(
    session: string,
    chatId: string,
    text: string
  ): Promise<WahaSendTextResult> {
    const data = await this.requestJson<Record<string, unknown>>(
      'POST',
      '/api/sendText',
      { session, chatId, text }
    );

    const idField =
      typeof data?.id === 'string'
        ? data.id
        : typeof (data?.id as Record<string, unknown> | undefined)?._serialized === 'string'
          ? String((data?.id as Record<string, unknown>)._serialized)
          : null;

    return {
      id: idField,
      raw: data,
    };
  }

  async resolveLidToPhone(
    session: string,
    lid: string
  ): Promise<{ lid: string; pn: string | null } | null> {
    try {
      const data = await this.requestJson<{ lid?: string; pn?: string | null }>(
        'GET',
        `/api/${encodeURIComponent(session)}/lids/${encodeURIComponent(lid)}`
      );
      if (!data) return null;
      return {
        lid: data.lid ?? lid,
        pn: data.pn ?? null,
      };
    } catch (err) {
      if (err instanceof WahaApiError && (err.statusCode === 404 || err.statusCode === 400)) {
        return null;
      }
      return null;
    }
  }
}
