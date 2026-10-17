import { describe, expect, it } from 'vitest';
import { designateServicePartner, nudgeConditions, reconcileNudges } from '../../src/core/nudges';
import type { DigitalTwin, Stakeholder } from '../../src/core/types';

const EVAL = '2024-06-01';

const owner: Stakeholder = { id: 'OWN-001', role: 'Owner', name: 'Pat Owner', location: { city: 'Austin', state: 'TX' } };
const spTxB: Stakeholder = { id: 'SP-002', role: 'Service_Partner', name: 'Bravo Service', location: { city: 'Dallas', state: 'TX' } };
const spTxA: Stakeholder = { id: 'SP-003', role: 'Service_Partner', name: 'alpha Service', location: { city: 'Houston', state: 'TX' } };
const spCa: Stakeholder = { id: 'SP-001', role: 'Service_Partner', name: 'Aaron Repairs', location: { city: 'Fresno', state: 'CA' } };

/** Owner-held, SoH 78 → 75 within 180 days (Second_Life_Review), FCS 60%. */
function twin(overrides: Partial<DigitalTwin> = {}): DigitalTwin {
  return {
    passport: {
      batteryId: 'BR-0001',
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2020-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [
      { timestamp: '2024-01-01T00:00:00Z', sohPct: 78, cycleCount: 800, thermalEventCount: 0 },
      { timestamp: '2024-05-01T00:00:00Z', sohPct: 75, cycleCount: 900, thermalEventCount: 0 },
    ],
    chargingHistory: [
      { date: '2024-02-01', energyKwh: 30, chargeType: 'DC_Fast', ambientTempC: 20 },
      { date: '2024-03-01', energyKwh: 20, chargeType: 'AC', ambientTempC: 20 },
    ],
    serviceHistory: [{ date: '2023-01-01', faultCode: '', actionTaken: 'check', modulesReplaced: [] }],
    custodyLog: [{ date: '2020-02-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
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

const sps = [spTxB, spCa, spTxA];

describe('designateServicePartner', () => {
  it('picks the alphabetically first same-state SP, case-insensitively', () => {
    expect(designateServicePartner(owner, sps).id).toBe('SP-003');
    expect(designateServicePartner(owner, [...sps].reverse()).id).toBe('SP-003');
  });

  it('falls back to the alphabetically first SP overall', () => {
    const ny = { ...owner, location: { city: 'Albany', state: 'NY' } };
    expect(designateServicePartner(ny, sps).id).toBe('SP-001');
  });
});

describe('nudgeConditions', () => {
  it('generates all three nudges with formatted messages', () => {
    const conds = nudgeConditions(twin(), EVAL, owner, sps);
    expect(conds.map((c) => c.type)).toEqual(['Charging_Guidance', 'Service_Prompt', 'Return_Incentive']);
    expect(conds[0]!.message).toContain('60%');
    expect(conds[1]!.message).toContain('3.0 percentage points');
    const ri = conds[2]!;
    expect(ri.type === 'Return_Incentive' && ri.returnOffer).toEqual({
      offerId: 'BR-0001:OWN-001:return',
      servicePartnerId: 'SP-003',
      servicePartnerName: 'alpha Service',
    });
  });

  it('generates nothing when the Current_Holder is not an Owner', () => {
    const t = twin({
      custodyLog: [
        { date: '2020-02-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' },
        { date: '2024-05-02', fromHolderId: 'OWN-001', toHolderId: 'SP-003', toHolderRole: 'Service_Partner' },
      ],
    });
    expect(nudgeConditions(t, EVAL, owner, sps)).toEqual([]);
  });

  it('omits Charging_Guidance at exactly 40% and with no sessions', () => {
    const at40 = twin({
      chargingHistory: [
        { date: '2024-02-01', energyKwh: 40, chargeType: 'DC_Fast', ambientTempC: 20 },
        { date: '2024-03-01', energyKwh: 60, chargeType: 'AC', ambientTempC: 20 },
      ],
    });
    expect(nudgeConditions(at40, EVAL, owner, sps).some((c) => c.type === 'Charging_Guidance')).toBe(false);
    expect(nudgeConditions(twin({ chargingHistory: [] }), EVAL, owner, sps).some((c) => c.type === 'Charging_Guidance')).toBe(false);
  });

  it('omits Return_Incentive for Continue_Use and when a ReturnRecord exists', () => {
    const healthy = twin({
      telemetry: [{ timestamp: '2024-05-01T00:00:00Z', sohPct: 92, cycleCount: 100, thermalEventCount: 0 }],
    });
    expect(nudgeConditions(healthy, EVAL, owner, sps).some((c) => c.type === 'Return_Incentive')).toBe(false);
    const returned = twin({
      returnRecords: [
        {
          batteryId: 'BR-0001',
          ownerId: 'OWN-001',
          offerId: 'BR-0001:OWN-001:return',
          returnDate: '2024-05-20',
          servicePartnerId: 'SP-003',
          servicePartnerName: 'alpha Service',
          finalImpactScore: 50,
          components: { charging: false, servicing: true, consent: false, return: true },
        },
      ],
    });
    expect(nudgeConditions(returned, EVAL, owner, sps).some((c) => c.type === 'Return_Incentive')).toBe(false);
  });
});

describe('reconcileNudges', () => {
  it('creates nudges dated evalDate and is idempotent', () => {
    const first = reconcileNudges(twin(), EVAL, owner, sps);
    expect(first.every((n) => n.createdOn === EVAL)).toBe(true);
    const again = reconcileNudges(twin({ nudges: first }), EVAL, owner, sps);
    expect(again).toEqual(first);
  });

  it('retains createdOn and the original Return_Offer on later evaluations', () => {
    const first = reconcileNudges(twin(), '2024-05-15', owner, sps);
    // A new same-state SP that would now sort first must not replace the issued offer.
    const newSp: Stakeholder = { id: 'SP-000', role: 'Service_Partner', name: 'Aardvark', location: { city: 'Waco', state: 'TX' } };
    const later = reconcileNudges(twin({ nudges: first }), EVAL, owner, [...sps, newSp]);
    expect(later.map((n) => n.createdOn)).toEqual(['2024-05-15', '2024-05-15', '2024-05-15']);
    const ri = later.find((n) => n.type === 'Return_Incentive');
    expect(ri?.type === 'Return_Incentive' && ri.returnOffer.servicePartnerId).toBe('SP-003');
  });

  it('drops nudges whose condition no longer holds', () => {
    const first = reconcileNudges(twin(), EVAL, owner, sps);
    const acOnly = twin({
      nudges: first,
      chargingHistory: [{ date: '2024-02-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
    });
    expect(reconcileNudges(acOnly, EVAL, owner, sps).map((n) => n.type)).toEqual(['Service_Prompt', 'Return_Incentive']);
  });

  it('does not mutate its input', () => {
    const t = twin();
    const snapshot = structuredClone(t);
    reconcileNudges(t, EVAL, owner, sps);
    expect(t).toEqual(snapshot);
  });
});
