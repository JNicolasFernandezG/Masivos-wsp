import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  checkBusinessHours,
  getStartOfLocalDayUtc,
} from '../src/services/businessHours.js';

function makeConfig() {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    TZ: 'America/Argentina/Buenos_Aires',
    BUSINESS_HOURS_ENABLED: 'true',
    BUSINESS_HOURS_START: '09:00',
    BUSINESS_HOURS_END: '19:00',
    BUSINESS_ALLOWED_DAYS: '1,2,3,4,5,6',
  });
}

describe('businessHours', () => {
  it('permite envíos dentro del horario comercial (09:00 a 18:59 ART) y los prohíbe fuera', () => {
    const config = makeConfig();

    // Jueves 2026-11-19 08:59 ART = 11:59 UTC
    const beforeOpen = checkBusinessHours(new Date('2026-11-19T11:59:00Z'), config);
    expect(beforeOpen.allowed).toBe(false);
    expect(beforeOpen.reason).toBe('OUTSIDE_HOURS');
    expect(beforeOpen.nextWindowStart?.toISOString()).toBe('2026-11-19T12:00:00.000Z');

    // Jueves 2026-11-19 09:00 ART = 12:00 UTC
    const atOpen = checkBusinessHours(new Date('2026-11-19T12:00:00Z'), config);
    expect(atOpen.allowed).toBe(true);

    // Jueves 2026-11-19 18:59 ART = 21:59 UTC
    const beforeClose = checkBusinessHours(new Date('2026-11-19T21:59:00Z'), config);
    expect(beforeClose.allowed).toBe(true);

    // Jueves 2026-11-19 19:00 ART = 22:00 UTC (prohibido)
    const atClose = checkBusinessHours(new Date('2026-11-19T22:00:00Z'), config);
    expect(atClose.allowed).toBe(false);
    expect(atClose.reason).toBe('OUTSIDE_HOURS');
    expect(atClose.nextWindowStart?.toISOString()).toBe('2026-11-20T12:00:00.000Z');
  });

  it('salta domingos al calcular la próxima ventana comercial y calcula inicio del día local', () => {
    const config = makeConfig();

    // Domingo 2026-11-22 14:00 ART = 17:00 UTC -> próximo día permitido Lunes 2026-11-23 09:00 ART (12:00 UTC)
    const sunday = checkBusinessHours(new Date('2026-11-22T17:00:00Z'), config);
    expect(sunday.allowed).toBe(false);
    expect(sunday.reason).toBe('NON_BUSINESS_DAY');
    expect(sunday.nextWindowStart?.toISOString()).toBe('2026-11-23T12:00:00.000Z');

    const startOfDay = getStartOfLocalDayUtc(
      new Date('2026-11-19T15:30:00Z'),
      'America/Argentina/Buenos_Aires'
    );
    expect(startOfDay.toISOString()).toBe('2026-11-19T03:00:00.000Z');
  });
});
