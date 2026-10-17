/**
 * Scope3_Reporter: GHG Protocol Scope 3 Category 12 disposition report (Req 12).
 *
 * Pure: no clock, no I/O. The report carries dispositions, measurement coverage,
 * data quality, and Consent status only; it never contains emissions quantities
 * (Req 12.12). Custody entries are projected through `esgCustodyEntries`, so no
 * Owner identity or from-holder is ever included (Req 3.15, 3.16), and the CSV
 * export contains no custody data at all (Req 12.8).
 */

import { esgCustodyEntries } from './access';
import { dataConfidence } from './confidence';
import { CSV_RECORD_SEPARATOR, csvRecord, parseCsv } from './csv';
import { isIsoDate } from './dates';
import { consentStatus, currentHolder } from './telemetry';
import type {
  ConsentStatus,
  DigitalTwin,
  Disposition,
  DomainError,
  EndOfLifeRecord,
  FieldError,
  ISODate,
  MeasurementStatus,
  Result,
  Scope3CsvReport,
  Scope3CsvRow,
  Scope3Report,
  Scope3Row,
  Stakeholder,
} from './types';

export const DISPOSITIONS: readonly Disposition[] = ['In_Use', 'Second_Life', 'Recycled', 'Unknown'];
export const NOT_YET_EOL_LABEL = 'not yet at end of life';

export const CSV_BATTERY_HEADER = [
  'battery_id',
  'disposition',
  'measurement_status',
  'data_confidence_score',
  'consent_status',
  'eol_date',
] as const;
export const CSV_SUMMARY_HEADER = ['summary_key', 'summary_value'] as const;

/** Summary keys in CSV order (after `summary_key,summary_value`). */
export const CSV_SUMMARY_KEYS = [
  'manufacturer',
  'period_start',
  'period_end',
  'count_In_Use',
  'count_Second_Life',
  'count_Recycled',
  'count_Unknown',
  NOT_YET_EOL_LABEL,
  'measured_share',
] as const;

export interface Period {
  start: ISODate;
  end: ISODate;
}

// ---------------------------------------------------------------------------
// Period validation (Req 12.14)
// ---------------------------------------------------------------------------

