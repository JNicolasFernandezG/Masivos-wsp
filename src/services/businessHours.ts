import type { AppConfig } from '../config.js';

export interface LocalClock {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0=Sun .. 6=Sat
  hour: number;
  minute: number;
  second: number;
  dateKey: string;
}

export interface BusinessHoursCheck {
  allowed: boolean;
  reason: 'OUTSIDE_HOURS' | 'NON_BUSINESS_DAY' | null;
  localClock: LocalClock;
  nextWindowStart: Date | null;
}

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getLocalClock(date: Date, timeZone: string): LocalClock {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '';

  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const rawHour = Number(get('hour'));
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const weekday = WEEKDAY_MAP[get('weekday')] ?? date.getUTCDay();

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');

  return {
    year,
    month,
    day,
    weekday,
    hour,
    minute,
    second,
    dateKey: `${year}-${mm}-${dd}`,
  };
}

export function localWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): Date {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = targetMs;

  for (let i = 0; i < 2; i++) {
    const actual = getLocalClock(new Date(guess), timeZone);
    const actualMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      0
    );
    const diff = actualMs - targetMs;
    if (diff === 0) break;
    guess -= diff;
  }

  return new Date(guess);
}

export function getStartOfLocalDayUtc(date: Date, timeZone: string): Date {
  const clock = getLocalClock(date, timeZone);
  return localWallTimeToUtc(clock.year, clock.month, clock.day, 0, 0, timeZone);
}

function parseHm(hm: string): { hour: number; minute: number; totalMinutes: number } {
  const [hStr, mStr] = hm.split(':');
  const hour = Number(hStr);
  const minute = Number(mStr);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function addCalendarDays(year: number, month: number, day: number, daysToAdd: number): {
  year: number;
  month: number;
  day: number;
} {
  const d = new Date(Date.UTC(year, month - 1, day + daysToAdd, 12, 0, 0));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function checkBusinessHours(date: Date, config: AppConfig): BusinessHoursCheck {
  const clock = getLocalClock(date, config.timezone);

  if (!config.businessHoursEnabled) {
    return {
      allowed: true,
      reason: null,
      localClock: clock,
      nextWindowStart: null,
    };
  }

  const start = parseHm(config.businessHoursStart);
  const end = parseHm(config.businessHoursEnd);
  const currentMinutes = clock.hour * 60 + clock.minute;
  const isAllowedDay = config.businessAllowedDays.includes(clock.weekday);

  if (isAllowedDay && currentMinutes >= start.totalMinutes && currentMinutes < end.totalMinutes) {
    return {
      allowed: true,
      reason: null,
      localClock: clock,
      nextWindowStart: null,
    };
  }

  const reason: 'OUTSIDE_HOURS' | 'NON_BUSINESS_DAY' = isAllowedDay
    ? 'OUTSIDE_HOURS'
    : 'NON_BUSINESS_DAY';

  // Find next valid day/window start
  let offsetDays = 0;
  if (!isAllowedDay || currentMinutes >= end.totalMinutes) {
    offsetDays = 1;
  }

  for (let i = 0; i < 8; i++) {
    const candidateCal = addCalendarDays(clock.year, clock.month, clock.day, offsetDays + i);
    const candidateUtc = localWallTimeToUtc(
      candidateCal.year,
      candidateCal.month,
      candidateCal.day,
      start.hour,
      start.minute,
      config.timezone
    );
    const candidateClock = getLocalClock(candidateUtc, config.timezone);
    if (config.businessAllowedDays.includes(candidateClock.weekday)) {
      return {
        allowed: false,
        reason,
        localClock: clock,
        nextWindowStart: candidateUtc,
      };
    }
  }

  return {
    allowed: false,
    reason,
    localClock: clock,
    nextWindowStart: null,
  };
}

export function getNextBusinessDayStart(date: Date, config: AppConfig): Date | null {
  if (!config.businessHoursEnabled) {
    return null;
  }
  const clock = getLocalClock(date, config.timezone);
  const start = parseHm(config.businessHoursStart);

  for (let i = 1; i <= 8; i++) {
    const candidateCal = addCalendarDays(clock.year, clock.month, clock.day, i);
    const candidateUtc = localWallTimeToUtc(
      candidateCal.year,
      candidateCal.month,
      candidateCal.day,
      start.hour,
      start.minute,
      config.timezone
    );
    const candidateClock = getLocalClock(candidateUtc, config.timezone);
    if (config.businessAllowedDays.includes(candidateClock.weekday)) {
      return candidateUtc;
    }
  }
  return null;
}
