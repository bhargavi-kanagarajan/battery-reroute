/**
 * Telemetry, custody, consent, and return helpers shared by the core models.
 * Pure: every function takes its inputs explicitly and never reads the clock.
 * Telemetry timestamps are full ISO datetimes; they are compared with evalDate
 * by their `YYYY-MM-DD` date part.
 */

import { isSafetyCriticalFaultCode } from './constants';
import { addDays, datePart } from './dates';
import type {
  ChargingSession,
  ConsentStatus,
  CustodyEntry,
  DigitalTwin,
  ISODate,
  InspectionFlag,
  ReturnRecord,
  ServiceRecord,
  TelemetryReading,
} from './types';

/** Recent_Fault window: the 90 days before evalDate (inclusive). */
export const RECENT_FAULT_WINDOW_DAYS = 90;
/** Falling_SoH_Trend window: the 180 days before evalDate (inclusive). */
export const SOH_TREND_WINDOW_DAYS = 180;
/** Minimum SoH decline (percentage points) for a Falling_SoH_Trend. */
export const SOH_TREND_MIN_DECLINE = 2;

function timestampMs(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Date.parse(datePart(ts)) : ms;
}

/** Readings whose date part is on or before evalDate, sorted by timestamp ascending (stable). */
export function readingsUpTo(twin: Pick<DigitalTwin, 'telemetry'>, evalDate: ISODate): TelemetryReading[] {
  return twin.telemetry
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => datePart(r.timestamp) <= evalDate)
    .sort((a, b) => timestampMs(a.r.timestamp) - timestampMs(b.r.timestamp) || a.i - b.i)
    .map(({ r }) => r);
}

/** The reading with the latest timestamp on or before evalDate, if any. */
export function latestReading(
  twin: Pick<DigitalTwin, 'telemetry'>,
  evalDate: ISODate,
): TelemetryReading | undefined {
  const readings = readingsUpTo(twin, evalDate);
  return readings[readings.length - 1];
}

/**
 * Fast_Charge_Share (0..100) over sessions dated on or before evalDate.
 * 0 when there are no such sessions or their total energy is 0 (Req 5.11).
 */
export function fastChargeShare(sessions: readonly ChargingSession[], evalDate: ISODate): number {
  let total = 0;
  let fast = 0;
  for (const s of sessions) {
    if (s.date > evalDate) continue;
    total += s.energyKwh;
    if (s.chargeType === 'DC_Fast') fast += s.energyKwh;
  }
  return total > 0 ? (fast / total) * 100 : 0;
}

/** Service records dated on or before evalDate whose fault code is safety-critical. */
export function safetyCriticalFaults(
  twin: Pick<DigitalTwin, 'serviceHistory'>,
  evalDate: ISODate,
): ServiceRecord[] {
  return twin.serviceHistory.filter((s) => s.date <= evalDate && isSafetyCriticalFaultCode(s.faultCode));
}

/**
 * Safety_Flag: any reading on or before evalDate with a thermal event count ≥ 1,
 * or any service record on or before evalDate with a Safety_Critical_Fault_Code.
 */
export function safetyFlag(
  twin: Pick<DigitalTwin, 'telemetry' | 'serviceHistory'>,
  evalDate: ISODate,
): boolean {
  return (
    readingsUpTo(twin, evalDate).some((r) => r.thermalEventCount >= 1) ||
    safetyCriticalFaults(twin, evalDate).length > 0
  );
}

/**
 * Recent_Fault: the most recent service record with a non-empty fault code dated
 * within [evalDate − 90 days, evalDate] (Req 6.5).
 */
export function recentFault(
  twin: Pick<DigitalTwin, 'serviceHistory'>,
  evalDate: ISODate,
): ServiceRecord | undefined {
  const from = addDays(evalDate, -RECENT_FAULT_WINDOW_DAYS);
  let found: ServiceRecord | undefined;
  for (const s of twin.serviceHistory) {
    if (s.faultCode === '' || s.date < from || s.date > evalDate) continue;
    if (!found || s.date >= found.date) found = s;
  }
  return found;
}

/**
 * Falling_SoH_Trend (Req 7.4): readings with date part in [evalDate − 180 days, evalDate];
 * at least 2 readings; decline = SoH(earliest) − SoH(latest); present when decline ≥ 2.
 */
export function fallingSohTrend(
  twin: Pick<DigitalTwin, 'telemetry'>,
  evalDate: ISODate,
): { decline: number } | undefined {
  const from = addDays(evalDate, -SOH_TREND_WINDOW_DAYS);
  const window = readingsUpTo(twin, evalDate).filter((r) => datePart(r.timestamp) >= from);
  if (window.length < 2) return undefined;
  const first = window[0]!;
  const last = window[window.length - 1]!;
  // Round away floating-point noise (e.g. 85.3 − 83.3 = 1.9999999999999716).
  const decline = Math.round((first.sohPct - last.sohPct) * 1e9) / 1e9;
  return decline >= SOH_TREND_MIN_DECLINE ? { decline } : undefined;
}

/**
 * Current_Holder: the last Custody_Log entry, or with `asOf` the last entry dated
 * on or before `asOf` (Req 1.11, 12.3).
 */
export function currentHolder(
  custodyLog: readonly CustodyEntry[],
  asOf?: ISODate,
): CustodyEntry | undefined {
  for (let i = custodyLog.length - 1; i >= 0; i--) {
    const entry = custodyLog[i]!;
    if (asOf === undefined || entry.date <= asOf) return entry;
  }
  return undefined;
}

/** 'granted' iff the most recent ConsentEvent is a grant; not granted by default (Req 4.3). */
export function consentStatus(twin: Pick<DigitalTwin, 'consentEvents'>): ConsentStatus {
  const last = twin.consentEvents[twin.consentEvents.length - 1];
  return last?.type === 'grant' ? 'granted' : 'not_granted';
}

/** The most recent Inspection_Flag (last element), if any. */
export function latestInspectionFlag(twin: Pick<DigitalTwin, 'inspectionFlags'>): InspectionFlag | undefined {
  return twin.inspectionFlags[twin.inspectionFlags.length - 1];
}

/** The ReturnRecord written for `ownerId`, if any. */
export function returnRecordFor(
  twin: Pick<DigitalTwin, 'returnRecords'>,
  ownerId: string,
): ReturnRecord | undefined {
  return twin.returnRecords.find((r) => r.ownerId === ownerId);
}

/** Returned_Battery for `ownerId`: a ReturnRecord exists and the Current_Holder is not that Owner. */
export function isReturnedFor(
  twin: Pick<DigitalTwin, 'returnRecords' | 'custodyLog'>,
  ownerId: string,
): boolean {
  if (!returnRecordFor(twin, ownerId)) return false;
  return currentHolder(twin.custodyLog)?.toHolderId !== ownerId;
}
