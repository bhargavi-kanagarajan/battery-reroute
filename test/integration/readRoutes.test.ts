import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { PERMITTED_FIELDS } from '../../src/core/access';
import type { DigitalTwin, HolderRole, ReturnRecord, Stakeholder, Store } from '../../src/core/types';
import { createApp } from '../../src/server/app';
import { fixedClock } from '../../src/server/clock';
import { assertNoOwnerIdentity } from '../../src/server/esgGuard';
import { HttpError } from '../../src/server/errors';
import { MemoryRepository, emptyStore } from '../../src/server/repo';

const TODAY = '2025-06-01';

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Alice Owner', location: { city: 'Fresno', state: 'CA' } },
  { id: 'OWN-002', role: 'Owner', name: 'Bob Owner', location: { city: 'Austin', state: 'TX' } },
  { id: 'FLT-001', role: 'Fleet_Operator', name: 'City Fleet', location: { city: 'Austin', state: 'TX' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Beta Service', location: { city: 'Oakland', state: 'CA' } },
  { id: 'SP-002', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'ReLife', location: { city: 'Reno', state: 'NV' } },
  { id: 'REC-001', role: 'Recycler', name: 'CycleCo', location: { city: 'Phoenix', state: 'AZ' } },
  { id: 'ESG-001', role: 'ESG_Officer', name: 'Esme', location: { city: 'Detroit', state: 'MI' }, manufacturer: 'Volt Inc' },
  { id: 'ESG-002', role: 'ESG_Officer', name: 'Omar', location: { city: 'Detroit', state: 'MI' }, manufacturer: 'Other Co' },
];

type Hop = { date: string; from: string | null; to: string; role: HolderRole; expectedArrivalDate?: string };

function twin(id: string, hops: Hop[], overrides: Partial<DigitalTwin> = {}): DigitalTwin {
  const first = hops[0]!;
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
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [
      { timestamp: '2024-11-01T00:00:00Z', sohPct: 73, cycleCount: 800, thermalEventCount: 0 },
      { timestamp: '2025-05-01T00:00:00Z', sohPct: 72, cycleCount: 900, thermalEventCount: 0 },
    ],
    chargingHistory: [{ date: '2025-01-01', energyKwh: 30, chargeType: 'AC', ambientTempC: 20 }],
    serviceHistory: [{ date: '2023-01-01', faultCode: '', actionTaken: 'inspection', modulesReplaced: [] }],
    custodyLog: hops.map((h) => {
      const e: DigitalTwin['custodyLog'][number] = { date: h.date, fromHolderId: h.from, toHolderId: h.to, toHolderRole: h.role };
      if (h.expectedArrivalDate) e.expectedArrivalDate = h.expectedArrivalDate;
      return e;
    }),
    endOfLife: null,
    dataOwner: { id: first.to, role: first.role === 'Fleet_Operator' ? 'Fleet_Operator' : 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
    ...overrides,
  };
}

const returnRecord: ReturnRecord = {
  batteryId: 'BR-RET',
  ownerId: 'OWN-001',
  offerId: 'BR-RET:OWN-001:return',
  returnDate: '2025-05-10',
  servicePartnerId: 'SP-001',
  servicePartnerName: 'Beta Service',
  finalImpactScore: 75,
  components: { charging: true, servicing: true, consent: false, return: true },
};

function buildStore(): Store {
  const twins: DigitalTwin[] = [
    twin('BR-OWN', [{ date: '2021-02-01', from: null, to: 'OWN-001', role: 'Owner' }]),
    twin(
      'BR-RET',
      [
        { date: '2021-02-01', from: null, to: 'OWN-001', role: 'Owner' },
        { date: '2025-05-10', from: 'OWN-001', to: 'SP-001', role: 'Service_Partner' },
      ],
      {
        returnRecords: [returnRecord],
        // Written after the handover; must never reach the Owner.
        serviceHistory: [{ date: '2025-05-20', faultCode: 'P0A80', actionTaken: 'post-return repair', modulesReplaced: [] }],
      },
    ),
    twin('BR-FLT', [{ date: '2021-02-01', from: null, to: 'FLT-001', role: 'Fleet_Operator' }], {
      inspectionFlags: [{ flagDate: '2025-05-15', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }],
    }),
    twin(
      'BR-SLP',
      [
        { date: '2021-02-01', from: null, to: 'OWN-002', role: 'Owner' },
        { date: '2025-03-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' },
        { date: '2025-03-05', from: 'SP-001', to: 'SLP-001', role: 'Second_Life_Provider' },
      ],
      {
        routedPathway: 'Second_Life_Review',
        consentEvents: [{ type: 'grant', at: '2025-02-01T00:00:00Z', byId: 'OWN-002' }],
      },
    ),
    twin(
      'BR-REC',
      [
        { date: '2021-02-01', from: null, to: 'OWN-002', role: 'Owner' },
        { date: '2025-04-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' },
        { date: '2025-04-02', from: 'SP-001', to: 'REC-001', role: 'Recycler', expectedArrivalDate: '2025-06-10' },
      ],
      { routedPathway: 'Certified_Recycling' },
    ),
  ];
  twins[4]!.passport.manufacturer = 'Other Co';
  const store = emptyStore(TODAY);
  store.stakeholders = stakeholders;
  for (const t of twins) store.twins[t.passport.batteryId] = t;
  return store;
}

function setup(store: Store = buildStore(), internal = false) {
  const repo = new MemoryRepository(store);
  const app = createApp({ repo, clock: fixedClock(TODAY), internal, logError: () => undefined });
  const as = (role: string, id: string) => ({
    get: (url: string) => request(app).get(url).set('X-Role', role).set('X-Identity', id),
  });
  return { repo, app, as };
}

function expectKeys(obj: object, allowed: readonly string[]) {
  for (const k of Object.keys(obj)) expect(allowed).toContain(k);
}

describe('role context', () => {
  it('rejects missing or invalid role/identity with INVALID_ROLE_CONTEXT and no data', async () => {
    const { app } = setup();
    const cases = [
      request(app).get('/api/batteries'),
      request(app).get('/api/batteries').set('X-Role', 'Admin').set('X-Identity', 'OWN-001'),
      request(app).get('/api/batteries').set('X-Role', 'Owner'),
      request(app).get('/api/batteries').set('X-Role', 'Owner').set('X-Identity', 'NOPE'),
      request(app).get('/api/batteries').set('X-Role', 'Fleet_Operator').set('X-Identity', 'OWN-001'),
      request(app).get('/api/batteries/BR-OWN').set('X-Role', 'Owner'),
    ];
    for (const r of await Promise.all(cases)) {
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_ROLE_CONTEXT');
      expect(r.body.batteries).toBeUndefined();
      expect(r.body.battery).toBeUndefined();
    }
  });

  it('lists stakeholders grouped by role, names sorted, without role headers', async () => {
    const { app } = setup();
    const r = await request(app).get('/api/stakeholders');
    expect(r.status).toBe(200);
    expect(r.body.roles).toHaveLength(6);
    expect(r.body.stakeholders.Service_Partner.map((s: { id: string }) => s.id)).toEqual(['SP-002', 'SP-001']);
    expect(r.body.stakeholders.ESG_Officer[0]).toEqual({ id: 'ESG-001', name: 'Esme', manufacturer: 'Volt Inc' });
  });
});

describe('Owner reads', () => {
  it('lists held batteries and Returned_Batteries, and persists reconciled nudges once', async () => {
    const { repo, as } = setup();
    const r = await as('Owner', 'OWN-001').get('/api/batteries');
    expect(r.status).toBe(200);
    expect(r.body.batteries.map((b: { batteryId: string }) => b.batteryId)).toEqual(['BR-OWN']);
    expectKeys(r.body.batteries[0], PERMITTED_FIELDS.Owner);
    expect(r.body.batteries[0].returnOffer.servicePartnerId).toBe('SP-001');
    expect(r.body.returnedBatteries).toHaveLength(1);
    expect(Object.keys(r.body.returnedBatteries[0]).sort()).toEqual([...PERMITTED_FIELDS.OwnerReturned].sort());
    expect(JSON.stringify(r.body.returnedBatteries)).not.toContain('post-return repair');

    const stored = await repo.getTwin('BR-OWN');
    expect(stored!.nudges.map((n) => [n.type, n.createdOn])).toEqual([['Return_Incentive', TODAY]]);
    const again = await as('Owner', 'OWN-001').get('/api/batteries');
    expect(again.body.batteries).toEqual(r.body.batteries);
    expect((await repo.getTwin('BR-OWN'))!.nudges).toEqual(stored!.nudges);
  });

  it('returns only the ReturnRecord view for a Returned_Battery detail', async () => {
    const { as } = setup();
    const r = await as('Owner', 'OWN-001').get('/api/batteries/BR-RET');
    expect(r.status).toBe(200);
    expect(r.body.battery).toEqual({
      batteryId: 'BR-RET',
      returnDate: '2025-05-10',
      servicePartnerName: 'Beta Service',
      finalImpactScore: 75,
      components: returnRecord.components,
    });
  });

  it('gives an empty list, not an error, when nothing is in scope', async () => {
    const { as } = setup();
    const r = await as('Owner', 'OWN-002').get('/api/batteries');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ batteries: [], returnedBatteries: [] });
  });
});

