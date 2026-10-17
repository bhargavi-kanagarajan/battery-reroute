/**
 * Usable_Capacity and Application_Fit for second-life review (Req 10.2).
 * Pure: inputs are explicit and evalDate is passed in; the clock is never read.
 */

import { latestReading, safetyFlag } from './telemetry';
import type { DigitalTwin, ISODate } from './types';

/** Stationary_Storage thresholds (Req 10.2). */
export const STATIONARY_MIN_SOH = 60;
export const STATIONARY_MIN_USABLE_KWH = 10.0;
/** Light_Mobility thresholds (Req 10.2). */
export const LIGHT_MOBILITY_MIN_SOH = 70;
export const LIGHT_MOBILITY_MIN_USABLE_KWH = 2.0;

export type ApplicationFitValue = 'Stationary_Storage' | 'Light_Mobility';

/**
 * Application_Fit: exactly 'None', or a non-empty list of fits in the fixed order
 * Stationary_Storage, Light_Mobility. 'None' is never combined with another value.
 */
export type ApplicationFit =
  | 'None'
  | readonly ['Stationary_Storage']
  | readonly ['Light_Mobility']
  | readonly ['Stationary_Storage', 'Light_Mobility'];

/** Usable_Capacity in kWh = capacity × SoH / 100. Unrounded; round only for display. */
export function usableCapacity(capacityKwh: number, soh: number): number {
  return (capacityKwh * soh) / 100;
}

/** Usable_Capacity rounded to one decimal place for display (Req 10.1). */
export function roundUsableCapacity(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ApplicationFitInputs {
  capacityKwh: number;
  /** Latest SoH, or undefined when there is no Telemetry. */
  soh: number | undefined;
  safetyFlag: boolean;
}

/**
 * Application_Fit from explicit inputs (Req 10.2). Thresholds compare the
 * unrounded Usable_Capacity.
 */
export function applicationFitFor({ capacityKwh, soh, safetyFlag: flagged }: ApplicationFitInputs): ApplicationFit {
  if (soh === undefined || flagged) return 'None';
  const uc = usableCapacity(capacityKwh, soh);
  const stationary = soh >= STATIONARY_MIN_SOH && uc >= STATIONARY_MIN_USABLE_KWH;
  const light = soh >= LIGHT_MOBILITY_MIN_SOH && uc >= LIGHT_MOBILITY_MIN_USABLE_KWH;
  if (stationary && light) return ['Stationary_Storage', 'Light_Mobility'];
  if (stationary) return ['Stationary_Storage'];
  if (light) return ['Light_Mobility'];
  return 'None';
}

/**
 * Application_Fit for a twin on evalDate. SoH comes from the latest reading on or
 * before evalDate; "no Telemetry" means no such reading; Safety_Flag considers
 * records on or before evalDate. Uses Owner_Data regardless of Consent (Req 4.11).
 */
export function applicationFit(
  twin: Pick<DigitalTwin, 'passport' | 'telemetry' | 'serviceHistory'>,
  evalDate: ISODate,
): ApplicationFit {
  return applicationFitFor({
    capacityKwh: twin.passport.capacityKwh,
    soh: latestReading(twin, evalDate)?.sohPct,
    safetyFlag: safetyFlag(twin, evalDate),
  });
}
