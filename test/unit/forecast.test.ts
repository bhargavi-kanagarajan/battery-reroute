import { describe, expect, it } from 'vitest';
import { replacementForecast } from '../../src/core/forecast';
import { evaluateHealth } from '../../src/core/health';
import type { DigitalTwin, TelemetryReading } from '../../src/core/types';

const EVAL = '2025-01-15';

function reading(date: string, sohPct: number, cycleCount = 100): TelemetryReading {
  return { timestamp: `${date}T00:00:00Z`, sohPct, cycleCount, thermalEventCount: 0 };
}

function twin(id: string, telemetry: TelemetryReading[]): DigitalTwin {
  return {
    passport: {
      batteryId: id,
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2022-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry,
    chargingHistory: [],
    serviceHistory: [],
    custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: 'FLT-001', toHolderRole: 'Fleet_Operator' }],
    endOfLife: null,
    dataOwner: { id: 'FLT-001', role: 'Fleet_Operator' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

function months(t: DigitalTwin): number | null {
  const h = evaluateHealth(t, EVAL);
  return h.ok && h.remainingLife ? h.remainingLife.months : null;
}

// 0 months (SoH ≤ 80) → Q0
const atThreshold = twin('A', [reading('2024-06-01', 85), reading('2025-01-01', 75, 200)]);
// ~6 months → 2025-07-15 → Q2 offset (2025-Q3)
const sixMonths = twin('B', [reading('2024-07-01', 90), reading('2025-01-01', 85, 200)]);
// 12 months → 2026-01-15 → beyond Q3, capped into the fourth quarter
const twelveMonths = twin('C', [reading('2024-01-01', 90), reading('2025-01-01', 85, 200)]);
// > 12 months → excluded
const longLife = twin('D', [reading('2024-01-01', 90), reading('2025-01-01', 89, 200)]);
// one reading above 80 → no Remaining_Life → excluded
const insufficient = twin('E', [reading('2025-01-01', 90)]);
// no Telemetry → excluded
const noTelemetry = twin('F', []);

describe('replacementForecast', () => {
  it('fixtures produce the intended Remaining_Life months', () => {
    expect(months(atThreshold)).toBe(0);
    expect(months(sixMonths)).toBe(6);
    expect(months(twelveMonths)).toBe(12);
    expect(months(longLife)!).toBeGreaterThan(12);
    expect(months(insufficient)).toBeNull();
    expect(months(noTelemetry)).toBeNull();
  });

  it('returns four zero quarters for an empty fleet, starting with the evalDate quarter', () => {
    expect(replacementForecast([], EVAL)).toEqual([
      { quarter: '2025-Q1', count: 0 },
      { quarter: '2025-Q2', count: 0 },
      { quarter: '2025-Q3', count: 0 },
      { quarter: '2025-Q4', count: 0 },
    ]);
  });

  it('places batteries by evalDate + months, caps at Q4, and excludes unknown or > 12 months', () => {
    const fleet = [atThreshold, sixMonths, twelveMonths, longLife, insufficient, noTelemetry];
    expect(replacementForecast(fleet, EVAL)).toEqual([
      { quarter: '2025-Q1', count: 1 },
      { quarter: '2025-Q2', count: 0 },
      { quarter: '2025-Q3', count: 1 },
      { quarter: '2025-Q4', count: 1 },
    ]);
  });

  it('labels quarters across a year boundary', () => {
    expect(replacementForecast([], '2025-11-30').map((q) => q.quarter)).toEqual([
      '2025-Q4',
      '2026-Q1',
      '2026-Q2',
      '2026-Q3',
    ]);
  });
});