describe('uniform access denial', () => {
  it('answers nonexistent and out-of-scope IDs identically', async () => {
    const { as } = setup();
    const pairs: [string, string, string][] = [
      ['Owner', 'OWN-001', 'BR-FLT'],
      ['Owner', 'OWN-002', 'BR-RET'],
      ['Fleet_Operator', 'FLT-001', 'BR-OWN'],
      ['Service_Partner', 'SP-002', 'BR-RET'],
      ['Second_Life_Provider', 'SLP-001', 'BR-REC'],
      ['Recycler', 'REC-001', 'BR-SLP'],
      ['ESG_Officer', 'ESG-001', 'BR-REC'],
    ];
    for (const [role, id, battery] of pairs) {
      const out = await as(role, id).get(`/api/batteries/${battery}`);
      const missing = await as(role, id).get('/api/batteries/DOES-NOT-EXIST');
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ error: { code: 'ACCESS_DENIED', message: 'Access denied' } });
      expect(missing.status).toBe(403);
      expect(missing.body).toEqual(out.body);
    }
  });

  it('denies role-restricted endpoints to other roles', async () => {
    const { as } = setup();
    expect((await as('Owner', 'OWN-001').get('/api/fleet/forecast')).status).toBe(403);
    expect((await as('Fleet_Operator', 'FLT-001').get('/api/scope3?start=2025-01-01&end=2025-12-31')).status).toBe(403);
  });
});

