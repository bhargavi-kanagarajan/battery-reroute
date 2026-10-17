/**
 * Calendar-date helpers. All arithmetic is UTC-only so results never depend on
 * the host time zone. Dates are ISO `YYYY-MM-DD` strings, which also compare
 * correctly with plain string comparison.
 */

import type { ISODate } from './types';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export interface YMD {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/** Parses a strict `YYYY-MM-DD` calendar date; returns null when malformed or not a real date. */
export function parseIsoDate(value: unknown): YMD | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** True when `value` is a valid `YYYY-MM-DD` calendar date. */
export function isIsoDate(value: unknown): value is ISODate {
  return parseIsoDate(value) !== null;
}

export function formatIsoDate({ year, month, day }: YMD): ISODate {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

function requireDate(date: ISODate): YMD {
  const ymd = parseIsoDate(date);
  if (!ymd) throw new RangeError(`Invalid ISO date: ${String(date)}`);
  return ymd;
}

function toEpochDay(date: ISODate): number {
  const { year, month, day } = requireDate(date);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

function fromEpochDay(epochDay: number): ISODate {
  const d = new Date(epochDay * MS_PER_DAY);
  return formatIsoDate({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
}

/**
 * Calendar-date part of an ISO date or datetime string (`YYYY-MM-DDTHH:mm:ssZ` → `YYYY-MM-DD`).
 * Telemetry timestamps are compared against evalDate by this date part.
 */
export function datePart(isoDateOrDateTime: string): ISODate {
  return isoDateOrDateTime.slice(0, 10);
}

/** `date` plus `days` (may be negative). */
export function addDays(date: ISODate, days: number): ISODate {
  return fromEpochDay(toEpochDay(date) + Math.trunc(days));
}

/**
 * `date` plus `months` (may be negative). The day is clamped to the last day of
 * the target month, e.g. 2025-01-31 + 1 month = 2025-02-28.
 */
export function addMonths(date: ISODate, months: number): ISODate {
  const { year, month, day } = requireDate(date);
  const total = year * 12 + (month - 1) + Math.trunc(months);
  const y = Math.floor(total / 12);
  const mo = total - y * 12 + 1;
  return formatIsoDate({ year: y, month: mo, day: Math.min(day, daysInMonth(y, mo)) });
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: ISODate, to: ISODate): number {
  return toEpochDay(to) - toEpochDay(from);
}

export interface Quarter {
  year: number;
  quarter: 1 | 2 | 3 | 4;
}

/** Calendar quarter containing `date`. */
export function quarterOf(date: ISODate): Quarter {
  const { year, month } = requireDate(date);
  return { year, quarter: (Math.floor((month - 1) / 3) + 1) as Quarter['quarter'] };
}

/** Label such as '2025-Q3'. */
export function quarterLabel(q: Quarter): string {
  return `${q.year}-Q${q.quarter}`;
}

/** Quarter that is `offset` quarters after `q` (may be negative). */
export function addQuarters(q: Quarter, offset: number): Quarter {
  const index = q.year * 4 + (q.quarter - 1) + Math.trunc(offset);
  const year = Math.floor(index / 4);
  return { year, quarter: (index - year * 4 + 1) as Quarter['quarter'] };
}

/** Number of calendar quarters from the quarter containing `from` to the one containing `to`. */
export function quarterOffset(from: ISODate, to: ISODate): number {
  const a = quarterOf(from);
  const b = quarterOf(to);
  return b.year * 4 + b.quarter - (a.year * 4 + a.quarter);
}
