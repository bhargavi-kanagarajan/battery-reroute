import { describe, expect, it } from 'vitest';
import { PERMITTED_FIELDS, inScope } from '../../src/core/access';
import {
  PENDING_HANDOVER_REASON,
  WITHHELD_REASON,
  evaluateDerived,
  isWithheld,
  project,
  projectBatteryList,
  projectReturned,
  type FleetBatteryView,
  type OwnerBatteryView,
  type RecyclerBatteryView,
  type SecondLifeBatteryView,
  type ServicePartnerBatteryView,
} from '../../src/core/projection';
import type { DigitalTwin, ReturnRecord, Role, Stakeholder, ViewerContext } from '../../src/core/types';

const EVAL = '2025-06-01';

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Alice Owner', location: { city: 'Fresno', state: 'CA' } },
  { id: 'FLT-001', role: 'Fleet_Operator', name: 'City Fleet', location: { city: 'Austin', state: 'TX' } },
  { id: 'FLT-002', role: 'Fleet_Operator', name: 'Other Fleet', location: { city: 'Austin', state: 'TX' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Beta Service', location: { city: 'Oakland', state: 'CA' } },
  { id: 'SP-002', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'ReLife', location: { city: 'Reno', state: 'NV' } },
  { id: 'REC-001', role: 'Recycler', name: 'CycleCo', location: { city: 'Phoenix', state: 'AZ' } },
  { id: 'ESG-001', role: 'ESG_Officer', name: 'Esme', location: { city: 'Detroit', state: 'MI' }, manufacturer: 'Volt Inc' },
];

const v = (role: Role, identityId: string, manufacturer?: string): ViewerContext =>
  manufacturer ? { role, identityId, manufacturer } : { role, identityId };

function baseTwin(id: string, holder: { id: string; role: DigitalTwin['custodyLog'][number]['toHolderRole'] }): DigitalTwin {
  return {
    passport: {
      batteryId: id,
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2021-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [
      { moduleId: 'M1', condition: 'Good' },
      { moduleId: 'M2', condition: 'Degraded' },
    ],
    telemetry: [
      { timestamp: '2025-05-01T00:00:00Z', sohPct: 72, cycleCount: 900, thermalEventCount: 0 },
      { timestamp: '2024-11-01T00:00:00Z', sohPct: 73, cycleCount: 800, thermalEventCount: 0 },
    ],
    chargingHistory: [{ date: '2025-01-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
    serviceHistory: [
      { date: '2023-01-01', faultCode: 'P0A80', actionTaken: 'check', modulesReplaced: [] },
      { date: '2024-01-01', faultCode: '', actionTaken: 'inspection', modulesReplaced: [] },
    ],
    custodyLog: [{ date: '2021-02-01', fromHolderId: null, toHolderId: holder.id, toHolderRole: holder.role }],
    endOfLife: null,
    dataOwner: { id: holder.id, role: holder.role === 'Fleet_Operator' ? 'Fleet_Operator' : 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

function view(twin: DigitalTwin, viewer: ViewerContext) {
  return project(twin, evaluateDerived(twin, EVAL, viewer, stakeholders), viewer, stakeholders);
}

function expectKeysPermitted(obj: object, role: keyof typeof PERMITTED_FIELDS) {
  const allowed: readonly string[] = PERMITTED_FIELDS[role];
  for (const k of Object.keys(obj)) expect(allowed).toContain(k);
}

describe('projection', () => {
  it('Owner view: permitted fields, Return_Offer to the same-state SP, impact score', () => {
    const twin = baseTwin('BR-1', { id: 'OWN-001', role: 'Owner' });
    const out = view(twin, v('Owner', 'OWN-001')) as OwnerBatteryView;
    expectKeysPermitted(out, 'Owner');
    expect(out.pathway.pathway).toBe('Second_Life_Review');
    expect(out.returnOffer).toEqual({ offerId: 'BR-1:OWN-001:return', servicePartnerId: 'SP-001', servicePartnerName: 'Beta Service' });
    expect(typeof out.healthScore).toBe('number');
    // charging + servicing earned; consent not granted; Return_Offer outstanding.
    expect(out.impactComponents).toEqual({ charging: true, servicing: true, consent: false, return: false });
    expect(out.impactScore).toBe(50);
    expect(out.dataConfidence).toBe(100);
    expect(out.consentStatus).toBe('not_granted');
  });

  it('Fleet view: ascending SoH series, inspection summary; withheld for a non-Data_Owner without consent', () => {
    const twin: DigitalTwin = {
      ...baseTwin('BR-F', { id: 'FLT-001', role: 'Fleet_Operator' }),
      inspectionFlags: [{ flagDate: '2025-05-20', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }],
    };
    const own = view(twin, v('Fleet_Operator', 'FLT-001')) as FleetBatteryView;
    expectKeysPermitted(own, 'Fleet_Operator');
    expect(own.sohSeries).toEqual([
      { timestamp: '2024-11-01T00:00:00Z', sohPct: 73 },
      { timestamp: '2025-05-01T00:00:00Z', sohPct: 72 },
    ]);
    expect(own.inspectionFlag).toEqual({
      flagged: true,
      flagDate: '2025-05-20',
      servicePartnerId: 'SP-002',
      servicePartnerName: 'Alpha Service',
    });

    const other = view(twin, v('Fleet_Operator', 'FLT-002')) as FleetBatteryView;
    for (const k of ['healthScore', 'soh', 'sohSeries', 'remainingLife'] as const) {
      expect(other[k]).toEqual({ withheld: true, reason: WITHHELD_REASON });
    }
    expect(other.safetyFlag).toBe(false);

    const granted: DigitalTwin = { ...twin, consentEvents: [{ type: 'grant', at: '2025-05-01T00:00:00Z', byId: 'FLT-001' }] };
    const otherGranted = view(granted, v('Fleet_Operator', 'FLT-002')) as FleetBatteryView;
    expect(isWithheld(otherGranted.healthScore)).toBe(false);
    expect(otherGranted.soh).toBe(72);
  });

  it('Service_Partner: inspection-only view is disabled and leaks no SoH; holder view is enabled', () => {
    const twin: DigitalTwin = {
      ...baseTwin('BR-F', { id: 'FLT-001', role: 'Fleet_Operator' }),
      inspectionFlags: [{ flagDate: '2025-05-20', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }],
    };
    expect(inScope(twin, v('Service_Partner', 'SP-001'))).toBe(false);
    const sp = view(twin, v('Service_Partner', 'SP-002')) as ServicePartnerBatteryView;
    expectKeysPermitted(sp, 'Service_Partner');
    expect(sp.assignment).toBe('ReferredForInspection');
    expect(sp.actionsEnabled).toBe(false);
    expect(sp.actionsDisabledReason).toBe(PENDING_HANDOVER_REASON);
    expect(sp.serviceHistory.map((s) => s.date)).toEqual(['2024-01-01', '2023-01-01']);
    expect(sp.faultCodes).toEqual([{ date: '2023-01-01', faultCode: 'P0A80' }]);
    expect(sp.pathway.firedRules.every((r) => r.inputs.soh === undefined)).toBe(true);

    const handed: DigitalTwin = {
      ...twin,
      custodyLog: [
        ...twin.custodyLog,
        { date: '2025-05-25', fromHolderId: 'FLT-001', toHolderId: 'SP-002', toHolderRole: 'Service_Partner' },
      ],
    };
    const holder = view(handed, v('Service_Partner', 'SP-002')) as ServicePartnerBatteryView;
    expect(holder.assignment).toBe('Assigned');
    expect(holder.actionsEnabled).toBe(true);
    expect(holder.actionsDisabledReason).toBeUndefined();
    expect(holder.pathway.firedRules[0]!.inputs.soh).toBe(72);
  });

  it('Second_Life_Provider and Recycler views', () => {
    const base = baseTwin('BR-S', { id: 'OWN-001', role: 'Owner' });
    const slpTwin: DigitalTwin = {
      ...base,
      custodyLog: [
        ...base.custodyLog,
        { date: '2025-05-02', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' },
        { date: '2025-05-03', fromHolderId: 'SP-001', toHolderId: 'SLP-001', toHolderRole: 'Second_Life_Provider' },
      ],
      routedPathway: 'Second_Life_Review',
    };
    const slp = view(slpTwin, v('Second_Life_Provider', 'SLP-001')) as SecondLifeBatteryView;
    expectKeysPermitted(slp, 'Second_Life_Provider');
    expect(slp.usableCapacity).toBe(43.2);
    expect(slp.applicationFit).toEqual(['Stationary_Storage', 'Light_Mobility']);
    expect(slp.acceptance).toBe('Pending');
    expect(slp.soh).toBe(72); // custodial holder sees data regardless of consent

    const recTwin: DigitalTwin = {
      ...slpTwin,
      custodyLog: [
        ...slpTwin.custodyLog,
        {
          date: '2025-05-10',
          fromHolderId: 'SLP-001',
          toHolderId: 'REC-001',
          toHolderRole: 'Recycler',
          expectedArrivalDate: '2025-06-10',
        },
      ],
      routedPathway: 'Certified_Recycling',
    };
    const rec = view(recTwin, v('Recycler', 'REC-001')) as RecyclerBatteryView;
    expect(Object.keys(rec).sort()).toEqual([...PERMITTED_FIELDS.Recycler].sort());
    expect(rec.location).toEqual({ city: 'Reno', state: 'NV' });
    expect(rec.expectedArrival).toBe('2025-06-10');
    expect(rec.intakeStatus).toBe('Awaiting_Intake');
    const received = view({ ...recTwin, recyclerIntake: { handoverIndex: 3, intakeDate: '2025-05-12' } }, v('Recycler', 'REC-001'));
    expect((received as RecyclerBatteryView).intakeStatus).toBe('Received');
  });

  it('Returned_Battery: Owner sees only the ReturnRecord view, unaffected by later data', () => {
    const base = baseTwin('BR-R', { id: 'OWN-001', role: 'Owner' });
    const record: ReturnRecord = {
      batteryId: 'BR-R',
      ownerId: 'OWN-001',
      offerId: 'BR-R:OWN-001:return',
      returnDate: '2025-05-02',
      servicePartnerId: 'SP-001',
      servicePartnerName: 'Beta Service',
      finalImpactScore: 75,
      components: { charging: true, servicing: true, consent: false, return: true },
    };
    const returned: DigitalTwin = {
      ...base,
      custodyLog: [
        ...base.custodyLog,
        { date: '2025-05-02', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' },
      ],
      returnRecords: [record],
    };
    const later: DigitalTwin = {
      ...returned,
      serviceHistory: [...returned.serviceHistory, { date: '2025-05-20', faultCode: 'X', actionTaken: 'fix', modulesReplaced: [] }],
      endOfLife: { pathway: 'Certified_Recycling', date: '2025-05-25', receivingPartyId: 'REC-001', materialsRecoveredKg: { li: 5 } },
    };
    const owner = v('Owner', 'OWN-001');
    const a = view(returned, owner);
    const b = view(later, owner);
    expect(Object.keys(a).sort()).toEqual([...PERMITTED_FIELDS.OwnerReturned].sort());
    expect(b).toEqual(a);
    expect(a).toEqual(projectReturned(record));

    const list = projectBatteryList([later], EVAL, owner, stakeholders);
    expect(list.batteries).toEqual([]);
    expect(list.returnedBatteries).toEqual([projectReturned(record)]);
  });

  it('ESG view and list contain no Owner identity', () => {
    const base = baseTwin('BR-E', { id: 'OWN-001', role: 'Owner' });
    const twin: DigitalTwin = {
      ...base,
      custodyLog: [
        ...base.custodyLog,
        { date: '2025-05-02', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' },
      ],
      consentEvents: [{ type: 'grant', at: '2025-05-01T00:00:00Z', byId: 'OWN-001' }],
    };
    const esg = v('ESG_Officer', 'ESG-001', 'Volt Inc');
    const list = projectBatteryList([twin], EVAL, esg, stakeholders);
    expect(list.batteries).toHaveLength(1);
    const row = list.batteries[0]!;
    expect(Object.keys(row).sort()).toEqual([...PERMITTED_FIELDS.ESG_Officer].sort());
    const json = JSON.stringify(list);
    expect(json).not.toContain('OWN-001');
    expect(json).not.toContain('Alice Owner');
    expect((row as { custodyLog: unknown[] }).custodyLog[0]).toEqual({ date: '2021-02-01', toRole: 'Owner' });
    expect((row as { consentStatus: string }).consentStatus).toBe('granted');
  });

  it('list helpers: Fleet ordered by Health_Score ascending; nudge updates reported', () => {
    const healthy = baseTwin('BR-A', { id: 'FLT-001', role: 'Fleet_Operator' });
    healthy.telemetry = [{ timestamp: '2025-05-01T00:00:00Z', sohPct: 95, cycleCount: 100, thermalEventCount: 0 }];
    const weak = baseTwin('BR-B', { id: 'FLT-001', role: 'Fleet_Operator' });
    const list = projectBatteryList([healthy, weak], EVAL, v('Fleet_Operator', 'FLT-001'), stakeholders);
    expect(list.batteries.map((b) => (b as FleetBatteryView).batteryId)).toEqual(['BR-B', 'BR-A']);

    const ownerList = projectBatteryList([baseTwin('BR-1', { id: 'OWN-001', role: 'Owner' })], EVAL, v('Owner', 'OWN-001'), stakeholders);
    expect(ownerList.nudgeUpdates['BR-1']?.map((n) => n.type)).toEqual(['Return_Incentive']);
  });
});
