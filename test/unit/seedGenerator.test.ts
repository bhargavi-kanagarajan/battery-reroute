import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SEED,
  DEMO_BATTERY_ID,
  DEMO_ESG_OFFICER_ID,
  DEMO_MANUFACTURER,
  DEMO_OWNER_ID,
  DEMO_RECYCLER_ID,
  DEMO_SECOND_LIFE_PROVIDER_ID,
  DEMO_SERVICE_PARTNER_ID,
  EMPTY_OWNER_ID,
  FLAGGED_FLEET_BATTERY_ID,
  FLAGGED_FLEET_SERVICE_PARTNER_ID,
  MAIN_FLEET_OPERATOR_ID,
  UNFLAGGED_FLEET_BATTERY_ID,
  generateDataset,
  parseSeed,
} from '../../scripts/seedGenerator';
import { hasEmptyPassportField } from '../../src/core/confidence';
import { addDays, datePart } from '../../src/core/dates';
import { designateServicePartner } from '../../src/core/nudges';
import { recommendPathway } from '../../src/core/pathway';
import { storeSchema } from '../../src/core/schemas';
import { consentStatus, currentHolder, fallingSohTrend, recentFault, safetyFlag } from '../../src/core/telemetry';
import type { DigitalTwin, Pathway, Role, Store } from '../../src/core/types';

const RUN_DATE = '2025-06-15';
const SEEDS = [DEFAULT_SEED, 42, -7, 123456789, 2 ** 40 + 3];
const RUN_DATES = [RUN_DATE, '2024-02-29', '2025-12-31'];

const twinsOf = (s: Store): DigitalTwin[] => Object.values(s.twins);
const holderRole = (t: DigitalTwin) => currentHolder(t.custodyLog)!.toHolderRole;

/** Every dataset under test: several seeds × run dates. */
const cases: Array<[number, string, Store]> = SEEDS.flatMap((seed) =>
  RUN_DATES.map((d) => [seed, d, generateDataset(seed, d)] as [number, string, Store]),
);

describe('parseSeed', () => {
  it('defaults to DEFAULT_SEED when not supplied', () => {
    expect(parseSeed(undefined)).toEqual({ ok: true, value: DEFAULT_SEED });
  });
  it('accepts decimal integers', () => {
    expect(parseSeed('42')).toEqual({ ok: true, value: 42 });
    expect(parseSeed('-3')).toEqual({ ok: true, value: -3 });
  });
  it.each(['', 'abc', '1.5', '1e3', '0x10', '99999999999999999999'])('rejects %j', (arg) => {
    const r = parseSeed(arg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid seed value/);
  });
});

describe('generateDataset determinism (Req 2.8, 2.11)', () => {
  it.each([DEFAULT_SEED, 42, 7])('same seed and run date give identical stores (seed %s)', (seed) => {
    expect(generateDataset(seed, RUN_DATE)).toEqual(generateDataset(seed, RUN_DATE));
  });
  it('different seeds vary values but keep the same battery IDs', () => {
    const a = generateDataset(1, RUN_DATE);
    const b = generateDataset(2, RUN_DATE);
    expect(Object.keys(a.twins)).toEqual(Object.keys(b.twins));
    expect(a).not.toEqual(b);
  });
  it('rejects invalid inputs', () => {
    expect(() => generateDataset(1.5, RUN_DATE)).toThrow(/Invalid seed/);
    expect(() => generateDataset(1, '2025-02-30')).toThrow(/Invalid run date/);
  });
});

