import { describe, expect, it } from 'vitest';
import {
  allowedActions,
  esgCustodyEntries,
  inScope,
  ownerDataVisible,
  ownerReturnedScope,
  roleCanPerform,
} from '../../src/core/access';
import type { CustodyEntry, DigitalTwin, ReturnRecord, Stakeholder, ViewerContext } from '../../src/core/types';

function twin(over: Partial<DigitalTwin> = {}): DigitalTwin {
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
    custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
    ...over,
  };
}

const v = (role: ViewerContext['role'], identityId: string, manufacturer?: string): ViewerContext =>
  manufacturer ? { role, identityId, manufacturer } : { role, identityId };

const hand = (date: string, from: string, to: string, role: CustodyEntry['toHolderRole']): CustodyEntry => ({
  date,
  fromHolderId: from,
  toHolderId: to,
  toHolderRole: role,
});

const returnRecord: ReturnRecord = {
  batteryId: 'BR-0001',
  ownerId: 'OWN-001',
  offerId: 'BR-0001:OWN-001:return',
  returnDate: '2024-01-01',
  servicePartnerId: 'SP-001',
  servicePartnerName: 'Alpha Service',
  finalImpactScore: 50,
  components: { charging: false, servicing: false, consent: true, return: true },
};

const ownerHeld = twin();
const fleetTwin = twin({
  custodyLog: [{ date: '2022-01-01', fromHolderId: null, toHolderId: 'FLT-001', toHolderRole: 'Fleet_Operator' }],
  dataOwner: { id: 'FLT-001', role: 'Fleet_Operator' },
});
const flaggedFleet = twin({
  ...fleetTwin,
  inspectionFlags: [{ flagDate: '2024-01-01', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }],
});
const returned = twin({
  custodyLog: [...ownerHeld.custodyLog, hand('2024-01-01', 'OWN-001', 'SP-001', 'Service_Partner')],
  returnRecords: [returnRecord],
});
const atSlp = twin({
  custodyLog: [...returned.custodyLog, hand('2024-02-01', 'SP-001', 'SLP-001', 'Second_Life_Provider')],
  returnRecords: [returnRecord],
  routedPathway: 'Second_Life_Review',
});
const atRecycler = twin({
  custodyLog: [...atSlp.custodyLog, hand('2024-03-01', 'SLP-001', 'REC-001', 'Recycler')],
  returnRecords: [returnRecord],
  routedPathway: 'Certified_Recycling',
});

