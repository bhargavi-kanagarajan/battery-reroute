import { describe, expect, it } from 'vitest';
import { DEFAULT_SEED, DEMO_BATTERY_ID, MAIN_FLEET_OPERATOR_ID, generateDataset } from '../../scripts/seedGenerator';
import {
  checkSeedInvariants,
  formatSeedInvariantViolations,
  type SeedInvariant,
  type SeedInvariantResult,
} from '../../scripts/seedInvariants';
import { hasEmptyPassportField } from '../../src/core/confidence';
import { currentHolder } from '../../src/core/telemetry';
import type { DigitalTwin, Store } from '../../src/core/types';

const RUN_DATE = '2025-06-15';
const base = generateDataset(DEFAULT_SEED, RUN_DATE);

const twinsOf = (s: Store): DigitalTwin[] => Object.values(s.twins);
const holder = (t: DigitalTwin) => currentHolder(t.custodyLog)!;
const removeWhere = (s: Store, pred: (t: DigitalTwin) => boolean) => {
  for (const t of twinsOf(s)) if (pred(t)) delete s.twins[t.passport.batteryId];
};
const grantAt = (t: DigitalTwin) =>
  t.consentEvents.push({ type: 'grant', at: `${RUN_DATE}T12:00:00.000Z`, byId: t.dataOwner.id });

const invariantsOf = (r: SeedInvariantResult): SeedInvariant[] => (r.ok ? [] : r.violations.map((v) => v.invariant));

/** Clones the base dataset, applies `mutate`, and checks it. */
function checkMutated(mutate: (s: Store) => void): SeedInvariantResult {
  const s = structuredClone(base);
  mutate(s);
  return checkSeedInvariants(s, RUN_DATE);
}

describe('checkSeedInvariants on generated datasets', () => {
  it.each([
    [DEFAULT_SEED, RUN_DATE],
    [42, RUN_DATE],
    [-7, '2024-02-29'],
    [123456789, '2025-12-31'],
    [7, '2026-03-01'],
  ])('passes for seed %s on %s', (seed, runDate) => {
    const r = checkSeedInvariants(generateDataset(seed, runDate), runDate);
    expect(r, r.ok ? '' : formatSeedInvariantViolations(r.violations)).toEqual({ ok: true });
  });

  it('does not mutate its input', () => {
    const s = structuredClone(base);
    checkSeedInvariants(s, RUN_DATE);
    expect(s).toEqual(base);
  });
});

