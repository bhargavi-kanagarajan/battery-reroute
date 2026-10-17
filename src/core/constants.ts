/**
 * Fixed Platform constants shared by core modules.
 * Pure module: no Node, Express, or React imports.
 */

/** Fault codes that raise a Safety_Flag (glossary: Safety_Critical_Fault_Code). */
export const SAFETY_CRITICAL_FAULT_CODES = [
  'THERMAL_RUNAWAY',
  'CELL_VENTING',
  'INTERNAL_SHORT',
  'ISOLATION_FAULT',
  'BMS_OVERTEMP',
] as const;

export type SafetyCriticalFaultCode = (typeof SAFETY_CRITICAL_FAULT_CODES)[number];

export function isSafetyCriticalFaultCode(code: string): code is SafetyCriticalFaultCode {
  return (SAFETY_CRITICAL_FAULT_CODES as readonly string[]).includes(code);
}
