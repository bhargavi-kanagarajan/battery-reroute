/**
 * Clock that supplies the evaluation date / "current date" to the server.
 * Core functions never read the clock; the server passes `clock.today()` in explicitly.
 */
import { isIsoDate } from '../core/dates';
import type { ISODate } from '../core/types';

export interface Clock {
  /** Current calendar date, `YYYY-MM-DD`. */
  today(): ISODate;
}

/** Local calendar date of `d` as `YYYY-MM-DD`. */
export function localIsoDate(d: Date): ISODate {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** A clock fixed to one date (tests, demos). */
export function fixedClock(date: ISODate): Clock {
  if (!isIsoDate(date)) throw new Error(`Invalid fixed clock date: ${JSON.stringify(date)}`);
  return { today: () => date };
}

/** The machine's local date, read on every call. */
export const systemClock: Clock = { today: () => localIsoDate(new Date()) };

/**
 * `BR_TODAY` (YYYY-MM-DD) overrides the date for demos; otherwise the system clock.
 * Throws on an invalid `BR_TODAY` so a typo is not silently ignored.
 */
export function clockFromEnv(env: Record<string, string | undefined> = process.env): Clock {
  const override = env.BR_TODAY?.trim();
  if (override === undefined || override === '') return systemClock;
  if (!isIsoDate(override)) {
    throw new Error(`BR_TODAY must be a valid YYYY-MM-DD date, got ${JSON.stringify(env.BR_TODAY)}`);
  }
  return fixedClock(override);
}
