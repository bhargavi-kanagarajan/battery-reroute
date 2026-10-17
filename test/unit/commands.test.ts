import { describe, expect, it } from 'vitest';
import {
  acceptReturnOffer,
  appendCustody,
  flagInspection,
  handOverToServicePartner,
  recordConsent,
} from '../../src/core/commands';
import { allowedActions } from '../../src/core/access';
import { consentStatus, currentHolder, isReturnedFor } from '../../src/core/telemetry';
import type { DigitalTwin, Stakeholder, ViewerContext } from '../../src/core/types';

const TODAY = '2025-06-15';

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Owner One', location: { city: 'Fresno', state: 'CA' } },
  { id: 'OWN-002', role: 'Owner', name: 'Owner Two', location: { city: 'Austin', state: 'TX' } },
  { id: 'FLT-001', role: 'Fleet_Operator', name: 'Fleet One', location: { city: 'Reno', state: 'NV' } },
  { id: 'FLT-002', role: 'Fleet_Operator', name: 'Fleet Two', location: { city: 'Reno', state: 'NV' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Bravo Service', location: { city: 'San Jose', state: 'CA' } },
  { id: 'SP-002', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'Reuse Co', location: { city: 'Tempe', state: 'AZ' } },
];

const owner: ViewerContext = { role: 'Owner', identityId: 'OWN-001' };
const otherOwner: ViewerContext = { role: 'Owner', identityId: 'OWN-002' };
const fleet: ViewerContext = { role: 'Fleet_Operator', identityId: 'FLT-001' };
const otherFleet: ViewerContext = { role: 'Fleet_Operator', identityId: 'FLT-002' };
const sp1: ViewerContext = { role: 'Service_Partner', identityId: 'SP-001' };
const esg: ViewerContext = { role: 'ESG_Officer', identityId: 'ESG-001', manufacturer: 'Volt Inc' };

/** Owner-held twin with SoH 70, no safety flag, no recent fault → Second_Life_Review (Return_Offer issued). */
function ownerTwin(): DigitalTwin {
  return {
    passport: {
      batteryId: 'BR-0001',
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2019-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [
      { timestamp: '2025-01-01T00:00:00Z', sohPct: 71, cycleCount: 1200, thermalEventCount: 0 },
      { timestamp: '2025-06-01T00:00:00Z', sohPct: 70, cycleCount: 1300, thermalEventCount: 0 },
    ],
    chargingHistory: [{ date: '2025-05-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
    serviceHistory: [],
    custodyLog: [{ date: '2019-02-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
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

function fleetTwin(): DigitalTwin {
  const t = ownerTwin();
  return {
    ...t,
    passport: { ...t.passport, batteryId: 'BR-FLT-1' },
    custodyLog: [{ date: '2019-02-01', fromHolderId: null, toHolderId: 'FLT-001', toHolderRole: 'Fleet_Operator' }],
    dataOwner: { id: 'FLT-001', role: 'Fleet_Operator' },
  };
}

function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('appendCustody', () => {
  it('appends a handover dated on or after the last entry and makes it Current_Holder', () => {
    const twin = ownerTwin();
    const before = snapshot(twin);
    const r = appendCustody(twin, { date: '2019-02-01', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.twin.custodyLog).toHaveLength(2);
    expect(r.value.twin.custodyLog[0]).toEqual(before.custodyLog[0]);
    expect(currentHolder(r.value.twin.custodyLog)?.toHolderId).toBe('SP-001');
    expect(twin).toEqual(before);
  });

  it('rejects a backdated handover with CUSTODY_APPEND_ONLY', () => {
    const twin = ownerTwin();
    const r = appendCustody(twin, { date: '2019-01-31', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('CUSTODY_APPEND_ONLY');
    expect(twin.custodyLog).toHaveLength(1);
  });

  it('rejects a malformed entry with VALIDATION_ERROR', () => {
    const r = appendCustody(ownerTwin(), { date: '2025-13-01', fromHolderId: 'OWN-001', toHolderId: '', toHolderRole: 'Service_Partner' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('VALIDATION_ERROR');
    expect(r.error.fields?.map((f) => f.field).sort()).toEqual(['date', 'toHolderId']);
  });
});

describe('recordConsent', () => {
  it('Owner Data_Owner grants then withdraws; history is appended in order', () => {
    const twin = ownerTwin();
    const g = recordConsent(twin, owner, 'grant', '2025-06-15T10:00:00Z');
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    expect(g.value.consentStatus).toBe('granted');
    expect(g.value.twin.consentEvents).toEqual([{ type: 'grant', at: '2025-06-15T10:00:00Z', byId: 'OWN-001' }]);
    const w = recordConsent(g.value.twin, owner, 'withdraw', '2025-06-15T11:00:00Z');
    expect(w.ok).toBe(true);
    if (!w.ok) return;
    expect(w.value.consentStatus).toBe('not_granted');
    expect(consentStatus(w.value.twin)).toBe('not_granted');
    expect(w.value.twin.consentEvents).toHaveLength(2);
    expect(twin.consentEvents).toHaveLength(0);
  });

  it('Fleet_Operator Data_Owner can change consent for a fleet battery', () => {
    const r = recordConsent(fleetTwin(), fleet, 'grant', '2025-06-15T10:00:00Z');
    expect(r.ok && r.value.consentStatus).toBe('granted');
  });

  it('rejects a non-Data_Owner with NOT_DATA_OWNER', () => {
    const r1 = recordConsent(ownerTwin(), otherOwner, 'grant', '2025-06-15T10:00:00Z');
    const r2 = recordConsent(ownerTwin(), fleet, 'grant', '2025-06-15T10:00:00Z');
    expect(!r1.ok && r1.error.code).toBe('NOT_DATA_OWNER');
    expect(!r2.ok && r2.error.code).toBe('NOT_DATA_OWNER');
  });

  it('rejects a role without the consent action with ACTION_NOT_PERMITTED', () => {
    const r1 = recordConsent(ownerTwin(), sp1, 'grant', '2025-06-15T10:00:00Z');
    const r2 = recordConsent(ownerTwin(), esg, 'grant', '2025-06-15T10:00:00Z');
    expect(!r1.ok && r1.error.code).toBe('ACTION_NOT_PERMITTED');
    expect(!r2.ok && r2.error.code).toBe('ACTION_NOT_PERMITTED');
  });

  it('rejects an invalid timestamp with VALIDATION_ERROR', () => {
    const r = recordConsent(ownerTwin(), owner, 'grant', 'not-a-time');
    expect(!r.ok && r.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('acceptReturnOffer', () => {
  it('appends the handover, removes the offer, writes the ReturnRecord, and returns the confirmation', () => {
    const granted = recordConsent(ownerTwin(), owner, 'grant', '2025-06-14T10:00:00Z');
    if (!granted.ok) throw new Error('setup');
    const twin = granted.value.twin;
    const before = snapshot(twin);
    const r = acceptReturnOffer(twin, owner, stakeholders, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { twin: next, confirmation, returnRecord } = r.value;

    // Designated SP: same state (CA) → Bravo Service (SP-001), not alphabetically-first Alpha in TX.
    expect(next.custodyLog).toHaveLength(2);
    expect(next.custodyLog[1]).toEqual({
      date: TODAY,
      fromHolderId: 'OWN-001',
      toHolderId: 'SP-001',
      toHolderRole: 'Service_Partner',
    });
    expect(next.nudges.some((n) => n.type === 'Return_Incentive')).toBe(false);
    expect(next.returnRecords).toEqual([returnRecord]);
    expect(returnRecord).toMatchObject({
      batteryId: 'BR-0001',
      ownerId: 'OWN-001',
      offerId: 'BR-0001:OWN-001:return',
      returnDate: TODAY,
      servicePartnerId: 'SP-001',
      servicePartnerName: 'Bravo Service',
    });
    // Charging (AC only), servicing (no prompt), consent (granted), return (forced) → 100.
    expect(returnRecord.components).toEqual({ charging: true, servicing: true, consent: true, return: true });
    expect(returnRecord.finalImpactScore).toBe(100);
    expect(confirmation).toEqual({
      message: 'Return accepted, +25 Impact points',
      servicePartnerName: 'Bravo Service',
      acceptanceDate: TODAY,
      finalImpactScore: 100,
      components: returnRecord.components,
    });
    expect(isReturnedFor(next, 'OWN-001')).toBe(true);
    expect(twin).toEqual(before);
  });

  it('computes Consent_Component from the pre-handover state (not granted → 75)', () => {
    const r = acceptReturnOffer(ownerTwin(), owner, stakeholders, TODAY);
    expect(r.ok && r.value.returnRecord.finalImpactScore).toBe(75);
    expect(r.ok && r.value.returnRecord.components.consent).toBe(false);
  });

  it('rejects a second acceptance: the Owner is now returned → ACTION_NOT_PERMITTED, twin unchanged', () => {
    const first = acceptReturnOffer(ownerTwin(), owner, stakeholders, TODAY);
    if (!first.ok) throw new Error('setup');
    const r = acceptReturnOffer(first.value.twin, owner, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });

  it('rejects an already-accepted offer while the Owner still holds custody with OFFER_NOT_ACCEPTABLE', () => {
    const first = acceptReturnOffer(ownerTwin(), owner, stakeholders, TODAY);
    if (!first.ok) throw new Error('setup');
    // Contrived: custody came back to the Owner, so the Returned_Battery guard no longer applies.
    const back = appendCustody(first.value.twin, { date: TODAY, fromHolderId: 'SP-001', toHolderId: 'OWN-001', toHolderRole: 'Owner' });
    if (!back.ok) throw new Error('setup');
    const r = acceptReturnOffer(back.value.twin, owner, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('OFFER_NOT_ACCEPTABLE');
  });

  it('rejects a non-holder Owner with OFFER_NOT_ACCEPTABLE', () => {
    const r = acceptReturnOffer(ownerTwin(), otherOwner, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('OFFER_NOT_ACCEPTABLE');
  });

  it('rejects when no Return_Offer is active (Continue_Use battery) with OFFER_NOT_ACCEPTABLE', () => {
    const t = ownerTwin();
    const healthy: DigitalTwin = {
      ...t,
      telemetry: [{ timestamp: '2025-06-01T00:00:00Z', sohPct: 95, cycleCount: 100, thermalEventCount: 0 }],
    };
    const r = acceptReturnOffer(healthy, owner, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('OFFER_NOT_ACCEPTABLE');
  });

  it('rejects a non-Owner role with ACTION_NOT_PERMITTED', () => {
    const r = acceptReturnOffer(ownerTwin(), sp1, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });

  it('rejects any Owner consent change on a Returned_Battery with ACTION_NOT_PERMITTED', () => {
    const first = acceptReturnOffer(ownerTwin(), owner, stakeholders, TODAY);
    if (!first.ok) throw new Error('setup');
    // Owner_Data still names OWN-001 as Data_Owner, yet the guard runs first (Req 4.14).
    expect(first.value.twin.dataOwner.id).toBe('OWN-001');
    const r = recordConsent(first.value.twin, owner, 'grant', '2025-06-16T10:00:00Z');
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('flagInspection', () => {
  it('appends an Inspection_Flag with date, Fleet_Operator, and Service_Partner', () => {
    const twin = fleetTwin();
    const r = flagInspection(twin, fleet, { servicePartnerId: 'SP-002' }, stakeholders, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.twin.inspectionFlags).toEqual([{ flagDate: TODAY, fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }]);
    expect(twin.inspectionFlags).toHaveLength(0);
  });

  it('rejects a non-holder Fleet_Operator with NOT_CURRENT_HOLDER', () => {
    const r = flagInspection(fleetTwin(), otherFleet, { servicePartnerId: 'SP-002' }, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('NOT_CURRENT_HOLDER');
  });

  it('rejects a missing or unknown Service_Partner with VALIDATION_ERROR naming servicePartnerId', () => {
    for (const input of [{}, { servicePartnerId: '' }, { servicePartnerId: 'SLP-001' }]) {
      const r = flagInspection(fleetTwin(), fleet, input, stakeholders, TODAY);
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe('VALIDATION_ERROR');
      expect(r.error.fields?.[0]?.field).toBe('servicePartnerId');
    }
  });

  it('rejects a non-Fleet role with ACTION_NOT_PERMITTED', () => {
    const r = flagInspection(ownerTwin(), owner, { servicePartnerId: 'SP-002' }, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('handOverToServicePartner', () => {
  it('hands custody to the SP of the most recent flag, enabling SP actions', () => {
    const f1 = flagInspection(fleetTwin(), fleet, { servicePartnerId: 'SP-002' }, stakeholders, '2025-06-01');
    if (!f1.ok) throw new Error('setup');
    const f2 = flagInspection(f1.value.twin, fleet, { servicePartnerId: 'SP-001' }, stakeholders, '2025-06-10');
    if (!f2.ok) throw new Error('setup');
    expect(allowedActions(f2.value.twin, sp1).has('repair')).toBe(false);

    const r = handOverToServicePartner(f2.value.twin, fleet, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servicePartnerId).toBe('SP-001');
    expect(r.value.twin.custodyLog[r.value.twin.custodyLog.length - 1]).toEqual({
      date: TODAY,
      fromHolderId: 'FLT-001',
      toHolderId: 'SP-001',
      toHolderRole: 'Service_Partner',
    });
    const actions = allowedActions(r.value.twin, sp1);
    expect([...actions].sort()).toEqual(['dispatch', 'referral', 'repair']);
  });

  it('rejects an unflagged battery with NO_INSPECTION_FLAG', () => {
    const twin = fleetTwin();
    const r = handOverToServicePartner(twin, fleet, TODAY);
    expect(!r.ok && r.error.code).toBe('NO_INSPECTION_FLAG');
    expect(twin.custodyLog).toHaveLength(1);
  });

  it('rejects a non-holder Fleet_Operator with NOT_CURRENT_HOLDER', () => {
    const f = flagInspection(fleetTwin(), fleet, { servicePartnerId: 'SP-001' }, stakeholders, TODAY);
    if (!f.ok) throw new Error('setup');
    const r = handOverToServicePartner(f.value.twin, otherFleet, TODAY);
    expect(!r.ok && r.error.code).toBe('NOT_CURRENT_HOLDER');
  });

  it('rejects a handover dated before the last custody entry with CUSTODY_APPEND_ONLY', () => {
    const f = flagInspection(fleetTwin(), fleet, { servicePartnerId: 'SP-001' }, stakeholders, TODAY);
    if (!f.ok) throw new Error('setup');
    const r = handOverToServicePartner(f.value.twin, fleet, '2019-01-01');
    expect(!r.ok && r.error.code).toBe('CUSTODY_APPEND_ONLY');
  });

  it('rejects a non-Fleet role with ACTION_NOT_PERMITTED', () => {
    const r = handOverToServicePartner(fleetTwin(), sp1, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});