describe('checkSeedInvariants reports targeted violations', () => {
  const cases: Array<[SeedInvariant, (s: Store) => void]> = [
    ['SCHEMA_VALID', (s) => void (s.twins[DEMO_BATTERY_ID]!.passport.capacityKwh = -1)],
    ['TWIN_COUNT', (s) => twinsOf(s).slice(0, twinsOf(s).length - 44).forEach((t) => delete s.twins[t.passport.batteryId])],
    ['MANUFACTURER_COVERAGE', (s) => twinsOf(s).forEach((t) => void (t.passport.manufacturer = 'OnlyOne Corp'))],
    ['CHEMISTRY_COVERAGE', (s) => twinsOf(s).forEach((t) => void (t.passport.chemistry = 'NMC'))],
    ['PATHWAY_COVERAGE', (s) => twinsOf(s).forEach((t) => t.telemetry.forEach((r) => void (r.thermalEventCount = 1)))],
    [
      'FLEET_SIZE',
      (s) => twinsOf(s).filter((t) => holder(t).toHolderRole === 'Fleet_Operator').slice(9).forEach((t) => delete s.twins[t.passport.batteryId]),
    ],
    ['HOLDER_ROLE_COVERAGE', (s) => removeWhere(s, (t) => holder(t).toHolderRole === 'Recycler')],
    ['OWNER_CONSENT_RATIO', (s) => twinsOf(s).filter((t) => holder(t).toHolderRole === 'Owner').forEach(grantAt)],
    [
      'FLEET_CONSENT',
      (s) =>
        twinsOf(s)
          .filter((t) => holder(t).toHolderRole === 'Fleet_Operator')
          .forEach((t) => t.consentEvents.push({ type: 'withdraw', at: `${RUN_DATE}T12:00:00.000Z`, byId: t.dataOwner.id })),
    ],
    ['EOL_COVERAGE', (s) => twinsOf(s).forEach((t) => void (t.endOfLife = null))],
    [
      'MISSING_RECORDS_COVERAGE',
      (s) =>
        removeWhere(
          s,
          (t) => t.telemetry.length === 0 || t.chargingHistory.length === 0 || t.serviceHistory.length === 0 || hasEmptyPassportField(t.passport),
        ),
    ],
    ['ROUTED_SECOND_LIFE', (s) => twinsOf(s).forEach((t) => void (t.routedPathway === 'Second_Life_Review' && (t.routedPathway = null)))],
    ['ROUTED_RECYCLING', (s) => twinsOf(s).forEach((t) => void (t.routedPathway === 'Certified_Recycling' && (t.routedPathway = null)))],
    ['STAKEHOLDER_COVERAGE', (s) => void (s.stakeholders = s.stakeholders.filter((x) => x.role !== 'ESG_Officer'))],
    [
      'TELEMETRY_SOH',
      (s) => {
        const t = twinsOf(s).find(
          (x) => x.passport.batteryId !== DEMO_BATTERY_ID && x.telemetry.length >= 2 && x.serviceHistory.every((r) => r.modulesReplaced.length === 0),
        )!;
        const latest = [...t.telemetry].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).at(-1)!;
        latest.sohPct = 100;
      },
    ],
    [
      'CONSENT_BEFORE_HANDOVER',
      (s) => twinsOf(s).filter((t) => t.routedPathway === 'Second_Life_Review').forEach((t) => void (t.consentEvents = [])),
    ],
    ['DEMO_BATTERY', (s) => void delete s.twins[DEMO_BATTERY_ID]],
    ['DEMO_BATTERY', (s) => void grantAt(s.twins[DEMO_BATTERY_ID]!)],
    ['DEMO_BATTERY', (s) => void (s.twins[DEMO_BATTERY_ID]!.nudges = [])],
  ];

  it.each(cases)('reports %s', (invariant, mutate) => {
    const r = checkMutated(mutate);
    expect(r.ok).toBe(false);
    expect(invariantsOf(r)).toContain(invariant);
  });

  it('names dotted field paths for schema violations', () => {
    const r = checkMutated((s) => void (s.twins[DEMO_BATTERY_ID]!.passport.capacityKwh = -1));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const schema = r.violations.filter((v) => v.invariant === 'SCHEMA_VALID');
      expect(schema.some((v) => v.message.startsWith(`twins.${DEMO_BATTERY_ID}.passport.capacityKwh:`))).toBe(true);
    }
  });

  it('lists every violation instead of stopping at the first', () => {
    const r = checkMutated((s) => {
      twinsOf(s).forEach((t) => void (t.endOfLife = null));
      s.stakeholders = s.stakeholders.filter((x) => x.role !== 'ESG_Officer');
      grantAt(s.twins[DEMO_BATTERY_ID]!);
    });
    expect(invariantsOf(r)).toEqual(expect.arrayContaining(['EOL_COVERAGE', 'STAKEHOLDER_COVERAGE', 'DEMO_BATTERY']));
  });

  it('reports the main fleet losing consent only under FLEET_CONSENT, not FLEET_SIZE', () => {
    const r = checkMutated((s) =>
      twinsOf(s)
        .filter((t) => holder(t).toHolderId === MAIN_FLEET_OPERATOR_ID)
        .forEach((t) => t.consentEvents.push({ type: 'withdraw', at: `${RUN_DATE}T12:00:00.000Z`, byId: t.dataOwner.id })),
    );
    expect(invariantsOf(r)).toContain('FLEET_CONSENT');
    expect(invariantsOf(r)).not.toContain('FLEET_SIZE');
  });

  it('reports a malformed twin as a violation rather than throwing', () => {
    const r = checkMutated((s) => void ((s.twins[DEMO_BATTERY_ID] as unknown as { custodyLog: unknown }).custodyLog = undefined));
    expect(r.ok).toBe(false);
    expect(invariantsOf(r)).toContain('SCHEMA_VALID');
  });

  it('rejects an invalid run date', () => {
    expect(invariantsOf(checkSeedInvariants(base, '2025-02-30'))).toEqual(['SCHEMA_VALID']);
  });
});
