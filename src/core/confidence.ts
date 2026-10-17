/**
 * Data_Confidence_Score (Req 5.10, 6.9, 6.10, 6.15).
 *
 * Pure: depends only on the twin's record completeness. It takes no viewer, role,
 * or Consent input and applies no consent deduction, so the score is identical for
 * every Active_Role and Consent status by construction (Req 6.15).
 *
 * Caller contract: every place that returns `dataConfidence` must also return
 * `consentStatus(twin)` (from `./telemetry`) as a separate field next to it — the
 * Pathway result, the Owner / Service_Partner / Second_Life_Provider / ESG_Officer
 * projections, Scope3 rows, and CSV rows (Req 6.9, 12.7, 12.8).
 */
import type { BatteryPassport, DigitalTwin } from './types';

export const CONFIDENCE_START = 100;
export const DEDUCTION_NO_TELEMETRY = 30;
export const DEDUCTION_NO_CHARGING_HISTORY = 20;
export const DEDUCTION_NO_SERVICE_HISTORY = 20;
export const DEDUCTION_EMPTY_PASSPORT_FIELD = 15;

/** True when any string field of the Battery_Passport is the empty string. */
export function hasEmptyPassportField(passport: BatteryPassport): boolean {
  return Object.values(passport).some((v) => typeof v === 'string' && v === '');
}

/** Data_Confidence_Score in [0, 100]; each deduction applies at most once. */
export function dataConfidence(twin: DigitalTwin): number {
  let score = CONFIDENCE_START;
  if (twin.telemetry.length === 0) score -= DEDUCTION_NO_TELEMETRY;
  if (twin.chargingHistory.length === 0) score -= DEDUCTION_NO_CHARGING_HISTORY;
  if (twin.serviceHistory.length === 0) score -= DEDUCTION_NO_SERVICE_HISTORY;
  if (hasEmptyPassportField(twin.passport)) score -= DEDUCTION_EMPTY_PASSPORT_FIELD;
  return Math.max(0, score);
}
