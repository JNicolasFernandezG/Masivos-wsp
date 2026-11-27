import { describe, expect, it } from 'vitest';
import {
  analyzeMessageVariety,
  extractTemplateVariables,
  pickRandomTemplateVariant,
  renderTemplate,
  splitTemplateVariants,
} from '../src/services/templateRenderer.js';

describe('templateRenderer', () => {
  it('extrae variables y renderiza sin distinguir mayúsculas/minúsculas', () => {
    const tpl = 'Hola {{ nombre }}, gestión {{nro_gestion}} por {{ MONTO }}.';
    expect(extractTemplateVariables(tpl)).toEqual(['nombre', 'nro_gestion', 'MONTO']);

    const rendered = renderTemplate(tpl, {
      Nombre: 'Ana',
      nro_gestion: 'G-100',
      monto: '$ 45.000',
    });

    expect(rendered).toEqual({
      renderedText: 'Hola Ana, gestión G-100 por $ 45.000.',
      missingKeys: [],
    });
  });

  it('reporta variables faltantes sin romper el texto', () => {
    const rendered = renderTemplate('Hola {{nombre}}, fecha {{fecha}}', {
      nombre: 'Luis',
    });
    expect(rendered.renderedText).toBe('Hola Luis, fecha');
    expect(rendered.missingKeys).toEqual(['fecha']);
  });

  it('detecta si todos los mensajes de un lote son idénticos', () => {
    expect(analyzeMessageVariety(['Hola', 'Hola']).allIdentical).toBe(true);
    expect(analyzeMessageVariety(['Hola Ana', 'Hola Luis']).allIdentical).toBe(false);
    expect(analyzeMessageVariety(['Único']).allIdentical).toBe(false);
  });

  it('divide variantes por --- y alterna aleatoriamente sin repetir la variante inmediatamente anterior', () => {
    const raw = 'Variante 1 {{nombre}}\n---\nVariante 2 {{apellido}}\n  ---  \nVariante 3 {{documento}}';
    const variants = splitTemplateVariants(raw);
    expect(variants).toEqual([
      'Variante 1 {{nombre}}',
      'Variante 2 {{apellido}}',
      'Variante 3 {{documento}}',
    ]);

    let lastIdx: number | null = null;
    for (let i = 0; i < 20; i += 1) {
      const picked = pickRandomTemplateVariant(variants, lastIdx);
      expect(picked.index).not.toBe(lastIdx);
      expect(variants).toContain(picked.variant);
      lastIdx = picked.index;
    }
  });
});
