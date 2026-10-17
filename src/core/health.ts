/**
 * Health_Model (Req 5).
 *
 * Pure: takes the twin and an explicit evalDate, never reads the clock, and never
 * mutates its input. It reads Owner_Data regardless of Consent (Req 4.11); consent
 * only affects projection.
 */
import { dataConfidence } from './confidence';
import { datePart, daysBetween } from './dates';
import { fastChargeShare, readingsUpTo } from './telemetry';
import type { DigitalTwin, ISODate } from './types';

/** Remaining_Life is measured until SoH reaches this value (Req 5.3, 5.4). */
export const REMAINING_LIFE_SOH_THRESHOLD = 80;
/** Cap used when the month rate is ≤ 0 or undefined. */
export const MAX_MONTHS = 180;
/** Cap used when the cycle rate is ≤ 0 or undefined. */
export const MAX_CYCLES = 5000;
/** Average Gregorian month length in days, used to turn a day span into months. */
export const DAYS_PER_MONTH = 365.25 / 12;

export type ContributingFactorName = 'SoH' | 'CycleCount' | 'FastChargeShare' | 'ThermalEvents';

export interface ContributingFactor {
  name: ContributingFactorName;
  /** Input value: SoH %, cycle count, Fast_Charge_Share %, or thermal event count. */
  value: number;
  /** Signed effect on the Health_Score, rounded to one decimal place. */
  effect: number;
}

export interface RemainingLife {
  months: number;
  cycles: number;
}

export type HealthResult =
  | {
      ok: true;
      healthScore: number;
      factors: ContributingFactor[];
      remainingLife: RemainingLife | null;
      remainingLifeReason?: 'INSUFFICIENT_TELEMETRY_HISTORY';
      dataConfidence: number;
    }
  | { ok: false; reason: 'TELEMETRY_MISSING'; dataConfidence: number };

/** Rounds to one decimal and normalizes -0 to 0. */
function round1(n: number): number {
  const r = Math.round(n * 10) / 10;
  return r === 0 ? 0 : r;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Unrounded factor effects; each is non-increasing in its "bad" input (Req 5.6, 5.7). */
export function factorEffects(input: { soh: number; cycles: number; fcs: number; thermalEvents: number }) {
  return {
    soh: -(100 - input.soh),
    cycles: -Math.min(15, input.cycles / 100),
    fcs: -Math.min(15, input.fcs * 0.2),
    thermal: -Math.min(20, input.thermalEvents * 10),
  };
}

/** One Remaining_Life output: floor(headroom / rate), capped; cap when the rate is ≤ 0 or undefined. */
function lifeFromRate(headroom: number, decline: number, span: number, cap: number): number {
  if (span <= 0) return cap;
  const rate = decline / span;
  if (!(rate > 0)) return cap;
  return clamp(Math.floor(headroom / rate), 0, cap);
}

export function evaluateHealth(twin: DigitalTwin, evalDate: ISODate): HealthResult {
  const confidence = dataConfidence(twin);
  const readings = readingsUpTo(twin, evalDate);
  const latest = readings[readings.length - 1];
  if (!latest) return { ok: false, reason: 'TELEMETRY_MISSING', dataConfidence: confidence };

  // Req 5.11: empty Charging_History → FCS 0 and a FastChargeShare effect of exactly 0.
  const fcs = fastChargeShare(twin.chargingHistory, evalDate);
  const fx = factorEffects({
    soh: latest.sohPct,
    cycles: latest.cycleCount,
    fcs,
    thermalEvents: latest.thermalEventCount,
  });

  // Score from unrounded effects; effects reported rounded to one decimal.
  const healthScore = clamp(Math.round(100 + fx.soh + fx.cycles + fx.fcs + fx.thermal), 0, 100);
  const factors: ContributingFactor[] = [
    { name: 'SoH', value: latest.sohPct, effect: round1(fx.soh) },
    { name: 'CycleCount', value: latest.cycleCount, effect: round1(fx.cycles) },
    { name: 'FastChargeShare', value: round1(fcs), effect: round1(fx.fcs) },
    { name: 'ThermalEvents', value: latest.thermalEventCount, effect: round1(fx.thermal) },
  ];

  const base = { ok: true as const, healthScore, factors, dataConfidence: confidence };

  if (latest.sohPct <= REMAINING_LIFE_SOH_THRESHOLD) {
    return { ...base, remainingLife: { months: 0, cycles: 0 } };
  }
  if (readings.length < 2) {
    return { ...base, remainingLife: null, remainingLifeReason: 'INSUFFICIENT_TELEMETRY_HISTORY' };
  }

  const first = readings[0]!;
  const decline = first.sohPct - latest.sohPct;
  const headroom = latest.sohPct - REMAINING_LIFE_SOH_THRESHOLD;
  const monthSpan = daysBetween(datePart(first.timestamp), datePart(latest.timestamp)) / DAYS_PER_MONTH;
  const cycleSpan = latest.cycleCount - first.cycleCount;

  return {
    ...base,
    remainingLife: {
      months: lifeFromRate(headroom, decline, monthSpan, MAX_MONTHS),
      cycles: lifeFromRate(headroom, decline, cycleSpan, MAX_CYCLES),
    },
  };
}