describe('other role scopes and field whitelists', () => {
  it('Fleet_Operator: fleet list with forecast; forecast route', async () => {
    const { as } = setup();
    const r = await as('Fleet_Operator', 'FLT-001').get('/api/batteries');
    expect(r.body.batteries.map((b: { batteryId: string }) => b.batteryId)).toEqual(['BR-FLT']);
    expectKeys(r.body.batteries[0], PERMITTED_FIELDS.Fleet_Operator);
    expect(r.body.batteries[0].inspectionFlag).toMatchObject({ flagged: true, servicePartnerName: 'Alpha Service' });
    expect(r.body.replacementForecast).toHaveLength(4);
    const f = await as('Fleet_Operator', 'FLT-001').get('/api/fleet/forecast');
    expect(f.status).toBe(200);
    expect(f.body.replacementForecast[0].quarter).toBe('2025-Q2');
  });

  it('Service_Partner: holder, past-return, and inspection-only batteries', async () => {
    const { as } = setup();
    const sp2 = await as('Service_Partner', 'SP-002').get('/api/batteries');
    expect(sp2.body.batteries).toHaveLength(1);
    expect(sp2.body.batteries[0]).toMatchObject({
      batteryId: 'BR-FLT',
      assignment: 'ReferredForInspection',
      actionsEnabled: false,
      actionsDisabledReason: 'Custody handover from the Fleet_Operator is pending',
    });
    const sp1 = await as('Service_Partner', 'SP-001').get('/api/batteries');
    expect(sp1.body.batteries.map((b: { batteryId: string }) => b.batteryId)).toEqual(['BR-RET']);
    expect(sp1.body.batteries[0]).toMatchObject({ assignment: 'Assigned', actionsEnabled: true });
    expectKeys(sp1.body.batteries[0], PERMITTED_FIELDS.Service_Partner);
  });

  it('Second_Life_Provider and Recycler scopes', async () => {
    const { as } = setup();
    const slp = await as('Second_Life_Provider', 'SLP-001').get('/api/batteries');
    expect(slp.body.batteries.map((b: { batteryId: string }) => b.batteryId)).toEqual(['BR-SLP']);
    expectKeys(slp.body.batteries[0], PERMITTED_FIELDS.Second_Life_Provider);

    const rec = await as('Recycler', 'REC-001').get('/api/batteries');
    expect(rec.body.batteries).toEqual([
      {
        batteryId: 'BR-REC',
        chemistry: 'NMC',
        packMassKg: 400,
        location: { city: 'Oakland', state: 'CA' },
        expectedArrival: '2025-06-10',
        intakeStatus: 'Awaiting_Intake',
      },
    ]);
  });

  it('ESG_Officer: manufacturer scope, filtered custody, no Owner identity', async () => {
    const { as } = setup();
    const r = await as('ESG_Officer', 'ESG-001').get('/api/batteries');
    expect(r.body.batteries.map((b: { batteryId: string }) => b.batteryId)).toEqual(['BR-FLT', 'BR-OWN', 'BR-RET', 'BR-SLP']);
    for (const b of r.body.batteries) expectKeys(b, PERMITTED_FIELDS.ESG_Officer);
    const text = JSON.stringify(r.body);
    for (const needle of ['OWN-001', 'OWN-002', 'Alice Owner', 'Bob Owner']) expect(text).not.toContain(needle);
    const ret = r.body.batteries.find((b: { batteryId: string }) => b.batteryId === 'BR-RET');
    expect(ret.custodyLog).toEqual([
      { date: '2021-02-01', toRole: 'Owner' },
      { date: '2025-05-10', toRole: 'Service_Partner', toHolderId: 'SP-001', toHolderName: 'Beta Service' },
    ]);
    const detail = await as('ESG_Officer', 'ESG-001').get('/api/batteries/BR-OWN');
    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain('OWN-001');
  });
});

