import { describe, expect, it } from 'vitest';
import { dataConfidence } from '../../src/core/confidence';
import type { DigitalTwin } from '../../src/core/types';

function fullTwin(): DigitalTwin {
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
    telemetry: [{ timestamp: '2024-01-01T00:00:00Z', sohPct: 90, cycleCount: 100, thermalEventCount: 0 }],
    chargingHistory: [{ date: '2024-01-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
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
  };
}

describe('dataConfidence', () => {
  it('is 100 for a complete twin', () => {
    expect(dataConfidence(fullTwin())).toBe(100);
  });

  it('applies each category deduction', () => {
    expect(dataConfidence({ ...fullTwin(), telemetry: [] })).toBe(70);
    expect(dataConfidence({ ...fullTwin(), chargingHistory: [] })).toBe(80);
    expect(dataConfidence({ ...fullTwin(), serviceHistory: [] })).toBe(80);
  });

  it('deducts 15 once for any number of empty passport strings', () => {
    const t = fullTwin();
    expect(dataConfidence({ ...t, passport: { ...t.passport, chemistry: '' } })).toBe(85);
    expect(
      dataConfidence({ ...t, passport: { ...t.passport, chemistry: '', manufacturer: '', manufactureDate: '' } }),
    ).toBe(85);
  });

  it('is 15 when everything is missing', () => {
    const t = fullTwin();
    expect(
      dataConfidence({
        ...t,
        telemetry: [],
        chargingHistory: [],
        serviceHistory: [],
        passport: { ...t.passport, chemistry: '' },
      }),
    ).toBe(15);
  });

  it('is unaffected by consent', () => {
    const t = fullTwin();
    const granted: DigitalTwin = {
      ...t,
      consentEvents: [{ type: 'grant', at: '2024-01-01T00:00:00Z', byId: 'OWN-001' }],
    };
    expect(dataConfidence(granted)).toBe(dataConfidence(t));
  });
});