describe.each(cases)('seed %s, run date %s', (_seed, runDate, store) => {
  const twins = twinsOf(store);

  it('passes the store schema and has dates no later than the run date', () => {
    const parsed = storeSchema(runDate).safeParse(store);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
    for (const t of twins) {
      for (const r of t.telemetry) expect(datePart(r.timestamp) <= runDate).toBe(true);
      for (const e of t.custodyLog) expect(e.date <= runDate).toBe(true);
      for (const c of t.consentEvents) expect(datePart(c.at) <= runDate).toBe(true);
    }
  });

  it('has 45–55 uniquely identified twins, with ≥3 manufacturers and chemistries on ≥3 twins each (Req 2.1, 2.2)', () => {
    expect(twins.length).toBeGreaterThanOrEqual(45);
    expect(twins.length).toBeLessThanOrEqual(55);
    expect(new Set(twins.map((t) => t.passport.batteryId)).size).toBe(twins.length);
    const count = (key: 'manufacturer' | 'chemistry') => {
      const m = new Map<string, number>();
      for (const t of twins) if (t.passport[key] !== '') m.set(t.passport[key], (m.get(t.passport[key]) ?? 0) + 1);
      return [...m.values()].filter((n) => n >= 3).length;
    };
    expect(count('manufacturer')).toBeGreaterThanOrEqual(3);
    expect(count('chemistry')).toBeGreaterThanOrEqual(3);
  });

  it('covers every Pathway at least 3 times on the run date (Req 2.3)', () => {
    const counts: Record<Pathway, number> = { Continue_Use: 0, Inspect_Repair: 0, Second_Life_Review: 0, Certified_Recycling: 0 };
    for (const t of twins) counts[recommendPathway(t, runDate).pathway] += 1;
    for (const n of Object.values(counts)) expect(n).toBeGreaterThanOrEqual(3);
  });

  it('has a fleet of ≥10 and holders of every holder role (Req 2.4)', () => {
    const fleet = twins.filter((t) => currentHolder(t.custodyLog)!.toHolderId === MAIN_FLEET_OPERATOR_ID);
    expect(fleet.length).toBeGreaterThanOrEqual(10);
    const roles = new Set(twins.map(holderRole));
    for (const r of ['Owner', 'Service_Partner', 'Second_Life_Provider', 'Recycler'] as const) expect(roles.has(r)).toBe(true);
  });

  it('meets the Consent, EOL, and missing-record coverage (Req 2.5)', () => {
    const ownerHeld = twins.filter((t) => holderRole(t) === 'Owner');
    const ratio = ownerHeld.filter((t) => consentStatus(t) === 'granted').length / ownerHeld.length;
    expect(ratio).toBeGreaterThanOrEqual(0.5);
    expect(ratio).toBeLessThanOrEqual(0.7);
    const fleet = twins.filter((t) => currentHolder(t.custodyLog)!.toHolderId === MAIN_FLEET_OPERATOR_ID);
    expect(fleet.every((t) => t.dataOwner.id === MAIN_FLEET_OPERATOR_ID && consentStatus(t) === 'granted')).toBe(true);
    expect(twins.filter((t) => t.endOfLife).length).toBeGreaterThanOrEqual(5);
    expect(twins.filter((t) => !t.endOfLife).length).toBeGreaterThanOrEqual(5);
    const missing = twins.filter(
      (t) => t.telemetry.length === 0 || t.chargingHistory.length === 0 || t.serviceHistory.length === 0 || hasEmptyPassportField(t.passport),
    );
    expect(missing.length).toBeGreaterThanOrEqual(5);
  });

  it('has routed second-life and recycling twins, and located stakeholders (Req 2.6, 13.3)', () => {
    expect(twins.some((t) => t.routedPathway === 'Second_Life_Review' && holderRole(t) === 'Second_Life_Provider')).toBe(true);
    expect(twins.some((t) => t.routedPathway === 'Certified_Recycling' && holderRole(t) === 'Recycler')).toBe(true);
    const roles: Role[] = ['Owner', 'Fleet_Operator', 'Service_Partner', 'Second_Life_Provider', 'Recycler', 'ESG_Officer'];
    for (const r of roles) expect(store.stakeholders.some((s) => s.role === r)).toBe(true);
    for (const s of store.stakeholders) {
      expect(s.location.city).not.toBe('');
      expect(s.location.state).not.toBe('');
    }
    const spStates = new Set(store.stakeholders.filter((s) => s.role === 'Service_Partner').map((s) => s.location.state));
    expect(spStates.size).toBeGreaterThanOrEqual(2);
    for (const s of store.stakeholders.filter((x) => x.role === 'ESG_Officer')) expect(s.manufacturer).toBeTruthy();
  });

  it('keeps SoH in range and non-increasing except across module replacement (Req 2.10)', () => {
    for (const t of twins) {
      const rs = [...t.telemetry].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
      for (let i = 0; i < rs.length; i++) {
        expect(rs[i]!.sohPct).toBeGreaterThanOrEqual(0);
        expect(rs[i]!.sohPct).toBeLessThanOrEqual(100);
        if (i > 0 && rs[i]!.sohPct > rs[i - 1]!.sohPct) {
          const from = datePart(rs[i - 1]!.timestamp);
          const to = datePart(rs[i]!.timestamp);
          const replaced = t.serviceHistory.some((s) => s.modulesReplaced.length > 0 && s.date >= from && s.date <= to);
          expect(replaced, `${t.passport.batteryId} SoH rose without module replacement`).toBe(true);
        }
      }
    }
  });

  it('grants Data_Owner Consent before a second-life twin leaves its Data_Owner (Req 2.14)', () => {
    const applicable = twins.filter((t) => t.routedPathway === 'Second_Life_Review' || holderRole(t) === 'Second_Life_Provider');
    expect(applicable.length).toBeGreaterThan(0);
    for (const t of applicable) {
      const leave = t.custodyLog.find((e) => e.fromHolderId === t.dataOwner.id);
      expect(leave).toBeDefined();
      const owned = t.consentEvents.filter((c) => c.byId === t.dataOwner.id && datePart(c.at) <= leave!.date);
      const lastGrant = owned.map((c, i) => [c, i] as const).filter(([c]) => c.type === 'grant').pop();
      expect(lastGrant, t.passport.batteryId).toBeDefined();
      expect(owned.slice(lastGrant![1] + 1).some((c) => c.type === 'withdraw')).toBe(false);
    }
  });

  it('seeds the demo battery in its walkthrough start state (Req 2.7, 14.6)', () => {
    const demo = twins.filter((t) => t.passport.batteryId === DEMO_BATTERY_ID);
    expect(demo).toHaveLength(1);
    const t = demo[0]!;
    expect(currentHolder(t.custodyLog)).toMatchObject({ toHolderRole: 'Owner', toHolderId: DEMO_OWNER_ID });
    expect(consentStatus(t)).toBe('not_granted');
    expect(t.endOfLife).toBeNull();
    expect(t.routedPathway).toBeNull();
    expect(t.returnRecords).toEqual([]);
    expect(t.custodyLog.some((e) => ['Service_Partner', 'Second_Life_Provider', 'Recycler'].includes(e.toHolderRole))).toBe(false);
    expect(safetyFlag(t, runDate)).toBe(false);
    expect(recentFault(t, runDate)).toBeUndefined();
    expect(recommendPathway(t, runDate).pathway).toBe('Second_Life_Review');
    expect(t.passport.manufacturer).toBe(DEMO_MANUFACTURER);
    const incentive = t.nudges.find((n) => n.type === 'Return_Incentive');
    expect(incentive?.type === 'Return_Incentive' && incentive.returnOffer.servicePartnerId).toBe(DEMO_SERVICE_PARTNER_ID);
  });

  it('has Owner-held twins with a backdated and a fresh Service_Prompt, and nudges only for Owner holders (Req 7.16)', () => {
    const prompts = twins
      .filter((t) => holderRole(t) === 'Owner')
      .flatMap((t) => t.nudges.filter((n) => n.type === 'Service_Prompt').map((n) => ({ n, t })));
    expect(prompts.some(({ n }) => n.createdOn < addDays(runDate, -30))).toBe(true);
    expect(prompts.some(({ n }) => n.createdOn === runDate)).toBe(true);
    for (const { t } of prompts) expect(fallingSohTrend(t, runDate)).toBeDefined();
    for (const t of twins.filter((x) => holderRole(x) !== 'Owner')) expect(t.nudges).toEqual([]);
  });
});