/** Rejects a missing or invalid calendar date, or an end date before the start date. */
export function validatePeriod(start?: unknown, end?: unknown): Result<Period, DomainError> {
  const fields: FieldError[] = [];
  if (start === undefined || start === null || start === '') {
    fields.push({ field: 'start', message: 'Period start date is required' });
  } else if (!isIsoDate(start)) {
    fields.push({ field: 'start', message: 'Period start date must be a valid YYYY-MM-DD calendar date' });
  }
  if (end === undefined || end === null || end === '') {
    fields.push({ field: 'end', message: 'Period end date is required' });
  } else if (!isIsoDate(end)) {
    fields.push({ field: 'end', message: 'Period end date must be a valid YYYY-MM-DD calendar date' });
  }
  if (fields.length === 0 && (end as string) < (start as string)) {
    fields.push({ field: 'end', message: 'Period end date must not be before the start date' });
  }
  if (fields.length > 0) {
    return { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid reporting period', fields } };
  }
  return { ok: true, value: { start: start as ISODate, end: end as ISODate } };
}

// ---------------------------------------------------------------------------
// Disposition and Measurement_Status (Req 12.3, 12.4)
// ---------------------------------------------------------------------------

/** The End_Of_Life_Record if dated on or before `end`, else null. */
export function eolAsOf(twin: Pick<DigitalTwin, 'endOfLife'>, end: ISODate): EndOfLifeRecord | null {
  return twin.endOfLife && twin.endOfLife.date <= end ? twin.endOfLife : null;
}

/** Disposition per Req 12.3 rules (a)–(d), first match wins, ignoring records after `end`. */
export function dispositionAsOf(twin: Pick<DigitalTwin, 'endOfLife' | 'custodyLog'>, end: ISODate): Disposition {
  const eol = eolAsOf(twin, end);
  const holderRole = currentHolder(twin.custodyLog, end)?.toHolderRole;
  if (eol?.pathway === 'Certified_Recycling' || holderRole === 'Recycler') return 'Recycled';
  if (eol?.pathway === 'Second_Life_Review' || holderRole === 'Second_Life_Provider') return 'Second_Life';
  if (
    eol === null &&
    (holderRole === 'Owner' || holderRole === 'Fleet_Operator' || holderRole === 'Service_Partner')
  ) {
    return 'In_Use';
  }
  return 'Unknown';
}

/** Measured when an EOL record or a handover to an SLP/Recycler is dated on or before `end` (Req 12.4). */
export function measurementStatusAsOf(
  twin: Pick<DigitalTwin, 'endOfLife' | 'custodyLog'>,
  end: ISODate,
): MeasurementStatus {
  if (eolAsOf(twin, end)) return 'Measured';
  const handedOn = twin.custodyLog.some(
    (e) => e.date <= end && (e.toHolderRole === 'Second_Life_Provider' || e.toHolderRole === 'Recycler'),
  );
  return handedOn ? 'Measured' : 'Estimated';
}

// ---------------------------------------------------------------------------
// Counts and Measured_Share (Req 12.5, 12.6, 12.16, 12.17)
// ---------------------------------------------------------------------------

export function dispositionCounts(rows: readonly Pick<Scope3Row, 'disposition'>[]): Record<Disposition, number> {
  const counts: Record<Disposition, number> = { In_Use: 0, Second_Life: 0, Recycled: 0, Unknown: 0 };
  for (const r of rows) counts[r.disposition] += 1;
  return counts;
}

/**
 * Measured_Share over batteries with Disposition Second_Life, Recycled, or Unknown
 * (In_Use excluded from numerator and denominator), rounded half-up to one decimal.
 * Integer arithmetic: tenths = floor((2000m + d) / (2d)). "0.0" when d = 0.
 */
export function measuredShare(rows: readonly Pick<Scope3Row, 'disposition' | 'measurementStatus'>[]): string {
  let d = 0;
  let m = 0;
  for (const r of rows) {
    if (r.disposition === 'In_Use') continue;
    d += 1;
    if (r.measurementStatus === 'Measured') m += 1;
  }
  if (d === 0) return '0.0';
  const tenths = Math.floor((2000 * m + d) / (2 * d));
  return (tenths / 10).toFixed(1);
}

// ---------------------------------------------------------------------------
// Report (Req 12.2–12.7, 12.12)
// ---------------------------------------------------------------------------

/**
 * Builds the Scope3_Report for `manufacturer` and an already validated `period`.
 * Includes every twin of that manufacturer manufactured on or before the period end;
 * the period start is used only for display. Rows are ordered by battery ID.
 */
export function buildScope3Report(
  twins: readonly DigitalTwin[],
  stakeholders: readonly Stakeholder[],
  manufacturer: string,
  period: Period,
): Scope3Report {
  const rows: Scope3Row[] = twins
    .filter((t) => t.passport.manufacturer === manufacturer && t.passport.manufactureDate <= period.end)
    .map((t) => ({
      batteryId: t.passport.batteryId,
      disposition: dispositionAsOf(t, period.end),
      measurementStatus: measurementStatusAsOf(t, period.end),
      dataConfidence: dataConfidence(t),
      consentStatus: consentStatus(t),
      eolDate: eolAsOf(t, period.end)?.date ?? '',
      custodyLog: esgCustodyEntries(t.custodyLog, stakeholders),
    }))
    .sort((a, b) => (a.batteryId < b.batteryId ? -1 : a.batteryId > b.batteryId ? 1 : 0));

  const counts = dispositionCounts(rows);
  return {
    manufacturer,
    periodStart: period.start,
    periodEnd: period.end,
    rows,
    counts,
    notYetEolCount: counts.In_Use,
    measuredShare: measuredShare(rows),
  };
}

// ---------------------------------------------------------------------------
// CSV export / parse (Req 12.8–12.11, 12.17)
// ---------------------------------------------------------------------------

/** Serializes a report to RFC 4180 CSV with CRLF record terminators and no custody columns. */
export function toCsv(report: Scope3Report | Scope3CsvReport): string {
  const records: string[][] = [[...CSV_BATTERY_HEADER]];
  for (const r of report.rows) {
    records.push([
      r.batteryId,
      r.disposition,
      r.measurementStatus,
      String(r.dataConfidence),
      r.consentStatus,
      r.eolDate,
    ]);
  }
  records.push([...CSV_SUMMARY_HEADER]);
  const summary: Record<(typeof CSV_SUMMARY_KEYS)[number], string> = {
    manufacturer: report.manufacturer,
    period_start: report.periodStart,
    period_end: report.periodEnd,
    count_In_Use: String(report.counts.In_Use),
    count_Second_Life: String(report.counts.Second_Life),
    count_Recycled: String(report.counts.Recycled),
    count_Unknown: String(report.counts.Unknown),
    [NOT_YET_EOL_LABEL]: String(report.notYetEolCount),
    measured_share: report.measuredShare,
  };
  for (const key of CSV_SUMMARY_KEYS) records.push([key, summary[key]]);
  return records.map((f) => csvRecord(f) + CSV_RECORD_SEPARATOR).join('');
}

export class Scope3CsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Scope3CsvError';
  }
}