describe('inScope', () => {
  it('Owner and Fleet_Operator see only batteries they hold', () => {
    expect(inScope(ownerHeld, v('Owner', 'OWN-001'))).toBe(true);
    expect(inScope(ownerHeld, v('Owner', 'OWN-002'))).toBe(false);
    expect(inScope(returned, v('Owner', 'OWN-001'))).toBe(false);
    expect(inScope(fleetTwin, v('Fleet_Operator', 'FLT-001'))).toBe(true);
    expect(inScope(fleetTwin, v('Fleet_Operator', 'FLT-002'))).toBe(false);
  });

  it('Service_Partner sees held, returned-to, and inspection-flagged batteries', () => {
    expect(inScope(returned, v('Service_Partner', 'SP-001'))).toBe(true);
    expect(inScope(atRecycler, v('Service_Partner', 'SP-001'))).toBe(true); // past ReturnRecord
    expect(inScope(flaggedFleet, v('Service_Partner', 'SP-002'))).toBe(true);
    expect(inScope(flaggedFleet, v('Service_Partner', 'SP-001'))).toBe(false);
    expect(inScope(ownerHeld, v('Service_Partner', 'SP-001'))).toBe(false);
  });

  it('only the most recent Inspection_Flag grants SP visibility', () => {
    const reflagged = twin({
      ...flaggedFleet,
      inspectionFlags: [
        ...flaggedFleet.inspectionFlags,
        { flagDate: '2024-02-01', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-003' },
      ],
    });
    expect(inScope(reflagged, v('Service_Partner', 'SP-003'))).toBe(true);
    expect(inScope(reflagged, v('Service_Partner', 'SP-002'))).toBe(false);
  });

  it('Second_Life_Provider requires Routed_Pathway Second_Life_Review and custody', () => {
    expect(inScope(atSlp, v('Second_Life_Provider', 'SLP-001'))).toBe(true);
    expect(inScope({ ...atSlp, routedPathway: null }, v('Second_Life_Provider', 'SLP-001'))).toBe(false);
    expect(inScope(atRecycler, v('Second_Life_Provider', 'SLP-001'))).toBe(false);
  });

  it('Recycler requires Certified_Recycling and the latest handover to it', () => {
    expect(inScope(atRecycler, v('Recycler', 'REC-001'))).toBe(true);
    expect(inScope(atRecycler, v('Recycler', 'REC-002'))).toBe(false);
    expect(inScope({ ...atRecycler, routedPathway: 'Second_Life_Review' }, v('Recycler', 'REC-001'))).toBe(false);
  });

  it('ESG_Officer matches by manufacturer', () => {
    expect(inScope(ownerHeld, v('ESG_Officer', 'ESG-001', 'Volt Inc'))).toBe(true);
    expect(inScope(ownerHeld, v('ESG_Officer', 'ESG-002', 'Other Co'))).toBe(false);
    expect(inScope(ownerHeld, v('ESG_Officer', 'ESG-003'))).toBe(false);
  });
});

describe('ownerReturnedScope', () => {
  it('lists twins returned by the Owner and no longer held by them', () => {
    expect(ownerReturnedScope([ownerHeld, returned, atRecycler], 'OWN-001')).toEqual([returned, atRecycler]);
    expect(ownerReturnedScope([returned], 'OWN-002')).toEqual([]);
  });
});

describe('allowedActions', () => {
  const list = (t: DigitalTwin, viewer: ViewerContext) => [...allowedActions(t, viewer)].sort();

  it('Owner holder may consent and accept; a Returned_Battery allows nothing', () => {
    expect(list(ownerHeld, v('Owner', 'OWN-001'))).toEqual(['acceptReturnOffer', 'consent']);
    expect(list(returned, v('Owner', 'OWN-001'))).toEqual([]);
    expect(list(ownerHeld, v('Owner', 'OWN-002'))).toEqual([]);
  });

  it('Fleet_Operator gets handover only once a flag exists', () => {
    expect(list(fleetTwin, v('Fleet_Operator', 'FLT-001'))).toEqual(['consent', 'flagInspection']);
    expect(list(flaggedFleet, v('Fleet_Operator', 'FLT-001'))).toEqual(['consent', 'flagInspection', 'handover']);
    expect(list(flaggedFleet, v('Fleet_Operator', 'FLT-002'))).toEqual([]);
  });

  it('Service_Partner actions require custody', () => {
    expect(list(flaggedFleet, v('Service_Partner', 'SP-002'))).toEqual([]);
    expect(list(atRecycler, v('Service_Partner', 'SP-001'))).toEqual([]);
    expect(list(returned, v('Service_Partner', 'SP-001'))).toEqual(['dispatch', 'referral', 'repair']);
    const handedOver = twin({
      ...flaggedFleet,
      custodyLog: [...flaggedFleet.custodyLog, hand('2024-01-02', 'FLT-001', 'SP-002', 'Service_Partner')],
    });
    expect(list(handedOver, v('Service_Partner', 'SP-002'))).toEqual(['dispatch', 'referral', 'repair']);
  });

  it('SLP, Recycler, and ESG permissions', () => {
    expect(list(atSlp, v('Second_Life_Provider', 'SLP-001'))).toEqual(['acceptSecondLife', 'dispatch']);
    expect(list(atRecycler, v('Recycler', 'REC-001'))).toEqual(['intake', 'materials']);
    expect(list(atRecycler, v('ESG_Officer', 'ESG-001', 'Volt Inc'))).toEqual([]);
  });

  it('static matrix', () => {
    expect(roleCanPerform('Owner', 'repair')).toBe(false);
    expect(roleCanPerform('Second_Life_Provider', 'dispatch')).toBe(true);
    expect(roleCanPerform('ESG_Officer', 'consent')).toBe(false);
  });
});

describe('ownerDataVisible', () => {
  const granted = twin({
    ...fleetTwin,
    consentEvents: [{ type: 'grant', at: '2024-01-01T00:00:00Z', byId: 'FLT-001' }],
  });

  it('Data_Owner always sees Owner_Data', () => {
    expect(ownerDataVisible(fleetTwin, v('Fleet_Operator', 'FLT-001'))).toBe(true);
  });

  it('other roles need Consent while the Data_Owner holds custody', () => {
    expect(ownerDataVisible(flaggedFleet, v('Service_Partner', 'SP-002'))).toBe(false);
    expect(ownerDataVisible(granted, v('Service_Partner', 'SP-002'))).toBe(true);
    const withdrawn = twin({
      ...granted,
      consentEvents: [...granted.consentEvents, { type: 'withdraw', at: '2024-02-01T00:00:00Z', byId: 'FLT-001' }],
    });
    expect(ownerDataVisible(withdrawn, v('Service_Partner', 'SP-002'))).toBe(false);
  });

  it('SP/SLP/Recycler holders see Owner_Data regardless of Consent', () => {
    expect(ownerDataVisible(returned, v('Service_Partner', 'SP-001'))).toBe(true);
    expect(ownerDataVisible(atSlp, v('Second_Life_Provider', 'SLP-001'))).toBe(true);
    expect(ownerDataVisible(atRecycler, v('Recycler', 'REC-001'))).toBe(true);
  });

  it('non-holders after custody left the Data_Owner see nothing', () => {
    expect(ownerDataVisible(atRecycler, v('Service_Partner', 'SP-001'))).toBe(false);
    expect(ownerDataVisible(atRecycler, v('ESG_Officer', 'ESG-001', 'Volt Inc'))).toBe(false);
  });
});

describe('esgCustodyEntries', () => {
  const stakeholders: Stakeholder[] = [
    { id: 'OWN-001', role: 'Owner', name: 'Jane Owner', location: { city: 'Austin', state: 'TX' } },
    { id: 'SP-001', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Austin', state: 'TX' } },
  ];

  it('hides Owner identities and from-holders', () => {
    const out = esgCustodyEntries(returned.custodyLog, stakeholders);
    expect(out).toEqual([
      { date: '2022-01-01', toRole: 'Owner' },
      { date: '2024-01-01', toRole: 'Service_Partner', toHolderId: 'SP-001', toHolderName: 'Alpha Service' },
    ]);
    expect(JSON.stringify(out)).not.toContain('OWN-001');
    expect(JSON.stringify(out)).not.toContain('Jane Owner');
  });
});
