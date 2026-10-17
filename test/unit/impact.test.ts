import { describe, expect, it } from 'vitest';
import { finalImpact, impactComponents, impactScore } from '../../src/core/impact';
import type { ChargingSession, DigitalTwin, Nudge, ReturnRecord } from '../../src/core/types';

const EVAL = '2025-06-30';
const OWNER = 'OWN-001';

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
    telemetry: [],
    chargingHistory: [],
    serviceHistory: [],
    custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: OWNER, toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: OWNER, role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
    ...overrides,
  };
}

function sessions(fastPct: number): ChargingSession[] {
  return [
    { date: '2025-06-01', energyKwh: fastPct, chargeType: 'DC_Fast', ambientTempC: 20 },
    { date: '2025-06-02', energyKwh: 100 - fastPct, chargeType: 'AC', ambientTempC: 20 },
  ];
}

const servicePrompt = (createdOn: string): Nudge => ({ type: 'Service_Prompt', createdOn, message: 'x' });
const returnIncentive: Nudge = {
  type: 'Return_Incentive',
  createdOn: EVAL,
  message: 'x',
  returnOffer: { offerId: `BR-0001:${OWNER}:return`, servicePartnerId: 'SP-001', servicePartnerName: 'Acme' },
};
const grant = [{ type: 'grant' as const, at: '2025-01-01T00:00:00Z', byId: OWNER }];

describe('impactComponents', () => {
  it('earns charging, servicing, and return with no history, nudges, or offer; consent not granted', () => {
    const c = impactComponents(twin(), EVAL, OWNER);
    expect(c).toEqual({ charging: true, servicing: true, consent: false, return: true });
    expect(impactScore(c)).toBe(75);
  });

  it('charging: 40% earned, 41% not earned; sessions after evalDate ignored', () => {
    expect(impactComponents(twin({ chargingHistory: sessions(40) }), EVAL, OWNER).charging).toBe(true);
    expect(impactComponents(twin({ chargingHistory: sessions(41) }), EVAL, OWNER).charging).toBe(false);
    const late: ChargingSession = { date: '2025-07-01', energyKwh: 1000, chargeType: 'DC_Fast', ambientTempC: 20 };
    expect(impactComponents(twin({ chargingHistory: [...sessions(10), late] }), EVAL, OWNER).charging).toBe(true);
  });

  it('servicing: prompt created 30 days earlier is earned, 31 days is not', () => {
    expect(impactComponents(twin({ nudges: [servicePrompt('2025-05-31')] }), EVAL, OWNER).servicing).toBe(true);
    expect(impactComponents(twin({ nudges: [servicePrompt('2025-05-30')] }), EVAL, OWNER).servicing).toBe(false);
  });

  it('consent follows the last consent event', () => {
    expect(impactComponents(twin({ consentEvents: grant }), EVAL, OWNER).consent).toBe(true);
    const withdrawn = [...grant, { type: 'withdraw' as const, at: '2025-02-01T00:00:00Z', byId: OWNER }];
    expect(impactComponents(twin({ consentEvents: withdrawn }), EVAL, OWNER).consent).toBe(false);
  });

  it('return: lost with an active Return_Incentive, earned once a ReturnRecord exists for the owner', () => {
    expect(impactComponents(twin({ nudges: [returnIncentive] }), EVAL, OWNER).return).toBe(false);
    const record: ReturnRecord = {
      batteryId: 'BR-0001',
      ownerId: OWNER,
      offerId: `BR-0001:${OWNER}:return`,
      returnDate: '2025-06-01',
      servicePartnerId: 'SP-001',
      servicePartnerName: 'Acme',
      finalImpactScore: 50,
      components: { charging: true, servicing: false, consent: false, return: true },
    };
    const t = twin({ nudges: [returnIncentive], returnRecords: [record] });
    expect(impactComponents(t, EVAL, OWNER).return).toBe(true);
    expect(impactComponents(t, EVAL, 'OWN-999').return).toBe(false);
  });

  it('is deterministic and does not mutate the twin', () => {
    const t = twin({ chargingHistory: sessions(60), nudges: [servicePrompt('2025-01-01'), returnIncentive] });
    const before = structuredClone(t);
    const a = impactComponents(t, EVAL, OWNER);
    expect(impactComponents(t, EVAL, OWNER)).toEqual(a);
    expect(impactScore(a)).toBe(0);
    expect(t).toEqual(before);
  });
});

describe('finalImpact', () => {
  it('forces return to earned, so the minimum is 25', () => {
    const t = twin({ chargingHistory: sessions(60), nudges: [servicePrompt('2025-01-01'), returnIncentive] });
    expect(finalImpact(t, EVAL, OWNER)).toEqual({
      finalImpactScore: 25,
      components: { charging: false, servicing: false, consent: false, return: true },
    });
  });

  it('is 100 when every pre-handover component is earned', () => {
    const t = twin({ consentEvents: grant, nudges: [returnIncentive] });
    expect(finalImpact(t, EVAL, OWNER).finalImpactScore).toBe(100);
  });
});