describe('Scope3 JSON and CSV', () => {
  const q = '?manufacturer=Volt%20Inc&start=2025-01-01&end=2025-12-31';

  it('returns the report for the officer manufacturer without Owner identity', async () => {
    const { as } = setup();
    const r = await as('ESG_Officer', 'ESG-001').get(`/api/scope3${q}`);
    expect(r.status).toBe(200);
    expect(r.body.report.rows.map((x: { batteryId: string }) => x.batteryId)).toEqual(['BR-FLT', 'BR-OWN', 'BR-RET', 'BR-SLP']);
    expect(r.body.report.counts).toEqual({ In_Use: 3, Second_Life: 1, Recycled: 0, Unknown: 0 });
    expect(r.body.report.measuredShare).toBe('100.0');
    expect(JSON.stringify(r.body)).not.toMatch(/OWN-00|Alice Owner|Bob Owner/);
  });

  it('exports CSV with the header and no custody data', async () => {
    const { as } = setup();
    const r = await as('ESG_Officer', 'ESG-001').get(`/api/scope3.csv${q}`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toContain('attachment');
    expect(r.text.startsWith('battery_id,disposition,measurement_status,data_confidence_score,consent_status,eol_date\r\n')).toBe(true);
    expect(r.text).toContain('not yet at end of life,3\r\n');
    expect(r.text).not.toMatch(/OWN-00|SP-001|Alice Owner/);
  });

  it('denies another manufacturer and validates the period', async () => {
    const { as } = setup();
    for (const path of ['/api/scope3', '/api/scope3.csv']) {
      const other = await as('ESG_Officer', 'ESG-001').get(`${path}?manufacturer=Other%20Co&start=2025-01-01&end=2025-12-31`);
      expect(other.status).toBe(403);
      expect(other.body).toEqual({ error: { code: 'ACCESS_DENIED', message: 'Access denied' } });

      const reversed = await as('ESG_Officer', 'ESG-001').get(`${path}?start=2025-12-31&end=2025-01-01`);
      expect(reversed.status).toBe(422);
      expect(reversed.body.error.code).toBe('VALIDATION_ERROR');
      expect(reversed.body.error.fields.map((f: { field: string }) => f.field)).toEqual(['end']);

      const missing = await as('ESG_Officer', 'ESG-001').get(`${path}?start=2025-02-30`);
      expect(missing.status).toBe(422);
      expect(missing.body.error.fields.map((f: { field: string }) => f.field)).toEqual(['start', 'end']);
    }
  });
});

describe('ESG guard', () => {
  it('assertNoOwnerIdentity throws INTERNAL on a planted leak and passes clean bodies', () => {
    expect(() => assertNoOwnerIdentity({ a: 'clean' }, ['OWN-001'], ['Alice Owner'])).not.toThrow();
    expect(() => assertNoOwnerIdentity('x,Alice Owner,y', ['OWN-001'], ['Alice Owner'])).toThrow(HttpError);
    try {
      assertNoOwnerIdentity({ id: 'OWN-001' }, ['OWN-001'], []);
    } catch (e) {
      expect((e as HttpError).code).toBe('INTERNAL');
    }
  });

  it('returns a generic INTERNAL error instead of leaking through an ESG route', async () => {
    const store = buildStore();
    // Corrupt data: an Owner id recorded as a Recycler holder would surface as toHolderId.
    store.twins['BR-OWN']!.custodyLog.push({ date: '2025-05-01', fromHolderId: 'OWN-001', toHolderId: 'OWN-002', toHolderRole: 'Recycler' });
    const { as } = setup(store);
    const r = await as('ESG_Officer', 'ESG-001').get('/api/batteries');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
});

describe('internal routes and error handling', () => {
  it('are not mounted by default', async () => {
    const { app } = setup();
    const r = await request(app).get('/api/internal/twins/BR-OWN');
    expect(r.status).not.toBe(200);
    expect(r.body.twin).toBeUndefined();
  });

  it('create validates, rejects duplicates, and retrieves unfiltered', async () => {
    const { app } = setup(buildStore(), true);
    const fresh = twin('BR-NEW', [{ date: '2021-02-01', from: null, to: 'OWN-001', role: 'Owner' }]);

    const bad = structuredClone(fresh) as unknown as { passport: { capacityKwh: number }; telemetry: { sohPct: number }[] };
    bad.passport.capacityKwh = 0;
    bad.telemetry[0]!.sohPct = 101;
    const rBad = await request(app).post('/api/internal/twins').send(bad);
    expect(rBad.status).toBe(422);
    expect(rBad.body.error.fields.map((f: { field: string }) => f.field).sort()).toEqual(['passport.capacityKwh', 'telemetry.0.sohPct']);
    expect((await request(app).get('/api/internal/twins/BR-NEW')).status).toBe(404);

    expect((await request(app).post('/api/internal/twins').send(fresh)).status).toBe(201);
    const dup = await request(app).post('/api/internal/twins').send(fresh);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('DUPLICATE_BATTERY_ID');

    const got = await request(app).get('/api/internal/twins/BR-NEW');
    expect(got.status).toBe(200);
    expect(got.body.twin).toEqual(fresh);
  });

  it('hides details of unexpected failures', async () => {
    const repo = new MemoryRepository(buildStore());
    repo.listTwins = async () => {
      throw new Error('disk exploded at C:\\secret');
    };
    const app = createApp({ repo, clock: fixedClock(TODAY), logError: () => undefined });
    const r = await request(app).get('/api/batteries').set('X-Role', 'Owner').set('X-Identity', 'OWN-001');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
});