const sameFields = (a: readonly string[] | undefined, b: readonly string[]): boolean =>
  a !== undefined && a.length === b.length && a.every((v, i) => v === b[i]);

function parseCount(value: string, key: string): number {
  if (!/^\d+$/.test(value)) throw new Scope3CsvError(`Invalid ${key}: ${JSON.stringify(value)}`);
  return Number(value);
}

/** Parses a CSV produced by `toCsv`. Throws `Scope3CsvError` / `CsvParseError` on malformed input. */
export function parseScope3Csv(csv: string): Scope3CsvReport {
  const records = parseCsv(csv);
  if (!sameFields(records[0], CSV_BATTERY_HEADER)) throw new Scope3CsvError('Missing or invalid battery header row');

  const rows: Scope3CsvRow[] = [];
  let i = 1;
  for (; i < records.length && records[i]!.length === CSV_BATTERY_HEADER.length; i++) {
    const [batteryId, disposition, measurementStatus, confidence, consent, eolDate] = records[i]!;
    if (!DISPOSITIONS.includes(disposition as Disposition)) {
      throw new Scope3CsvError(`Row ${i}: invalid disposition ${JSON.stringify(disposition)}`);
    }
    if (measurementStatus !== 'Measured' && measurementStatus !== 'Estimated') {
      throw new Scope3CsvError(`Row ${i}: invalid measurement_status ${JSON.stringify(measurementStatus)}`);
    }
    const dc = parseCount(confidence!, 'data_confidence_score');
    if (dc > 100) throw new Scope3CsvError(`Row ${i}: data_confidence_score out of range`);
    if (consent !== 'granted' && consent !== 'not_granted') {
      throw new Scope3CsvError(`Row ${i}: invalid consent_status ${JSON.stringify(consent)}`);
    }
    if (eolDate !== '' && !isIsoDate(eolDate)) {
      throw new Scope3CsvError(`Row ${i}: invalid eol_date ${JSON.stringify(eolDate)}`);
    }
    rows.push({
      batteryId: batteryId!,
      disposition: disposition as Disposition,
      measurementStatus,
      dataConfidence: dc,
      consentStatus: consent as ConsentStatus,
      eolDate: eolDate as ISODate | '',
    });
  }

  if (!sameFields(records[i], CSV_SUMMARY_HEADER)) throw new Scope3CsvError('Missing or invalid summary header row');
  i += 1;
  const summary: Record<string, string> = {};
  for (const key of CSV_SUMMARY_KEYS) {
    const rec = records[i];
    if (!rec || rec.length !== 2 || rec[0] !== key) {
      throw new Scope3CsvError(`Expected summary row ${JSON.stringify(key)}`);
    }
    summary[key] = rec[1]!;
    i += 1;
  }
  if (i !== records.length) throw new Scope3CsvError('Unexpected records after summary rows');

  for (const key of ['period_start', 'period_end'] as const) {
    if (!isIsoDate(summary[key])) throw new Scope3CsvError(`Invalid ${key}`);
  }
  if (!/^\d+\.\d$/.test(summary.measured_share!)) throw new Scope3CsvError('Invalid measured_share');

  return {
    manufacturer: summary.manufacturer!,
    periodStart: summary.period_start!,
    periodEnd: summary.period_end!,
    rows,
    counts: {
      In_Use: parseCount(summary.count_In_Use!, 'count_In_Use'),
      Second_Life: parseCount(summary.count_Second_Life!, 'count_Second_Life'),
      Recycled: parseCount(summary.count_Recycled!, 'count_Recycled'),
      Unknown: parseCount(summary.count_Unknown!, 'count_Unknown'),
    },
    notYetEolCount: parseCount(summary[NOT_YET_EOL_LABEL]!, NOT_YET_EOL_LABEL),
    measuredShare: summary.measured_share!,
  };
}
