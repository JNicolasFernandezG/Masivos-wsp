import { describe, expect, it } from 'vitest';
import {
  analyzeMessageVariety,
  extractTemplateVariables,
  renderTemplate,
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
});