describe('named seed identities', () => {
  const store = generateDataset(DEFAULT_SEED, RUN_DATE);
  const byId = (id: string) => store.stakeholders.find((s) => s.id === id);

  it('exports identities that exist with the right roles', () => {
    expect(byId(DEMO_OWNER_ID)?.role).toBe('Owner');
    expect(byId(DEMO_SERVICE_PARTNER_ID)?.role).toBe('Service_Partner');
    expect(byId(DEMO_SECOND_LIFE_PROVIDER_ID)?.role).toBe('Second_Life_Provider');
    expect(byId(DEMO_RECYCLER_ID)?.role).toBe('Recycler');
    expect(byId(DEMO_ESG_OFFICER_ID)).toMatchObject({ role: 'ESG_Officer', manufacturer: DEMO_MANUFACTURER });
    expect(byId(EMPTY_OWNER_ID)?.role).toBe('Owner');
  });

  it('designates DEMO_SERVICE_PARTNER_ID for the demo Owner (Req 7.17)', () => {
    const sps = store.stakeholders.filter((s) => s.role === 'Service_Partner');
    expect(designateServicePartner(byId(DEMO_OWNER_ID)!, sps).id).toBe(DEMO_SERVICE_PARTNER_ID);
  });

  it('has a flagged and an unflagged FLT-001 battery for the fleet handover scenario', () => {
    const flagged = store.twins[FLAGGED_FLEET_BATTERY_ID]!;
    expect(currentHolder(flagged.custodyLog)?.toHolderId).toBe(MAIN_FLEET_OPERATOR_ID);
    expect(flagged.inspectionFlags.at(-1)?.servicePartnerId).toBe(FLAGGED_FLEET_SERVICE_PARTNER_ID);
    const unflagged = store.twins[UNFLAGGED_FLEET_BATTERY_ID]!;
    expect(currentHolder(unflagged.custodyLog)?.toHolderId).toBe(MAIN_FLEET_OPERATOR_ID);
    expect(unflagged.inspectionFlags).toEqual([]);
  });

  it('gives EMPTY_OWNER_ID no held and no returned batteries', () => {
    const twins = twinsOf(store);
    expect(twins.some((t) => currentHolder(t.custodyLog)?.toHolderId === EMPTY_OWNER_ID)).toBe(false);
    expect(twins.some((t) => t.returnRecords.some((r) => r.ownerId === EMPTY_OWNER_ID))).toBe(false);
  });

  it('keeps Owner ids and names out of all non-Owner identity text (ESG guard compatibility)', () => {
    const owners = store.stakeholders.filter((s) => s.role === 'Owner');
    const others = JSON.stringify(store.stakeholders.filter((s) => s.role !== 'Owner')) + JSON.stringify(Object.keys(store.twins));
    for (const o of owners) {
      expect(others.includes(o.id)).toBe(false);
      expect(others.includes(o.name)).toBe(false);
    }
  });
});
