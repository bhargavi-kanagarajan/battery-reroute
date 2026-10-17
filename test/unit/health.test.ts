import { describe, expect, it } from 'vitest';
import { evaluateHealth, MAX_CYCLES, MAX_MONTHS } from '../../src/core/health';
import type { DigitalTwin, TelemetryReading } from '../../src/core/types';

const EVAL = '2025-01-15';

function reading(timestamp: string, sohPct: number, cycleCount: number, thermalEventCount = 0): TelemetryReading {
  return { timestamp, sohPct, cycleCount, thermalEventCount };
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
    telemetry: [reading('2024-01-01T00:00:00Z', 95, 100), reading('2025-01-01T00:00:00Z', 90, 300)],
    chargingHistory: [
      { date: '2024-06-01', energyKwh: 30, chargeType: 'DC_Fast', ambientTempC: 20 },
      { date: '2024-07-01', energyKwh: 70, chargeType: 'AC', ambientTempC: 20 },
    ],
    serviceHistory: [{ date: '2024-01-01', faultCode: '', actionTaken: 'check', modulesReplaced: [] }],
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

describe('evaluateHealth', () => {
  it('computes a hand-checked score, factors, and Remaining_Life', () => {
    const r = evaluateHealth(twin(), EVAL);
    if (!r.ok) throw new Error('expected ok');
    // 100 - 10 (SoH 90) - 3 (300 cycles) - 6 (FCS 30%) - 0 = 81
    expect(r.healthScore).toBe(81);
    expect(r.factors).toEqual([
      { name: 'SoH', value: 90, effect: -10 },
      { name: 'CycleCount', value: 300, effect: -3 },
      { name: 'FastChargeShare', value: 30, effect: -6 },
      { name: 'ThermalEvents', value: 0, effect: 0 },
    ]);
    // 5 points over 366 days (≈12.02 months) → 10 points headroom ≈ 24.05 → 24 months
    // 5 points over 200 cycles → 400 cycles
    expect(r.remainingLife).toEqual({ months: 24, cycles: 400 });
    expect(r.dataConfidence).toBe(100);
  });

  it('caps Remaining_Life when the degradation rate is zero', () => {
    const r = evaluateHealth(
      twin({ telemetry: [reading('2024-01-01T00:00:00Z', 85, 100), reading('2025-01-01T00:00:00Z', 85, 100)] }),
      EVAL,
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.remainingLife).toEqual({ months: MAX_MONTHS, cycles: MAX_CYCLES });
  });

  it('reports 0/0 Remaining_Life at or below 80% SoH', () => {
    const r = evaluateHealth(twin({ telemetry: [reading('2025-01-01T00:00:00Z', 80, 1200)] }), EVAL);
    if (!r.ok) throw new Error('expected ok');
    expect(r.remainingLife).toEqual({ months: 0, cycles: 0 });
  });

  it('returns no Remaining_Life with a reason when SoH > 80 and fewer than 2 readings', () => {
    const r = evaluateHealth(twin({ telemetry: [reading('2025-01-01T00:00:00Z', 92, 50)] }), EVAL);
    if (!r.ok) throw new Error('expected ok');
    expect(r.healthScore).toBeTypeOf('number');
    expect(r.remainingLife).toBeNull();
    expect(r.remainingLifeReason).toBe('INSUFFICIENT_TELEMETRY_HISTORY');
  });

  it('returns TELEMETRY_MISSING when no reading is on or before evalDate, without mutating', () => {
    const t = twin({ telemetry: [reading('2025-02-01T00:00:00Z', 90, 300)] });
    const before = structuredClone(t);
    const r = evaluateHealth(t, EVAL);
    expect(r).toEqual({ ok: false, reason: 'TELEMETRY_MISSING', dataConfidence: 100 });
    expect(t).toEqual(before);
  });

  it('ignores readings and sessions after evalDate', () => {
    const base = evaluateHealth(twin(), EVAL);
    const t = twin();
    const later = evaluateHealth(
      {
        ...t,
        telemetry: [...t.telemetry, reading('2025-03-01T00:00:00Z', 70, 900, 3)],
        chargingHistory: [
          ...t.chargingHistory,
          { date: '2025-03-01', energyKwh: 500, chargeType: 'DC_Fast', ambientTempC: 20 },
        ],
      },
      EVAL,
    );
    expect(later).toEqual(base);
  });

  it('gives FastChargeShare an effect of exactly 0 with empty Charging_History', () => {
    const r = evaluateHealth(twin({ chargingHistory: [] }), EVAL);
    if (!r.ok) throw new Error('expected ok');
    const fcs = r.factors.find((f) => f.name === 'FastChargeShare')!;
    expect(Object.is(fcs.effect, 0)).toBe(true);
    expect(r.healthScore).toBe(87);
  });

  it('caps factor effects and clamps the score at 0', () => {
    const r = evaluateHealth(
      twin({
        telemetry: [reading('2025-01-01T00:00:00Z', 5, 9000, 7)],
        chargingHistory: [{ date: '2024-06-01', energyKwh: 10, chargeType: 'DC_Fast', ambientTempC: 20 }],
      }),
      EVAL,
    );
    if (!r.ok) throw new Error('expected ok');
    expect(r.factors.map((f) => f.effect)).toEqual([-95, -15, -15, -20]);
    expect(r.healthScore).toBe(0);
  });
});
