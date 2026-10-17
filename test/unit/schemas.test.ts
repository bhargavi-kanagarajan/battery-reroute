import { describe, expect, it } from 'vitest';
import {
  SAFETY_CRITICAL_FAULT_CODES,
  assertAppendOnlyChanges,
  digitalTwinSchema,
  formatZodErrors,
  isValidIsoDate,
  seededDigitalTwinSchema,
  serviceRecordSchema,
  validate,
} from '../../src/core/schemas';
import type { DigitalTwin } from '../../src/core/types';

const WRITE_DATE = '2025-06-01';

function baseTwin(): DigitalTwin {
  return {
    passport: {
      batteryId: 'BR-0001',
      chemistry: 'NMC',
      capacityKwh: 75,
      packMassKg: 450,
      manufactureDate: '2021-03-15',
      manufacturer: 'Volt Motors',
      embeddedCarbonKgCo2e: 6000,
      recycledContentPct: 12,
    },
    modules: [
      { moduleId: 'M1', condition: 'Good' },
      { moduleId: 'M2', condition: 'Degraded' },
    ],
    telemetry: [{ timestamp: '2025-05-01T00:00:00.000Z', sohPct: 88, cycleCount: 500, thermalEventCount: 0 }],
    chargingHistory: [{ date: '2025-05-02', energyKwh: 40, chargeType: 'AC', ambientTempC: 20 }],
    serviceHistory: [{ date: '2024-01-01', faultCode: '', actionTaken: 'Annual check', modulesReplaced: [] }],
    custodyLog: [{ date: '2021-04-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [{ type: 'grant', at: '2025-01-01T10:00:00.000Z', byId: 'OWN-001' }],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

const schema = digitalTwinSchema({ writeDate: WRITE_DATE });

function fieldsOf(value: unknown): string[] {
  const r = validate(schema, value);
  return r.ok ? [] : (r.error.fields ?? []).map((f) => f.field).sort();
}

describe('digitalTwinSchema', () => {
  it('accepts a valid twin', () => {
    expect(schema.safeParse(baseTwin()).success).toBe(true);
  });

  it('names every invalid field with a dotted path', () => {
    const t = baseTwin() as any;
    t.passport.capacityKwh = 0;
    t.passport.recycledContentPct = 101;
    t.telemetry[0].sohPct = 120;
    t.telemetry[0].cycleCount = -1;
    t.chargingHistory[0].chargeType = 'Wireless';
    t.chargingHistory[0].energyKwh = -5;
    expect(fieldsOf(t)).toEqual(
      [
        'chargingHistory.0.chargeType',
        'chargingHistory.0.energyKwh',
        'passport.capacityKwh',
        'passport.recycledContentPct',
        'telemetry.0.cycleCount',
        'telemetry.0.sohPct',
      ].sort(),
    );
  });

  it('enforces passport ranges and the write date', () => {
    const t = baseTwin() as any;
    t.passport.capacityKwh = 500.1;
    t.passport.packMassKg = 0;
    t.passport.manufactureDate = '2025-06-02';
    t.passport.batteryId = 'x'.repeat(65);
    t.passport.manufacturer = '';
    t.passport.embeddedCarbonKgCo2e = -1;
    expect(fieldsOf(t)).toEqual(
      [
        'passport.batteryId',
        'passport.capacityKwh',
        'passport.embeddedCarbonKgCo2e',
        'passport.manufactureDate',
        'passport.manufacturer',
        'passport.packMassKg',
      ].sort(),
    );
    const edge = baseTwin();
    edge.passport.capacityKwh = 500;
    edge.passport.manufactureDate = WRITE_DATE;
    expect(schema.safeParse(edge).success).toBe(true);
  });

  it('reports missing required fields', () => {
    const t = baseTwin() as any;
    delete t.passport.chemistry;
    delete t.modules;
    expect(fieldsOf(t)).toEqual(['modules', 'passport.chemistry']);
  });

  it('enforces modules >= 1, custody >= 1 with holder roles, and EOL masses >= 0', () => {
    const t = baseTwin() as any;
    t.modules = [];
    t.custodyLog = [];
    t.endOfLife = { pathway: 'Certified_Recycling', date: '2025-05-01', receivingPartyId: 'RC-1', materialsRecoveredKg: { cobalt: -1 } };
    expect(fieldsOf(t)).toEqual(['custodyLog', 'endOfLife.materialsRecoveredKg.cobalt', 'modules']);

    const u = baseTwin() as any;
    u.custodyLog[0].toHolderRole = 'ESG_Officer';
    expect(fieldsOf(u)).toEqual(['custodyLog.0.toHolderRole']);
  });

  it('enforces temperature, integer counts, and fault code length', () => {
    const t = baseTwin() as any;
    t.chargingHistory[0].ambientTempC = 61;
    t.telemetry[0].thermalEventCount = 1.5;
    t.serviceHistory[0].faultCode = 'F'.repeat(33);
    expect(fieldsOf(t)).toEqual(
      ['chargingHistory.0.ambientTempC', 'serviceHistory.0.faultCode', 'telemetry.0.thermalEventCount'].sort(),
    );
  });
});

describe('seeded variant and service records', () => {
  it('allows empty passport strings and empty action text only when seeded', () => {
    const t = baseTwin();
    t.passport.chemistry = '';
    t.passport.manufacturer = '';
    t.passport.manufactureDate = '';
    t.serviceHistory[0]!.actionTaken = '';
    expect(seededDigitalTwinSchema(WRITE_DATE).safeParse(t).success).toBe(true);
    expect(fieldsOf(t)).toEqual(
      ['passport.chemistry', 'passport.manufactureDate', 'passport.manufacturer', 'serviceHistory.0.actionTaken'].sort(),
    );
  });

  it('logged action text must be 1 to 500 characters', () => {
    const s = serviceRecordSchema();
    const rec = { date: '2025-01-01', faultCode: '', actionTaken: 'a'.repeat(500), modulesReplaced: [] };
    expect(s.safeParse(rec).success).toBe(true);
    expect(s.safeParse({ ...rec, actionTaken: 'a'.repeat(501) }).success).toBe(false);
    expect(s.safeParse({ ...rec, actionTaken: '' }).success).toBe(false);
  });
});

describe('helpers', () => {
  it('isValidIsoDate checks real calendar dates', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2023-02-29')).toBe(false);
    expect(isValidIsoDate('2024-13-01')).toBe(false);
    expect(isValidIsoDate('2024-1-01')).toBe(false);
  });

  it('formatZodErrors uses (root) for top-level issues', () => {
    const r = schema.safeParse(null);
    expect(r.success).toBe(false);
    if (!r.success) expect(formatZodErrors(r.error)[0]?.field).toBe('(root)');
  });

  it('exports the safety-critical fault codes', () => {
    expect([...SAFETY_CRITICAL_FAULT_CODES]).toEqual([
      'THERMAL_RUNAWAY',
      'CELL_VENTING',
      'INTERNAL_SHORT',
      'ISOLATION_FAULT',
      'BMS_OVERTEMP',
    ]);
  });
});

describe('assertAppendOnlyChanges', () => {
  it('accepts appends to every append-only list', () => {
    const before = baseTwin();
    const after = structuredClone(before);
    after.custodyLog.push({ date: '2025-05-10', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' });
    after.consentEvents.push({ type: 'withdraw', at: '2025-05-11T00:00:00.000Z', byId: 'OWN-001' });
    after.inspectionFlags.push({ flagDate: '2025-05-12', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-001' });
    after.telemetry = [];
    expect(assertAppendOnlyChanges(before, after)).toEqual({ ok: true, value: true });
  });

  it('rejects modified or removed custody entries with CUSTODY_APPEND_ONLY', () => {
    const before = baseTwin();
    const modified = structuredClone(before);
    modified.custodyLog[0]!.toHolderId = 'OWN-002';
    const r1 = assertAppendOnlyChanges(before, modified);
    expect(r1.ok).toBe(false);
    if (!r1.ok) {
      expect(r1.error.code).toBe('CUSTODY_APPEND_ONLY');
      expect(r1.error.fields?.map((f) => f.field)).toEqual(['custodyLog.0']);
    }
    const removed = structuredClone(before);
    removed.custodyLog = [];
    const r2 = assertAppendOnlyChanges(before, removed);
    expect(!r2.ok && r2.error.code).toBe('CUSTODY_APPEND_ONLY');
  });

  it('rejects changes to consent events and return records', () => {
    const before = baseTwin();
    before.returnRecords.push({
      batteryId: 'BR-0001',
      ownerId: 'OWN-001',
      offerId: 'BR-0001:OWN-001:return',
      returnDate: '2025-05-20',
      servicePartnerId: 'SP-001',
      servicePartnerName: 'Alpha Service',
      finalImpactScore: 50,
      components: { charging: false, servicing: false, consent: true, return: true },
    });
    const after = structuredClone(before) as any;
    after.consentEvents[0].type = 'withdraw';
    after.returnRecords[0].finalImpactScore = 75;
    const r = assertAppendOnlyChanges(before, after);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('VALIDATION_ERROR');
      expect(r.error.fields?.map((f) => f.field)).toEqual(['consentEvents.0', 'returnRecords.0']);
    }
  });
});
