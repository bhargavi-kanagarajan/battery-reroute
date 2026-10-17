import { describe, expect, it } from 'vitest';
import {
  applicationFit,
  applicationFitFor,
  roundUsableCapacity,
  usableCapacity,
} from '../../src/core/secondLife';
import type { DigitalTwin, TelemetryReading } from '../../src/core/types';

const EVAL = '2025-06-01';

function reading(timestamp: string, sohPct: number, thermalEventCount = 0): TelemetryReading {
  return { timestamp, sohPct, cycleCount: 500, thermalEventCount };
}

function twin(
  capacityKwh: number,
  telemetry: TelemetryReading[],
  faultCode = '',
): Pick<DigitalTwin, 'passport' | 'telemetry' | 'serviceHistory'> {
  return {
    passport: {
      batteryId: 'BR-0001',
      chemistry: 'NMC',
      capacityKwh,
      packMassKg: 400,
      manufactureDate: '2020-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    telemetry,
    serviceHistory: faultCode ? [{ date: '2025-01-01', faultCode, actionTaken: 'x', modulesReplaced: [] }] : [],
  };
}

describe('usableCapacity', () => {
  it('is capacity × SoH / 100, unrounded', () => {
    expect(usableCapacity(60, 75)).toBe(45);
    expect(usableCapacity(13.33, 75)).toBeCloseTo(9.9975, 10);
    expect(roundUsableCapacity(9.9975)).toBe(10);
  });
});

describe('applicationFitFor', () => {
  it('returns both when both thresholds hold', () => {
    expect(applicationFitFor({ capacityKwh: 60, soh: 75, safetyFlag: false })).toEqual([
      'Stationary_Storage',
      'Light_Mobility',
    ]);
  });

  it('returns Stationary_Storage only when SoH is in [60, 70)', () => {
    expect(applicationFitFor({ capacityKwh: 60, soh: 65, safetyFlag: false })).toEqual(['Stationary_Storage']);
  });

  it('returns Light_Mobility only when Usable_Capacity is below 10 kWh', () => {
    expect(applicationFitFor({ capacityKwh: 10, soh: 80, safetyFlag: false })).toEqual(['Light_Mobility']);
  });

  it('compares the unrounded Usable_Capacity (9.9975 is not >= 10)', () => {
    expect(applicationFitFor({ capacityKwh: 13.33, soh: 75, safetyFlag: false })).toEqual(['Light_Mobility']);
  });

  it('includes the boundaries', () => {
    // SoH exactly 60 → Stationary_Storage; SoH exactly 70 → Light_Mobility.
    expect(applicationFitFor({ capacityKwh: 50, soh: 60, safetyFlag: false })).toEqual(['Stationary_Storage']);
    expect(applicationFitFor({ capacityKwh: 10, soh: 70, safetyFlag: false })).toEqual(['Light_Mobility']);
    // Usable_Capacity exactly 10.0 and exactly 2.0.
    expect(applicationFitFor({ capacityKwh: 12.5, soh: 80, safetyFlag: false })).toEqual([
      'Stationary_Storage',
      'Light_Mobility',
    ]);
    expect(applicationFitFor({ capacityKwh: 2.5, soh: 80, safetyFlag: false })).toEqual(['Light_Mobility']);
  });

  it('returns exactly None when neither holds, a Safety_Flag is set, or SoH is unknown', () => {
    expect(applicationFitFor({ capacityKwh: 60, soh: 59.9, safetyFlag: false })).toBe('None');
    expect(applicationFitFor({ capacityKwh: 2, soh: 75, safetyFlag: false })).toBe('None');
    expect(applicationFitFor({ capacityKwh: 60, soh: 75, safetyFlag: true })).toBe('None');
    expect(applicationFitFor({ capacityKwh: 60, soh: undefined, safetyFlag: false })).toBe('None');
  });
});

describe('applicationFit(twin, evalDate)', () => {
  it('uses the latest reading on or before evalDate', () => {
    const t = twin(60, [reading('2025-01-01T00:00:00Z', 75), reading('2025-07-01T00:00:00Z', 50)]);
    expect(applicationFit(t, EVAL)).toEqual(['Stationary_Storage', 'Light_Mobility']);
  });

  it('is None with no Telemetry on or before evalDate', () => {
    expect(applicationFit(twin(60, []), EVAL)).toBe('None');
    expect(applicationFit(twin(60, [reading('2025-07-01T00:00:00Z', 75)]), EVAL)).toBe('None');
  });

  it('is None with a thermal event or a safety-critical fault code', () => {
    expect(applicationFit(twin(60, [reading('2025-01-01T00:00:00Z', 75, 1)]), EVAL)).toBe('None');
    expect(applicationFit(twin(60, [reading('2025-01-01T00:00:00Z', 75)], 'THERMAL_RUNAWAY'), EVAL)).toBe('None');
  });
});
