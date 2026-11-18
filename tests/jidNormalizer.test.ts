import { describe, expect, it } from 'vitest';
import {
  normalizeIncomingJid,
  normalizeOutboundRecipient,
} from '../src/services/jidNormalizer.js';

describe('jidNormalizer', () => {
  it('normaliza @s.whatsapp.net y sufijos multi-dispositivo de GOWS a @c.us', () => {
    expect(normalizeIncomingJid('5491122334455@s.whatsapp.net')).toEqual({
      chatId: '5491122334455@c.us',
      rawChatId: '5491122334455@s.whatsapp.net',
      kind: 'user',
      phoneNumber: '5491122334455',
    });

    expect(normalizeIncomingJid('5491122334455:12@s.whatsapp.net')).toEqual({
      chatId: '5491122334455@c.us',
      rawChatId: '5491122334455:12@s.whatsapp.net',
      kind: 'user',
      phoneNumber: '5491122334455',
    });
  });

  it('conserva @lid y @g.us limpiando sufijos de dispositivo en @lid', () => {
    expect(normalizeIncomingJid('9988776655:0@lid')).toEqual({
      chatId: '9988776655@lid',
      rawChatId: '9988776655:0@lid',
      kind: 'lid',
      phoneNumber: null,
    });

    expect(normalizeIncomingJid('12036301234567890@g.us')).toEqual({
      chatId: '12036301234567890@g.us',
      rawChatId: '12036301234567890@g.us',
      kind: 'group',
      phoneNumber: null,
    });
  });

  it('normaliza teléfonos salientes y respeta código de país por defecto solo en números locales', () => {
    expect(normalizeOutboundRecipient('+54 9 11 1234-5678')).toEqual({
      ok: true,
      chatId: '5491112345678@c.us',
      phoneNormalized: '5491112345678',
      kind: 'user',
    });

    expect(normalizeOutboundRecipient('011 2233-4455', '549')).toEqual({
      ok: true,
      chatId: '5491122334455@c.us',
      phoneNormalized: '5491122334455',
      kind: 'user',
    });

    // Número ya internacional de otro país (>10 dígitos): no agrega 549
    expect(normalizeOutboundRecipient('5511999998888', '549')).toEqual({
      ok: true,
      chatId: '5511999998888@c.us',
      phoneNormalized: '5511999998888',
      kind: 'user',
    });

    expect(normalizeOutboundRecipient('12345').ok).toBe(false);
    expect(normalizeOutboundRecipient('').ok).toBe(false);
  });
});
