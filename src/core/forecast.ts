/**
 * Replacement_Forecast (Req 8.4, 8.8, 8.9).
 *
 * Pure: takes the fleet twins and an explicit evalDate, never reads the clock,
 * and never mutates its input.
 */
import { addMonths, addQuarters, quarterLabel, quarterOf, quarterOffset } from './dates';
import { evaluateHealth } from './health';
import type { DigitalTwin, ISODate } from './types';

/** Number of consecutive calendar quarters in the forecast. */
export const FORECAST_QUARTERS = 4;
/** Batteries with Remaining_Life above this many months are excluded (Req 8.9). */
export const FORECAST_HORIZON_MONTHS = 12;

export interface ForecastQuarter {
  /** e.g. '2025-Q3'. */
  quarter: string;
  count: number;
}

/**
 * Four quarters starting with the quarter containing evalDate. Each battery whose
 * Remaining_Life is available and ≤ 12 months is counted once, in the quarter
 * containing evalDate + months, or in the fourth quarter when that date is later.
 * Batteries with no Remaining_Life (missing telemetry or insufficient history)
 * or more than 12 months are excluded.
 */
export function replacementForecast(fleetTwins: readonly DigitalTwin[], evalDate: ISODate): ForecastQuarter[] {
  const q0 = quarterOf(evalDate);
  const counts = new Array<number>(FORECAST_QUARTERS).fill(0);

  for (const twin of fleetTwins) {
    const health = evaluateHealth(twin, evalDate);
    if (!health.ok || health.remainingLife === null) continue;
    const { months } = health.remainingLife;
    if (months > FORECAST_HORIZON_MONTHS) continue;
    const target = addMonths(evalDate, months);
    const index = Math.min(FORECAST_QUARTERS - 1, Math.max(0, quarterOffset(evalDate, target)));
    counts[index]! += 1;
  }

  return counts.map((count, i) => ({ quarter: quarterLabel(addQuarters(q0, i)), count }));
}
