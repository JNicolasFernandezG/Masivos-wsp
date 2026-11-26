export type JidKind = 'user' | 'group' | 'lid' | 'broadcast' | 'unknown';

export interface NormalizedIncomingJid {
  chatId: string;
  rawChatId: string;
  kind: JidKind;
  phoneNumber: string | null;
}

export type OutboundRecipientResult =
  | {
      ok: true;
      chatId: string;
      phoneNormalized: string | null;
      kind: 'user' | 'group' | 'lid';
      warning?: string;
    }
  | {
      ok: false;
      error: string;
    };

/**
 * Normalizes WhatsApp JIDs received from WAHA (especially GOWS, which may emit
 * `@s.whatsapp.net`, device suffixes like `:0`, or `@lid`).
 */
export function normalizeIncomingJid(rawInput: string): NormalizedIncomingJid {
  const rawChatId = rawInput.trim();
  if (!rawChatId) {
    return { chatId: '', rawChatId: '', kind: 'unknown', phoneNumber: null };
  }

  if (rawChatId === 'status@broadcast' || rawChatId.endsWith('@broadcast')) {
    return {
      chatId: rawChatId,
      rawChatId,
      kind: 'broadcast',
      phoneNumber: null,
    };
  }

  const userMatch = rawChatId.match(/^([^:@]+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i);
  if (userMatch) {
    const digits = userMatch[1].replace(/\D/g, '');
    if (digits.length > 0) {
      return {
        chatId: `${digits}@c.us`,
        rawChatId,
        kind: 'user',
        phoneNumber: digits,
      };
    }
    return {
      chatId: `${userMatch[1]}@c.us`,
      rawChatId,
      kind: 'user',
      phoneNumber: null,
    };
  }

  const lidMatch = rawChatId.match(/^([^:@]+)(?::\d+)?@lid$/i);
  if (lidMatch) {
    return {
      chatId: `${lidMatch[1]}@lid`,
      rawChatId,
      kind: 'lid',
      phoneNumber: null,
    };
  }

  const groupMatch = rawChatId.match(/^([^@]+)@g\.us$/i);
  if (groupMatch) {
    return {
      chatId: `${groupMatch[1]}@g.us`,
      rawChatId,
      kind: 'group',
      phoneNumber: null,
    };
  }

  return {
    chatId: rawChatId,
    rawChatId,
    kind: 'unknown',
    phoneNumber: null,
  };
}

function stripArgentinaMobile15(twelveDigits: string): {
  tenDigits: string;
  warning?: string;
} | null {
  // 2-digit area code (11) + 15 + 8-digit subscriber
  const amba15 = twelveDigits.match(/^(11)15(\d{8})$/);
  if (amba15) {
    return { tenDigits: `${amba15[1]}${amba15[2]}` };
  }

  // Typo seen in operator sheets: 011 + duplicated 11 + 8-digit subscriber (e.g. 0111140577277)
  const ambaDup11 = twelveDigits.match(/^(11)11(\d{8})$/);
  if (ambaDup11) {
    return {
      tenDigits: `${ambaDup11[1]}${ambaDup11[2]}`,
      warning: 'Se corrigió prefijo 01111 duplicado → 54911.',
    };
  }

  // 3-digit area code (2xx/3xx) + 15 + 7-digit subscriber
  const area3 = twelveDigits.match(/^([23]\d{2})15(\d{7})$/);
  if (area3) {
    return { tenDigits: `${area3[1]}${area3[2]}` };
  }

  // 4-digit area code (2xxx/3xxx) + 15 + 6-digit subscriber
  const area4 = twelveDigits.match(/^([23]\d{3})15(\d{6})$/);
  if (area4) {
    return { tenDigits: `${area4[1]}${area4[2]}` };
  }

  return null;
}

function normalizeArgentinaDigits(
  rawTrimmed: string,
  digits: string
): OutboundRecipientResult {
  const explicitlyInternational = rawTrimmed.startsWith('+');

  if (digits.startsWith('549')) {
    if (digits.length === 13) {
      return {
        ok: true,
        chatId: `${digits}@c.us`,
        phoneNormalized: digits,
        kind: 'user',
      };
    }
    if (digits.length === 15) {
      const stripped = stripArgentinaMobile15(digits.slice(3));
      if (stripped) {
        const finalDigits = `549${stripped.tenDigits}`;
        return {
          ok: true,
          chatId: `${finalDigits}@c.us`,
          phoneNormalized: finalDigits,
          kind: 'user',
          warning: stripped.warning ?? 'Se quitó el 15 interno tras 549.',
        };
      }
    }
    return {
      ok: false,
      error: `Número "${rawTrimmed}" con prefijo 549 tiene longitud inválida (${digits.length} dígitos; se esperan 13).`,
    };
  }

  if (digits.startsWith('54') && !digits.startsWith('549')) {
    const rest = digits.slice(2);
    if (rest.length === 10) {
      const finalDigits = `549${rest}`;
      return {
        ok: true,
        chatId: `${finalDigits}@c.us`,
        phoneNormalized: finalDigits,
        kind: 'user',
        warning: 'Se insertó 9 móvil tras código 54.',
      };
    }
    if (rest.length === 12) {
      const stripped = stripArgentinaMobile15(rest);
      if (stripped) {
        const finalDigits = `549${stripped.tenDigits}`;
        return {
          ok: true,
          chatId: `${finalDigits}@c.us`,
          phoneNormalized: finalDigits,
          kind: 'user',
          warning: stripped.warning ?? 'Se normalizó 54 + 15 → 549.',
        };
      }
    }
  }

  const startedWithZero = digits.startsWith('0');
  const local = digits.replace(/^0+/, '');

  if (local.length === 10) {
    if (local.startsWith('15')) {
      const finalDigits = `54911${local.slice(2)}`;
      return {
        ok: true,
        chatId: `${finalDigits}@c.us`,
        phoneNormalized: finalDigits,
        kind: 'user',
        warning: 'Número sin código de área (15...); se asumió área 11.',
      };
    }
    const finalDigits = `549${local}`;
    return {
      ok: true,
      chatId: `${finalDigits}@c.us`,
      phoneNormalized: finalDigits,
      kind: 'user',
    };
  }

  if (local.length === 11) {
    // Typo: 111 + 8-digit AMBA subscriber (e.g. 11126861937 or 011126861937 -> 5491126861937)
    const ambaExtra1 = local.match(/^111(\d{8})$/);
    if (ambaExtra1) {
      const finalDigits = `54911${ambaExtra1[1]}`;
      return {
        ok: true,
        chatId: `${finalDigits}@c.us`,
        phoneNormalized: finalDigits,
        kind: 'user',
        warning: 'Se corrigió prefijo 111 duplicado → 54911.',
      };
    }

    // Missing country code 54 before mobile 9 + 10-digit Argentine number (e.g. 911..., 9223...)
    const missing54 = local.match(/^9((?:11|[23]\d)\d{8})$/);
    if (missing54) {
      const finalDigits = `549${missing54[1]}`;
      return {
        ok: true,
        chatId: `${finalDigits}@c.us`,
        phoneNormalized: finalDigits,
        kind: 'user',
        warning: 'Se agregó código país 54 al prefijo móvil 9.',
      };
    }
  }

  if (local.length === 12) {
    const stripped = stripArgentinaMobile15(local);
    if (stripped) {
      const finalDigits = `549${stripped.tenDigits}`;
      return {
        ok: true,
        chatId: `${finalDigits}@c.us`,
        phoneNormalized: finalDigits,
        kind: 'user',
        warning: stripped.warning,
      };
    }
  }

  // Allow explicit international E.164 numbers (e.g. +5511999998888, 56912345678).
  // Exclude malformed Argentine prefixes starting with 11 or 15 (no E.164 country code starts with 11/15).
  const looksLikeMalformedArPrefix = !explicitlyInternational && /^(11|15)/.test(digits);
  if (
    !startedWithZero &&
    !looksLikeMalformedArPrefix &&
    (explicitlyInternational || (digits.length >= 11 && digits.length <= 15))
  ) {
    return {
      ok: true,
      chatId: `${digits}@c.us`,
      phoneNormalized: digits,
      kind: 'user',
    };
  }

  return {
    ok: false,
    error: `Número "${rawTrimmed}" inválido o incompleto para Argentina (${digits.length} dígitos).`,
  };
}

/**
 * Normalizes user-provided phone numbers or JIDs into WAHA `chatId` strings.
 */
export function normalizeOutboundRecipient(
  rawInput: string,
  defaultCountryCode = ''
): OutboundRecipientResult {
  const trimmed = rawInput.trim().replace(/^tel:/i, '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Destinatario vacío.' };
  }

  if (trimmed.includes('@')) {
    const parsed = normalizeIncomingJid(trimmed);
    if (parsed.kind === 'group') {
      return {
        ok: true,
        chatId: parsed.chatId,
        phoneNormalized: null,
        kind: 'group',
      };
    }
    if (parsed.kind === 'lid') {
      return {
        ok: true,
        chatId: parsed.chatId,
        phoneNormalized: null,
        kind: 'lid',
      };
    }
    if (parsed.kind === 'user' && parsed.phoneNumber) {
      if (parsed.phoneNumber.length < 8 || parsed.phoneNumber.length > 15) {
        return {
          ok: false,
          error: `Longitud de teléfono inválida (${parsed.phoneNumber.length} dígitos).`,
        };
      }
      return {
        ok: true,
        chatId: parsed.chatId,
        phoneNormalized: parsed.phoneNumber,
        kind: 'user',
      };
    }
    return { ok: false, error: `JID no soportado: ${trimmed}` };
  }

  let digits = trimmed.replace(/\D/g, '');
  if (!digits) {
    return { ok: false, error: `Número sin dígitos válidos: ${trimmed}` };
  }

  const cc = defaultCountryCode.replace(/\D/g, '');
  if (cc === '549' || cc === '54') {
    return normalizeArgentinaDigits(trimmed, digits);
  }

  if (cc && !digits.startsWith(cc)) {
    const withoutLeadingZero = digits.replace(/^0+/, '');
    if (withoutLeadingZero.length >= 7 && withoutLeadingZero.length <= 10) {
      digits = `${cc}${withoutLeadingZero}`;
    }
  }

  if (digits.length < 8 || digits.length > 15) {
    return {
      ok: false,
      error: `Número "${trimmed}" normalizado a ${digits.length} dígitos (se esperan 8–15 con código de país).`,
    };
  }

  return {
    ok: true,
    chatId: `${digits}@c.us`,
    phoneNormalized: digits,
    kind: 'user',
  };
}
