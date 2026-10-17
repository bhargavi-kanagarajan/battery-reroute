import { describe, expect, it } from 'vitest';
import { recommendPathway } from '../../src/core/pathway';
import type { DigitalTwin, ServiceRecord, TelemetryReading } from '../../src/core/types';

const EVAL = '2024-06-30';

function reading(date: string, sohPct: number, thermalEventCount = 0): TelemetryReading {
  return { timestamp: `${date}T00:00:00Z`, sohPct, cycleCount: 100, thermalEventCount };
}

function service(date: string, faultCode: string): ServiceRecord {
  return { date, faultCode, actionTaken: 'check', modulesReplaced: [] };
}

function twin(overrides: Partial<DigitalTwin> = {}): DigitalTwin {
  return {
    passport: {
      batteryId: 'BR-0001',
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2022-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [reading('2024-06-01', 90)],
    chargingHistory: [{ date: '2024-01-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
    serviceHistory: [service('2023-01-01', '')],
    custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
    ...overrides,
  };
}

describe('recommendPathway', () => {
  it('(a) Certified_Recycling for SoH below 60', () => {
    const r = recommendPathway(twin({ telemetry: [reading('2024-06-01', 59.9)] }), EVAL);
    expect(r.pathway).toBe('Certified_Recycling');
    expect(r.decidingRule).toBe('CERTIFIED_RECYCLING');
    expect(r.firedRules).toEqual([{ rule: 'CERTIFIED_RECYCLING', inputs: { soh: 59.9 } }]);
  });

  it('(a) Certified_Recycling for a thermal event even with high SoH', () => {
    const r = recommendPathway(twin({ telemetry: [reading('2024-05-01', 95, 1), reading('2024-06-01', 94)] }), EVAL);
    expect(r.pathway).toBe('Certified_Recycling');
    expect(r.firedRules).toEqual([{ rule: 'CERTIFIED_RECYCLING', inputs: { soh: 94, thermalEvents: 1 } }]);
  });

  it('(a) Certified_Recycling from a safety-critical fault code with no Telemetry', () => {
    const r = recommendPathway(twin({ telemetry: [], serviceHistory: [service('2020-01-01', 'CELL_VENTING')] }), EVAL);
    expect(r.pathway).toBe('Certified_Recycling');
    expect(r.reason).toBeUndefined();
    expect(r.firedRules).toEqual([
      { rule: 'CERTIFIED_RECYCLING', inputs: { safetyCriticalFaultCode: 'CELL_VENTING' } },
    ]);
  });

  it('(b) Inspect_Repair with "Telemetry is missing" when no readings and no Safety_Flag', () => {
    const r = recommendPathway(twin({ telemetry: [] }), EVAL);
    expect(r.pathway).toBe('Inspect_Repair');
    expect(r.decidingRule).toBe('MISSING_TELEMETRY');
    expect(r.reason).toBe('Telemetry is missing');
    expect(r.firedRules).toEqual([{ rule: 'MISSING_TELEMETRY', inputs: { telemetryMissing: true } }]);
  });

  it('(b) ignores readings after evalDate', () => {
    const r = recommendPathway(twin({ telemetry: [reading('2024-07-01', 90)] }), EVAL);
    expect(r.decidingRule).toBe('MISSING_TELEMETRY');
  });

  it('(c) Inspect_Repair for a Recent_Fault at the 90-day boundary', () => {
    const r = recommendPathway(twin({ serviceHistory: [service('2024-04-01', 'P0A80')] }), EVAL);
    expect(r.pathway).toBe('Inspect_Repair');
    expect(r.decidingRule).toBe('INSPECT_REPAIR');
    expect(r.reason).toBeUndefined();
    expect(r.firedRules).toEqual([{ rule: 'INSPECT_REPAIR', inputs: { soh: 90, recentFaultDate: '2024-04-01' } }]);
  });

  it('(d) Continue_Use at SoH 80 with only an old fault', () => {
    const r = recommendPathway(
      twin({ telemetry: [reading('2024-06-01', 80)], serviceHistory: [service('2024-03-31', 'P0A80')] }),
      EVAL,
    );
    expect(r.pathway).toBe('Continue_Use');
    expect(r.firedRules).toEqual([{ rule: 'CONTINUE_USE', inputs: { soh: 80 } }]);
  });

  it('(e) Second_Life_Review for 60 <= SoH < 80', () => {
    expect(recommendPathway(twin({ telemetry: [reading('2024-06-01', 60)] }), EVAL).pathway).toBe(
      'Second_Life_Review',
    );
    const r = recommendPathway(twin({ telemetry: [reading('2024-06-01', 79.9)] }), EVAL);
    expect(r.pathway).toBe('Second_Life_Review');
    expect(r.firedRules).toEqual([{ rule: 'SECOND_LIFE_REVIEW', inputs: { soh: 79.9 } }]);
  });

  it('returns dataConfidence and a separate consentStatus; confidence ignores consent', () => {
    const base = twin({ chargingHistory: [] });
    const granted = twin({
      chargingHistory: [],
      consentEvents: [{ type: 'grant', at: '2024-01-01T00:00:00Z', byId: 'OWN-001' }],
    });
    const a = recommendPathway(base, EVAL);
    const b = recommendPathway(granted, EVAL);
    expect(a.dataConfidence).toBe(80);
    expect(b.dataConfidence).toBe(80);
    expect(a.consentStatus).toBe('not_granted');
    expect(b.consentStatus).toBe('granted');
  });

  it('is deterministic and does not mutate the twin', () => {
    const t = twin();
    const before = structuredClone(t);
    expect(recommendPathway(t, EVAL)).toEqual(recommendPathway(t, EVAL));
    expect(t).toEqual(before);
  });
});
