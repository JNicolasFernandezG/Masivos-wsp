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

/**
 * Normalizes user-provided phone numbers or JIDs into WAHA `chatId` strings.
 */
export function normalizeOutboundRecipient(
  rawInput: string,
  defaultCountryCode = ''
): OutboundRecipientResult {
  const trimmed = rawInput.trim();
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
