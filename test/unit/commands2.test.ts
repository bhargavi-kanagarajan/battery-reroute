import { describe, expect, it } from 'vitest';
import {
  acceptSecondLife,
  dispatchToRecycler,
  flagInspection,
  logIntake,
  logMaterials,
  logRepair,
  referToSecondLife,
} from '../../src/core/commands';
import { intakeStatusOf, secondLifeAcceptance } from '../../src/core/projection';
import { currentHolder } from '../../src/core/telemetry';
import type { DigitalTwin, Stakeholder, ViewerContext } from '../../src/core/types';

const TODAY = '2025-06-15';

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Owner One', location: { city: 'Fresno', state: 'CA' } },
  { id: 'FLT-001', role: 'Fleet_Operator', name: 'Fleet One', location: { city: 'Reno', state: 'NV' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Bravo Service', location: { city: 'San Jose', state: 'CA' } },
  { id: 'SP-002', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'Reuse Co', location: { city: 'Tempe', state: 'AZ' } },
  { id: 'SLP-002', role: 'Second_Life_Provider', name: 'Reuse Two', location: { city: 'Mesa', state: 'AZ' } },
  { id: 'REC-001', role: 'Recycler', name: 'Loop Recycling', location: { city: 'Sparks', state: 'NV' } },
  { id: 'REC-002', role: 'Recycler', name: 'Other Recycling', location: { city: 'Elko', state: 'NV' } },
];

const owner: ViewerContext = { role: 'Owner', identityId: 'OWN-001' };
const fleet: ViewerContext = { role: 'Fleet_Operator', identityId: 'FLT-001' };
const sp1: ViewerContext = { role: 'Service_Partner', identityId: 'SP-001' };
const sp2: ViewerContext = { role: 'Service_Partner', identityId: 'SP-002' };
const slp1: ViewerContext = { role: 'Second_Life_Provider', identityId: 'SLP-001' };
const slp2: ViewerContext = { role: 'Second_Life_Provider', identityId: 'SLP-002' };
const rec1: ViewerContext = { role: 'Recycler', identityId: 'REC-001' };
const rec2: ViewerContext = { role: 'Recycler', identityId: 'REC-002' };

/** SP-001 holds the battery (after an Owner return); SoH 70, no Safety_Flag. */
function spTwin(): DigitalTwin {
  return {
    passport: {
      batteryId: 'BR-0002',
      chemistry: 'NMC',
      capacityKwh: 60,
      packMassKg: 400,
      manufactureDate: '2019-01-01',
      manufacturer: 'Volt Inc',
      embeddedCarbonKgCo2e: 5000,
      recycledContentPct: 10,
    },
    modules: [
      { moduleId: 'M1', condition: 'Failed' },
      { moduleId: 'M2', condition: 'Degraded' },
    ],
    telemetry: [{ timestamp: '2025-06-01T00:00:00Z', sohPct: 70, cycleCount: 1300, thermalEventCount: 0 }],
    chargingHistory: [],
    serviceHistory: [],
    custodyLog: [
      { date: '2019-02-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' },
      { date: '2025-06-01', fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' },
    ],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [{ type: 'grant', at: '2025-05-01T00:00:00Z', byId: 'OWN-001' }],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`setup failed: ${JSON.stringify(r.error)}`);
  return r.value;
}

function slpTwin(): DigitalTwin {
  return ok(referToSecondLife(spTwin(), sp1, { secondLifeProviderId: 'SLP-001' }, stakeholders, TODAY)).twin;
}

function recyclerTwin(): DigitalTwin {
  return ok(dispatchToRecycler(spTwin(), sp1, { recyclerId: 'REC-001', expectedArrivalDate: '2025-06-20' }, stakeholders, TODAY)).twin;
}

function receivedTwin(): DigitalTwin {
  return ok(logIntake(recyclerTwin(), rec1, { intakeDate: TODAY }, TODAY)).twin;
}

function snapshot<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function fieldsOf(r: { ok: boolean; error?: { fields?: { field: string }[] } }): string[] {
  return (r.error?.fields ?? []).map((f) => f.field).sort();
}

describe('logRepair', () => {
  it('appends one record and sets only the listed modules to Good', () => {
    const twin = spTwin();
    const before = snapshot(twin);
    const r = logRepair(twin, sp1, { date: TODAY, faultCode: 'P0A80', actionTaken: 'Replaced module M1', modulesReplaced: ['M1'] }, TODAY);
    const v = ok(r);
    expect(v.twin.serviceHistory).toEqual([{ date: TODAY, faultCode: 'P0A80', actionTaken: 'Replaced module M1', modulesReplaced: ['M1'] }]);
    expect(v.twin.modules).toEqual([
      { moduleId: 'M1', condition: 'Good' },
      { moduleId: 'M2', condition: 'Degraded' },
    ]);
    expect(twin).toEqual(before);
  });

  it('defaults an omitted fault code and module list', () => {
    const v = ok(logRepair(spTwin(), sp1, { date: TODAY, actionTaken: 'Inspected' }, TODAY));
    expect(v.serviceRecord).toEqual({ date: TODAY, faultCode: '', actionTaken: 'Inspected', modulesReplaced: [] });
    expect(v.twin.modules).toEqual(spTwin().modules);
  });

  it('names every invalid field and changes nothing', () => {
    const twin = spTwin();
    const r1 = logRepair(twin, sp1, { date: '2025-06-16', actionTaken: '', modulesReplaced: ['M1', 'MX'] }, TODAY);
    expect(!r1.ok && r1.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(r1)).toEqual(['actionTaken', 'date', 'modulesReplaced.1']);
    const r2 = logRepair(twin, sp1, { actionTaken: 'x'.repeat(501) }, TODAY);
    expect(fieldsOf(r2)).toEqual(['actionTaken', 'date']);
    expect(twin.serviceHistory).toHaveLength(0);
    expect(twin.modules[0]?.condition).toBe('Failed');
  });

  it('rejects a non-holder Service_Partner and other roles with ACTION_NOT_PERMITTED', () => {
    const input = { date: TODAY, actionTaken: 'x' };
    const r1 = logRepair(spTwin(), sp2, input, TODAY);
    const r2 = logRepair(spTwin(), owner, input, TODAY);
    expect(!r1.ok && r1.error.code).toBe('ACTION_NOT_PERMITTED');
    expect(!r2.ok && r2.error.code).toBe('ACTION_NOT_PERMITTED');
  });

  it('rejects an inspection-only Service_Partner while the Fleet_Operator holds custody', () => {
    const base = spTwin();
    const fleetHeld: DigitalTwin = {
      ...base,
      custodyLog: [{ date: '2019-02-01', fromHolderId: null, toHolderId: 'FLT-001', toHolderRole: 'Fleet_Operator' }],
      dataOwner: { id: 'FLT-001', role: 'Fleet_Operator' },
    };
    const flagged = ok(flagInspection(fleetHeld, fleet, { servicePartnerId: 'SP-001' }, stakeholders, TODAY)).twin;
    const r = logRepair(flagged, sp1, { date: TODAY, actionTaken: 'x' }, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
    const d = referToSecondLife(flagged, sp1, { secondLifeProviderId: 'SLP-001' }, stakeholders, TODAY);
    expect(!d.ok && d.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('referToSecondLife', () => {
  it('appends a handover to the SLP and sets Routed_Pathway to Second_Life_Review', () => {
    const twin = spTwin();
    const v = ok(referToSecondLife(twin, sp1, { secondLifeProviderId: 'SLP-001' }, stakeholders, TODAY));
    expect(v.twin.custodyLog).toHaveLength(3);
    expect(v.twin.custodyLog[2]).toEqual({ date: TODAY, fromHolderId: 'SP-001', toHolderId: 'SLP-001', toHolderRole: 'Second_Life_Provider' });
    expect(v.twin.routedPathway).toBe('Second_Life_Review');
    expect(twin.routedPathway).toBeNull();
  });

  it('rejects a target that is not a Second_Life_Provider', () => {
    for (const id of [undefined, '', 'REC-001', 'NOPE']) {
      const r = referToSecondLife(spTwin(), sp1, { secondLifeProviderId: id }, stakeholders, TODAY);
      expect(!r.ok && r.error.code).toBe('VALIDATION_ERROR');
      expect(fieldsOf(r)).toEqual(['secondLifeProviderId']);
    }
  });

  it('rejects a non-holder Service_Partner', () => {
    const r = referToSecondLife(spTwin(), sp2, { secondLifeProviderId: 'SLP-001' }, stakeholders, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('dispatchToRecycler', () => {
  it('Service_Partner holder dispatches: handover with arrival date, Certified_Recycling, Awaiting_Intake', () => {
    const v = ok(dispatchToRecycler(spTwin(), sp1, { recyclerId: 'REC-001', expectedArrivalDate: '2025-09-13' }, stakeholders, TODAY));
    expect(v.twin.custodyLog[2]).toEqual({
      date: TODAY,
      fromHolderId: 'SP-001',
      toHolderId: 'REC-001',
      toHolderRole: 'Recycler',
      expectedArrivalDate: '2025-09-13',
    });
    expect(v.twin.routedPathway).toBe('Certified_Recycling');
    expect(intakeStatusOf(v.twin)).toBe('Awaiting_Intake');
  });

  it('Second_Life_Provider holder (Pending or Accepted) can dispatch', () => {
    const pending = ok(dispatchToRecycler(slpTwin(), slp1, { recyclerId: 'REC-001', expectedArrivalDate: TODAY }, stakeholders, TODAY));
    expect(currentHolder(pending.twin.custodyLog)?.toHolderId).toBe('REC-001');
    const accepted = ok(acceptSecondLife(slpTwin(), slp1, TODAY)).twin;
    const v = ok(dispatchToRecycler(accepted, slp1, { recyclerId: 'REC-001', expectedArrivalDate: TODAY }, stakeholders, TODAY));
    expect(v.twin.routedPathway).toBe('Certified_Recycling');
  });

  it('names missing or out-of-range recycler and arrival fields', () => {
    const r1 = dispatchToRecycler(spTwin(), sp1, {}, stakeholders, TODAY);
    expect(!r1.ok && r1.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(r1)).toEqual(['expectedArrivalDate', 'recyclerId']);
    const r2 = dispatchToRecycler(spTwin(), sp1, { recyclerId: 'SLP-001', expectedArrivalDate: '2025-06-14' }, stakeholders, TODAY);
    expect(fieldsOf(r2)).toEqual(['expectedArrivalDate', 'recyclerId']);
    const r3 = dispatchToRecycler(spTwin(), sp1, { recyclerId: 'REC-001', expectedArrivalDate: '2025-09-14' }, stakeholders, TODAY);
    expect(fieldsOf(r3)).toEqual(['expectedArrivalDate']);
  });

  it('rejects a non-holder SP (ACTION_NOT_PERMITTED) and an out-of-view SLP (NOT_AVAILABLE)', () => {
    const input = { recyclerId: 'REC-001', expectedArrivalDate: TODAY };
    const r1 = dispatchToRecycler(spTwin(), sp2, input, stakeholders, TODAY);
    expect(!r1.ok && r1.error.code).toBe('ACTION_NOT_PERMITTED');
    const r2 = dispatchToRecycler(slpTwin(), slp2, input, stakeholders, TODAY);
    expect(!r2.ok && r2.error.code).toBe('NOT_AVAILABLE');
    const r3 = dispatchToRecycler(slpTwin(), rec1, input, stakeholders, TODAY);
    expect(!r3.ok && r3.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('acceptSecondLife', () => {
  it('creates a Second_Life_Review End_Of_Life_Record dated today', () => {
    const twin = slpTwin();
    const v = ok(acceptSecondLife(twin, slp1, TODAY));
    expect(v.twin.endOfLife).toEqual({ pathway: 'Second_Life_Review', date: TODAY, receivingPartyId: 'SLP-001', materialsRecoveredKg: {} });
    expect(secondLifeAcceptance(v.twin)).toBe('Accepted');
    expect(v.twin.custodyLog).toEqual(twin.custodyLog);
    expect(twin.endOfLife).toBeNull();
  });

  it('rejects a safety-flagged battery with SAFETY_FLAGGED', () => {
    const base = slpTwin();
    const flagged: DigitalTwin = {
      ...base,
      serviceHistory: [{ date: '2025-01-01', faultCode: 'CELL_VENTING', actionTaken: '', modulesReplaced: [] }],
    };
    const r = acceptSecondLife(flagged, slp1, TODAY);
    expect(!r.ok && r.error.code).toBe('SAFETY_FLAGGED');
  });

  it('rejects an existing record or out-of-view battery with NOT_AVAILABLE', () => {
    const accepted = ok(acceptSecondLife(slpTwin(), slp1, TODAY)).twin;
    const r1 = acceptSecondLife(accepted, slp1, TODAY);
    expect(!r1.ok && r1.error.code).toBe('NOT_AVAILABLE');
    const r2 = acceptSecondLife(slpTwin(), slp2, TODAY);
    expect(!r2.ok && r2.error.code).toBe('NOT_AVAILABLE');
    const r3 = acceptSecondLife(spTwin(), slp1, TODAY);
    expect(!r3.ok && r3.error.code).toBe('NOT_AVAILABLE');
  });

  it('rejects other roles with ACTION_NOT_PERMITTED', () => {
    const r = acceptSecondLife(slpTwin(), sp1, TODAY);
    expect(!r.ok && r.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('logIntake', () => {
  it('records intake against the dispatch handover without a custody entry', () => {
    const twin = recyclerTwin();
    const v = ok(logIntake(twin, rec1, { intakeDate: TODAY }, TODAY));
    expect(v.twin.recyclerIntake).toEqual({ handoverIndex: 2, intakeDate: TODAY });
    expect(v.twin.custodyLog).toEqual(twin.custodyLog);
    expect(intakeStatusOf(v.twin)).toBe('Received');
    expect(twin.recyclerIntake).toBeNull();
  });

  it('rejects missing, early, or future intake dates', () => {
    for (const intakeDate of [undefined, 'bad', '2025-06-14', '2025-06-16']) {
      const r = logIntake(recyclerTwin(), rec1, { intakeDate }, TODAY);
      expect(!r.ok && r.error.code).toBe('VALIDATION_ERROR');
      expect(fieldsOf(r)).toEqual(['intakeDate']);
    }
  });

  it('rejects an already-received or out-of-view battery', () => {
    const r1 = logIntake(receivedTwin(), rec1, { intakeDate: TODAY }, TODAY);
    expect(fieldsOf(r1)).toEqual(['intakeStatus']);
    const r2 = logIntake(recyclerTwin(), rec2, { intakeDate: TODAY }, TODAY);
    expect(!r2.ok && r2.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(r2)).toEqual(['batteryId']);
    const r3 = logIntake(recyclerTwin(), sp1, { intakeDate: TODAY }, TODAY);
    expect(!r3.ok && r3.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});

describe('logMaterials', () => {
  it('writes the Certified_Recycling record, replacing a prior Second_Life_Review record', () => {
    const accepted = ok(acceptSecondLife(slpTwin(), slp1, TODAY)).twin;
    const dispatched = ok(dispatchToRecycler(accepted, slp1, { recyclerId: 'REC-001', expectedArrivalDate: TODAY }, stakeholders, TODAY)).twin;
    const received = ok(logIntake(dispatched, rec1, { intakeDate: TODAY }, TODAY)).twin;
    expect(received.endOfLife?.pathway).toBe('Second_Life_Review');
    const v = ok(logMaterials(received, rec1, { materials: { lithium: 12.5, cobalt: 0 } }, TODAY));
    expect(v.twin.endOfLife).toEqual({
      pathway: 'Certified_Recycling',
      date: TODAY,
      receivingPartyId: 'REC-001',
      materialsRecoveredKg: { lithium: 12.5, cobalt: 0 },
    });
  });

  it('requires intake first (INTAKE_REQUIRED)', () => {
    const r = logMaterials(recyclerTwin(), rec1, { materials: { lithium: 1 } }, TODAY);
    expect(!r.ok && r.error.code).toBe('INTAKE_REQUIRED');
  });

  it('rejects a second Certified_Recycling record with EOL_EXISTS', () => {
    const done = ok(logMaterials(receivedTwin(), rec1, { materials: { lithium: 1 } }, TODAY)).twin;
    const r = logMaterials(done, rec1, { materials: { lithium: 2 } }, TODAY);
    expect(!r.ok && r.error.code).toBe('EOL_EXISTS');
    expect(done.endOfLife?.materialsRecoveredKg).toEqual({ lithium: 1 });
  });

  it('rejects empty maps, negative masses, and totals above Pack_Mass', () => {
    const twin = receivedTwin();
    const empty = logMaterials(twin, rec1, { materials: {} }, TODAY);
    expect(fieldsOf(empty)).toEqual(['materials']);
    const missing = logMaterials(twin, rec1, {}, TODAY);
    expect(fieldsOf(missing)).toEqual(['materials']);
    const negative = logMaterials(twin, rec1, { materials: { lithium: -1, nickel: 'x' } }, TODAY);
    expect(!negative.ok && negative.error.code).toBe('VALIDATION_ERROR');
    expect(fieldsOf(negative)).toEqual(['materials.lithium', 'materials.nickel']);
    const heavy = logMaterials(twin, rec1, { materials: { lithium: 300, nickel: 100.5 } }, TODAY);
    expect(fieldsOf(heavy)).toEqual(['materials']);
    expect(twin.endOfLife).toBeNull();
  });

  it('rejects an out-of-view battery and other roles', () => {
    const r1 = logMaterials(receivedTwin(), rec2, { materials: { lithium: 1 } }, TODAY);
    expect(fieldsOf(r1)).toEqual(['batteryId']);
    const r2 = logMaterials(receivedTwin(), slp1, { materials: { lithium: 1 } }, TODAY);
    expect(!r2.ok && r2.error.code).toBe('ACTION_NOT_PERMITTED');
  });
});
