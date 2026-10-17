/**
 * Pathway_Recommender (Req 6).
 *
 * Pure: takes the twin and an explicit evalDate, never reads the clock, and never
 * mutates its input. Uses full internal data regardless of Consent (Req 4.11);
 * Consent is only reported, as a separate `consentStatus` field (Req 6.9).
 *
 * All five rule conditions are evaluated independently so `firedRules` is complete
 * (Req 6.8); the first fired rule in precedence order (a)–(e) decides (Req 6.2).
 * Telemetry and Service_History are considered only on or before evalDate.
 */
import { dataConfidence } from './confidence';
import { consentStatus, latestReading, readingsUpTo, recentFault, safetyCriticalFaults } from './telemetry';
import type { ConsentStatus, DigitalTwin, ISODate, Pathway } from './types';

/** SoH below this triggers Certified_Recycling (Req 6.3). */
export const RECYCLING_SOH_THRESHOLD = 60;
/** SoH at or above this allows Continue_Use (Req 6.6). */
export const CONTINUE_USE_SOH_THRESHOLD = 80;

export const TELEMETRY_MISSING_REASON = 'Telemetry is missing' as const;

export type RuleName =
  | 'CERTIFIED_RECYCLING'
  | 'MISSING_TELEMETRY'
  | 'INSPECT_REPAIR'
  | 'CONTINUE_USE'
  | 'SECOND_LIFE_REVIEW';

/** Precedence order (a)–(e) of Req 6.2. */
export const RULE_PRECEDENCE: readonly RuleName[] = [
  'CERTIFIED_RECYCLING',
  'MISSING_TELEMETRY',
  'INSPECT_REPAIR',
  'CONTINUE_USE',
  'SECOND_LIFE_REVIEW',
];

export const RULE_PATHWAY: Readonly<Record<RuleName, Pathway>> = {
  CERTIFIED_RECYCLING: 'Certified_Recycling',
  MISSING_TELEMETRY: 'Inspect_Repair',
  INSPECT_REPAIR: 'Inspect_Repair',
  CONTINUE_USE: 'Continue_Use',
  SECOND_LIFE_REVIEW: 'Second_Life_Review',
};

export interface FiredRuleInputs {
  soh?: number;
  thermalEvents?: number;
  safetyCriticalFaultCode?: string;
  recentFaultDate?: ISODate;
  telemetryMissing?: true;
}

export interface FiredRule {
  rule: RuleName;
  inputs: FiredRuleInputs;
}

export interface PathwayResult {
  pathway: Pathway;
  /** Every rule whose condition held, in precedence order. */
  firedRules: FiredRule[];
  decidingRule: RuleName;
  /** Only when decidingRule is MISSING_TELEMETRY. */
  reason?: typeof TELEMETRY_MISSING_REASON;
  dataConfidence: number;
  consentStatus: ConsentStatus;
}

export function recommendPathway(twin: DigitalTwin, evalDate: ISODate): PathwayResult {
  const latest = latestReading(twin, evalDate);
  const soh = latest?.sohPct;

  // Safety_Flag evidence (on or before evalDate).
  const maxThermal = readingsUpTo(twin, evalDate).reduce((m, r) => Math.max(m, r.thermalEventCount), 0);
  const criticalFault = safetyCriticalFaults(twin, evalDate)[0];
  const flagged = maxThermal >= 1 || criticalFault !== undefined;

  const fault = recentFault(twin, evalDate);

  const firedRules: FiredRule[] = [];

  // (a) Safety_Flag, or latest SoH < 60 (Req 6.3).
  if (flagged || (soh !== undefined && soh < RECYCLING_SOH_THRESHOLD)) {
    const inputs: FiredRuleInputs = {};
    if (soh !== undefined) inputs.soh = soh;
    if (maxThermal >= 1) inputs.thermalEvents = maxThermal;
    if (criticalFault) inputs.safetyCriticalFaultCode = criticalFault.faultCode;
    firedRules.push({ rule: 'CERTIFIED_RECYCLING', inputs });
  }

  if (soh === undefined) {
    // (b) No Telemetry and no Safety_Flag (Req 6.4).
    if (!flagged) firedRules.push({ rule: 'MISSING_TELEMETRY', inputs: { telemetryMissing: true } });
  } else if (!flagged && soh >= RECYCLING_SOH_THRESHOLD) {
    // (c) Recent_Fault (Req 6.5).
    if (fault) firedRules.push({ rule: 'INSPECT_REPAIR', inputs: { soh, recentFaultDate: fault.date } });
    // (d)/(e) No Recent_Fault (Req 6.6, 6.7).
    else if (soh >= CONTINUE_USE_SOH_THRESHOLD) firedRules.push({ rule: 'CONTINUE_USE', inputs: { soh } });
    else firedRules.push({ rule: 'SECOND_LIFE_REVIEW', inputs: { soh } });
  }

  // The conditions cover every twin, so at least one rule always fires (Req 6.1).
  const decidingRule = firedRules[0]!.rule;
  const result: PathwayResult = {
    pathway: RULE_PATHWAY[decidingRule],
    firedRules,
    decidingRule,
    dataConfidence: dataConfidence(twin),
    consentStatus: consentStatus(twin),
  };
  if (decidingRule === 'MISSING_TELEMETRY') result.reason = TELEMETRY_MISSING_REASON;
  return result;
}
