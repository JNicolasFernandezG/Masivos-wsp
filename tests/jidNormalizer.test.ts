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

  it('normaliza teléfonos salientes genéricos y respeta longitudes E.164 (8–15)', () => {
    expect(normalizeOutboundRecipient('+54 9 11 1234-5678')).toEqual({
      ok: true,
      chatId: '5491112345678@c.us',
      phoneNormalized: '5491112345678',
      kind: 'user',
    });

    expect(normalizeOutboundRecipient('01144045549', '549')).toEqual({
      ok: true,
      chatId: '5491144045549@c.us',
      phoneNormalized: '5491144045549',
      kind: 'user',
    });

    // Número internacional de otro país con código de país
    expect(normalizeOutboundRecipient('5511999998888', '549')).toEqual({
      ok: true,
      chatId: '5511999998888@c.us',
      phoneNormalized: '5511999998888',
      kind: 'user',
    });

    expect(normalizeOutboundRecipient('12345').ok).toBe(false);
    expect(normalizeOutboundRecipient('0114404', '549').ok).toBe(false);
    expect(normalizeOutboundRecipient('').ok).toBe(false);
  });

  it('normaliza correctamente la lista real de teléfonos argentinos con tel:, 0 y 15', () => {
    const cases: Array<[string, string]> = [
      ['tel:0239615545631', '5492396545631@c.us'],
      ['tel:03364455357', '5493364455357@c.us'],
      ['tel:01144045549', '5491144045549@c.us'],
      ['tel:0239615575727', '5492396575727@c.us'],
      ['tel:01139563183', '5491139563183@c.us'],
      ['tel:01151443664', '5491151443664@c.us'],
      ['tel:01144208938', '5491144208938@c.us'],
      ['tel:01150388681', '5491150388681@c.us'],
      ['tel:02923408879', '5492923408879@c.us'],
      ['tel:02494646192', '5492494646192@c.us'],
      ['tel:0111140577277', '5491140577277@c.us'],
      ['tel:0225415530567', '5492254530567@c.us'],
      ['tel:01159290311', '5491159290311@c.us'],
      ['tel:01136832822', '5491136832822@c.us'],
      ['tel:0228415233434', '5492284233434@c.us'],
      ['tel:02922412579', '5492922412579@c.us'],
      ['tel:02212200119', '5492212200119@c.us'],
      ['tel:01158880271', '5491158880271@c.us'],
      ['tel:03329301598', '5493329301598@c.us'],
      ['tel:0228415567935', '5492284567935@c.us'],
      ['tel:0111578310281', '5491178310281@c.us'],
      ['tel:01132848359', '5491132848359@c.us'],
      ['tel:02284301320', '5492284301320@c.us'],
      ['tel:02914132067', '5492914132067@c.us'],
      ['tel:01161104490', '5491161104490@c.us'],
      ['tel:0221155663551', '5492215663551@c.us'],
      ['tel:01161064587', '5491161064587@c.us'],
      ['tel:0232315616213', '5492323616213@c.us'],
    ];

    for (const [input, expected] of cases) {
      const res = normalizeOutboundRecipient(input, '549');
      expect(res.ok, `Falló ${input}`).toBe(true);
      if (res.ok) {
        expect(res.chatId).toBe(expected);
      }
    }

    const dup11 = normalizeOutboundRecipient('tel:0111140577277', '549');
    expect(dup11.ok && dup11.warning).toContain('01111');
  });

  it('corrige prefijos argentinos de 11 dígitos (111... y 9...) y rechaza 11 dígitos malformados sin 549', () => {
    const extraOne = normalizeOutboundRecipient('11126861937', '549');
    expect(extraOne).toEqual({
      ok: true,
      chatId: '5491126861937@c.us',
      phoneNormalized: '5491126861937',
      kind: 'user',
      warning: 'Se corrigió prefijo 111 duplicado → 54911.',
    });

    const extraOneZero = normalizeOutboundRecipient('011126861937', '549');
    expect(extraOneZero.ok && extraOneZero.chatId).toBe('5491126861937@c.us');

    const missing54Amba = normalizeOutboundRecipient('91144045549', '549');
    expect(missing54Amba.ok && missing54Amba.chatId).toBe('5491144045549@c.us');

    const missing54Interior = normalizeOutboundRecipient('92234810757', '549');
    expect(missing54Interior.ok && missing54Interior.chatId).toBe('5492234810757@c.us');

    // 11 dígitos empezando con 11 que no son 111... no debe pasar como internacional sin 549
    expect(normalizeOutboundRecipient('11226861937', '549').ok).toBe(false);
  });
});
