import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { DigitalTwin, HolderRole, ReturnRecord, Stakeholder, Store } from '../../src/core/types';
import { createApp } from '../../src/server/app';
import { fixedClock } from '../../src/server/clock';
import { BaseRepository, MemoryRepository, emptyStore } from '../../src/server/repo';

const TODAY = '2025-06-01';

const stakeholders: Stakeholder[] = [
  { id: 'OWN-001', role: 'Owner', name: 'Alice Owner', location: { city: 'Fresno', state: 'CA' } },
  { id: 'OWN-002', role: 'Owner', name: 'Bob Owner', location: { city: 'Austin', state: 'TX' } },
  { id: 'FLT-001', role: 'Fleet_Operator', name: 'City Fleet', location: { city: 'Austin', state: 'TX' } },
  { id: 'FLT-002', role: 'Fleet_Operator', name: 'Metro Fleet', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SP-001', role: 'Service_Partner', name: 'Beta Service', location: { city: 'Oakland', state: 'CA' } },
  { id: 'SP-002', role: 'Service_Partner', name: 'Alpha Service', location: { city: 'Dallas', state: 'TX' } },
  { id: 'SLP-001', role: 'Second_Life_Provider', name: 'ReLife', location: { city: 'Reno', state: 'NV' } },
  { id: 'REC-001', role: 'Recycler', name: 'CycleCo', location: { city: 'Phoenix', state: 'AZ' } },
  { id: 'ESG-001', role: 'ESG_Officer', name: 'Esme', location: { city: 'Detroit', state: 'MI' }, manufacturer: 'Volt Inc' },
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
    modules: [
      { moduleId: 'M1', condition: 'Good' },
      { moduleId: 'M2', condition: 'Failed' },
    ],
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

const ownerHop = (to: string): Hop => ({ date: '2021-02-01', from: null, to, role: 'Owner' });

function buildStore(): Store {
  const healthy = [{ timestamp: '2025-05-01T00:00:00Z', sohPct: 95, cycleCount: 100, thermalEventCount: 0 }];
  const twins: DigitalTwin[] = [
    // Owner-held, SoH 72 → Second_Life_Review → Return_Offer naming SP-001 (same state CA).
    twin('BR-OWN', [ownerHop('OWN-001')]),
    // Owner-held Continue_Use battery: no Return_Offer.
    twin('BR-OWN-OK', [ownerHop('OWN-002')], { telemetry: healthy }),
    // Held by OWN-002 but Data_Owner is OWN-001.
    twin('BR-OWN-X', [ownerHop('OWN-002')], { dataOwner: { id: 'OWN-001', role: 'Owner' } }),
    twin('BR-RET', [ownerHop('OWN-001'), { date: '2025-05-10', from: 'OWN-001', to: 'SP-001', role: 'Service_Partner' }], {
      returnRecords: [returnRecord],
    }),
    twin('BR-FLT', [{ date: '2021-02-01', from: null, to: 'FLT-001', role: 'Fleet_Operator' }], {
      inspectionFlags: [{ flagDate: '2025-05-15', fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-002' }],
    }),
    twin('BR-FLT2', [{ date: '2021-02-01', from: null, to: 'FLT-001', role: 'Fleet_Operator' }]),
    twin('BR-SP', [ownerHop('OWN-002'), { date: '2025-03-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' }], {
      consentEvents: [{ type: 'grant', at: '2025-02-01T00:00:00Z', byId: 'OWN-002' }],
    }),
    twin(
      'BR-SLP',
      [
        ownerHop('OWN-002'),
        { date: '2025-03-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' },
        { date: '2025-03-05', from: 'SP-001', to: 'SLP-001', role: 'Second_Life_Provider' },
      ],
      { routedPathway: 'Second_Life_Review' },
    ),
    twin(
      'BR-SLP-HOT',
      [
        ownerHop('OWN-002'),
        { date: '2025-03-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' },
        { date: '2025-03-05', from: 'SP-001', to: 'SLP-001', role: 'Second_Life_Provider' },
      ],
      {
        routedPathway: 'Second_Life_Review',
        telemetry: [{ timestamp: '2025-05-01T00:00:00Z', sohPct: 70, cycleCount: 900, thermalEventCount: 1 }],
      },
    ),
    twin(
      'BR-REC',
      [
        ownerHop('OWN-002'),
        { date: '2025-04-01', from: 'OWN-002', to: 'SP-001', role: 'Service_Partner' },
        { date: '2025-04-02', from: 'SP-001', to: 'REC-001', role: 'Recycler', expectedArrivalDate: '2025-06-10' },
      ],
      { routedPathway: 'Certified_Recycling' },
    ),
  ];
  const store = emptyStore(TODAY);
  store.stakeholders = stakeholders;
  for (const t of twins) store.twins[t.passport.batteryId] = t;
  return store;
}

function setup(repo: BaseRepository = new MemoryRepository(buildStore())) {
  const app = createApp({ repo, clock: fixedClock(TODAY), logError: () => undefined });
  const as = (role: string, id: string) => ({
    post: (url: string, body: object = {}) => request(app).post(url).set('X-Role', role).set('X-Identity', id).send(body),
  });
  return { repo, app, as };
}

const ACCESS_DENIED = { error: { code: 'ACCESS_DENIED', message: 'Access denied' } };
const fieldsOf = (body: { error: { fields?: { field: string }[] } }) => (body.error.fields ?? []).map((f) => f.field).sort();

/** Runs `fn` and asserts the whole store is deeply equal before and after. */
async function expectNoWrite(repo: BaseRepository, fn: () => Promise<unknown>) {
  const before = await repo.getStore();
  await fn();
  expect(await repo.getStore()).toEqual(before);
}

describe('route gating', () => {
  it('rejects invalid role context before any command', async () => {
    const { app, repo } = setup();
    await expectNoWrite(repo, async () => {
      const r = await request(app).post('/api/batteries/BR-OWN/consent').send({ action: 'grant' });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('INVALID_ROLE_CONTEXT');
    });
  });

  it('returns ACTION_NOT_PERMITTED for actions outside the role matrix, regardless of battery', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const cases: [string, string, string][] = [
        ['ESG_Officer', 'ESG-001', 'consent'],
        ['Service_Partner', 'SP-001', 'consent'],
        ['Owner', 'OWN-001', 'repairs'],
        ['Recycler', 'REC-001', 'dispatch'],
        ['Fleet_Operator', 'FLT-001', 'second-life/accept'],
      ];
      for (const [role, id, path] of cases) {
        for (const battery of ['BR-OWN', 'NOPE']) {
          const r = await as(role, id).post(`/api/batteries/${battery}/${path}`, { action: 'grant' });
          expect(r.status).toBe(403);
          expect(r.body.error.code).toBe('ACTION_NOT_PERMITTED');
        }
      }
    });
  });
});

describe('POST /consent', () => {
  it('grants and withdraws for the Owner Data_Owner and persists the events', async () => {
    const { as, repo } = setup();
    const g = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/consent', { action: 'grant' });
    expect(g.status).toBe(200);
    expect(g.body.consentStatus).toBe('granted');
    expect(g.body.battery).toMatchObject({ batteryId: 'BR-OWN', consentStatus: 'granted' });
    const w = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/consent', { action: 'withdraw' });
    expect(w.body.consentStatus).toBe('not_granted');
    const stored = (await repo.getTwin('BR-OWN'))!;
    expect(stored.consentEvents.map((e) => [e.type, e.byId, e.at.slice(0, 10)])).toEqual([
      ['grant', 'OWN-001', TODAY],
      ['withdraw', 'OWN-001', TODAY],
    ]);
  });

  it('accepts the Fleet_Operator Data_Owner', async () => {
    const { as } = setup();
    const r = await as('Fleet_Operator', 'FLT-001').post('/api/batteries/BR-FLT/consent', { action: 'grant' });
    expect(r.status).toBe(200);
    expect(r.body.battery.consentStatus).toBe('granted');
  });

  it('rejects bad payloads, non-Data_Owners, out-of-scope, and Returned_Batteries without writing', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const bad = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/consent', { action: 'maybe' });
      expect(bad.status).toBe(422);
      expect(fieldsOf(bad.body)).toEqual(['action']);

      const notOwner = await as('Owner', 'OWN-002').post('/api/batteries/BR-OWN-X/consent', { action: 'grant' });
      expect(notOwner.status).toBe(403);
      expect(notOwner.body.error.code).toBe('NOT_DATA_OWNER');

      const out = await as('Owner', 'OWN-002').post('/api/batteries/BR-OWN/consent', { action: 'grant' });
      const missing = await as('Owner', 'OWN-002').post('/api/batteries/NOPE/consent', { action: 'grant' });
      expect(out.status).toBe(403);
      expect(out.body).toEqual(ACCESS_DENIED);
      expect(missing.body).toEqual(out.body);

      const returned = await as('Owner', 'OWN-001').post('/api/batteries/BR-RET/consent', { action: 'grant' });
      expect(returned.status).toBe(403);
      expect(returned.body.error.code).toBe('ACTION_NOT_PERMITTED');
    });
  });
});

describe('POST /return-offer/accept', () => {
  it('hands over to the designated SP, records the ReturnRecord, and returns the confirmation', async () => {
    const { as, repo } = setup();
    const r = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/return-offer/accept');
    expect(r.status).toBe(200);
    expect(r.body.confirmation).toMatchObject({
      message: 'Return accepted, +25 Impact points',
      servicePartnerName: 'Beta Service',
      acceptanceDate: TODAY,
    });
    expect(r.body.confirmation.components.return).toBe(true);
    expect(r.body.battery).toEqual({
      batteryId: 'BR-OWN',
      returnDate: TODAY,
      servicePartnerName: 'Beta Service',
      finalImpactScore: r.body.confirmation.finalImpactScore,
      components: r.body.confirmation.components,
    });
    const stored = (await repo.getTwin('BR-OWN'))!;
    expect(stored.custodyLog.at(-1)).toEqual({ date: TODAY, fromHolderId: 'OWN-001', toHolderId: 'SP-001', toHolderRole: 'Service_Partner' });
    expect(stored.returnRecords).toHaveLength(1);
    expect(stored.nudges.some((n) => n.type === 'Return_Incentive')).toBe(false);

    // Re-acceptance: the battery is now a Returned_Battery for this Owner.
    await expectNoWrite(repo, async () => {
      const again = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/return-offer/accept');
      expect(again.status).toBe(403);
      expect(again.body.error.code).toBe('ACTION_NOT_PERMITTED');
    });
  });

  it('rejects when no Return_Offer is active, or the requester is not the holder', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const none = await as('Owner', 'OWN-002').post('/api/batteries/BR-OWN-OK/return-offer/accept');
      expect(none.status).toBe(409);
      expect(none.body.error.code).toBe('OFFER_NOT_ACCEPTABLE');
      const other = await as('Owner', 'OWN-002').post('/api/batteries/BR-OWN/return-offer/accept');
      expect(other.status).toBe(403);
      expect(other.body).toEqual(ACCESS_DENIED);
    });
  });
});

describe('POST /inspection-flag and /handover', () => {
  it('flags a held battery for a Service_Partner', async () => {
    const { as, repo } = setup();
    const r = await as('Fleet_Operator', 'FLT-001').post('/api/batteries/BR-FLT2/inspection-flag', { servicePartnerId: 'SP-001' });
    expect(r.status).toBe(200);
    expect(r.body.inspectionFlag).toEqual({ flagDate: TODAY, fleetOperatorId: 'FLT-001', servicePartnerId: 'SP-001' });
    expect(r.body.battery.inspectionFlag).toMatchObject({ flagged: true, servicePartnerId: 'SP-001', servicePartnerName: 'Beta Service' });
    expect((await repo.getTwin('BR-FLT2'))!.inspectionFlags).toHaveLength(1);
  });

  it('rejects a missing Service_Partner and non-holder Fleet_Operators', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const noSp = await as('Fleet_Operator', 'FLT-001').post('/api/batteries/BR-FLT2/inspection-flag', {});
      expect(noSp.status).toBe(422);
      expect(fieldsOf(noSp.body)).toEqual(['servicePartnerId']);
      const notHolder = await as('Fleet_Operator', 'FLT-002').post('/api/batteries/BR-FLT2/inspection-flag', { servicePartnerId: 'SP-001' });
      const missing = await as('Fleet_Operator', 'FLT-002').post('/api/batteries/NOPE/inspection-flag', { servicePartnerId: 'SP-001' });
      expect(notHolder.status).toBe(409);
      expect(notHolder.body.error.code).toBe('NOT_CURRENT_HOLDER');
      expect(missing.body).toEqual(notHolder.body);
    });
  });

  it('hands over to the most recently flagged SP; rejects unflagged and non-holder requests', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const unflagged = await as('Fleet_Operator', 'FLT-001').post('/api/batteries/BR-FLT2/handover');
      expect(unflagged.status).toBe(409);
      expect(unflagged.body.error.code).toBe('NO_INSPECTION_FLAG');
      const notHolder = await as('Fleet_Operator', 'FLT-002').post('/api/batteries/BR-FLT/handover');
      const missing = await as('Fleet_Operator', 'FLT-002').post('/api/batteries/NOPE/handover');
      expect(notHolder.status).toBe(409);
      expect(notHolder.body.error.code).toBe('NOT_CURRENT_HOLDER');
      expect(missing.body).toEqual(notHolder.body);
    });

    // Before the handover the inspection-only SP cannot repair.
    await expectNoWrite(repo, async () => {
      const early = await as('Service_Partner', 'SP-002').post('/api/batteries/BR-FLT/repairs', { date: TODAY, actionTaken: 'x' });
      expect(early.status).toBe(403);
      expect(early.body.error.code).toBe('ACTION_NOT_PERMITTED');
    });

    const r = await as('Fleet_Operator', 'FLT-001').post('/api/batteries/BR-FLT/handover');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ battery: null, servicePartnerId: 'SP-002' });
    expect((await repo.getTwin('BR-FLT'))!.custodyLog.at(-1)).toEqual({
      date: TODAY,
      fromHolderId: 'FLT-001',
      toHolderId: 'SP-002',
      toHolderRole: 'Service_Partner',
    });
    const repair = await as('Service_Partner', 'SP-002').post('/api/batteries/BR-FLT/repairs', { date: TODAY, actionTaken: 'checked' });
    expect(repair.status).toBe(200);
    expect(repair.body.battery).toMatchObject({ assignment: 'Assigned', actionsEnabled: true });
  });
});

describe('Service_Partner commands', () => {
  it('logs a repair and sets replaced modules to Good', async () => {
    const { as, repo } = setup();
    const payload = { date: '2025-05-30', faultCode: 'P0A80', actionTaken: 'Replaced module M2', modulesReplaced: ['M2'] };
    const r = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/repairs', payload);
    expect(r.status).toBe(200);
    expect(r.body.serviceRecord).toEqual(payload);
    expect(r.body.battery.serviceHistory[0]).toEqual(payload);
    const stored = (await repo.getTwin('BR-SP'))!;
    expect(stored.modules).toEqual([
      { moduleId: 'M1', condition: 'Good' },
      { moduleId: 'M2', condition: 'Good' },
    ]);
    expect(stored.serviceHistory).toHaveLength(2);
  });

  it('rejects invalid repairs naming each field, and out-of-scope SPs', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const bad = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/repairs', {
        date: '2025-07-01',
        actionTaken: '',
        modulesReplaced: ['M9'],
      });
      expect(bad.status).toBe(422);
      expect(fieldsOf(bad.body)).toEqual(['actionTaken', 'date', 'modulesReplaced.0']);
      const out = await as('Service_Partner', 'SP-002').post('/api/batteries/BR-SP/repairs', { date: TODAY, actionTaken: 'x' });
      const missing = await as('Service_Partner', 'SP-002').post('/api/batteries/NOPE/repairs', { date: TODAY, actionTaken: 'x' });
      expect(out.status).toBe(403);
      expect(out.body).toEqual(ACCESS_DENIED);
      expect(missing.body).toEqual(out.body);
    });
  });

  it('refers to a Second_Life_Provider; rejects a wrong-role target', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const bad = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/referral', { secondLifeProviderId: 'REC-001' });
      expect(bad.status).toBe(422);
      expect(fieldsOf(bad.body)).toEqual(['secondLifeProviderId']);
    });
    const r = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/referral', { secondLifeProviderId: 'SLP-001' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ battery: null, secondLifeProviderId: 'SLP-001' });
    const stored = (await repo.getTwin('BR-SP'))!;
    expect(stored.routedPathway).toBe('Second_Life_Review');
    expect(stored.custodyLog.at(-1)).toMatchObject({ toHolderId: 'SLP-001', toHolderRole: 'Second_Life_Provider', date: TODAY });
  });

  it('dispatches to a Recycler with a valid arrival date', async () => {
    const { as, repo } = setup();
    await expectNoWrite(repo, async () => {
      const bad = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/dispatch', { recyclerId: 'SLP-001', expectedArrivalDate: '2025-12-31' });
      expect(bad.status).toBe(422);
      expect(fieldsOf(bad.body)).toEqual(['expectedArrivalDate', 'recyclerId']);
    });
    const r = await as('Service_Partner', 'SP-001').post('/api/batteries/BR-SP/dispatch', { recyclerId: 'REC-001', expectedArrivalDate: '2025-06-15' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ battery: null, recyclerId: 'REC-001', expectedArrivalDate: '2025-06-15' });
    const stored = (await repo.getTwin('BR-SP'))!;
    expect(stored.routedPathway).toBe('Certified_Recycling');
    expect(stored.custodyLog.at(-1)).toMatchObject({ toHolderId: 'REC-001', expectedArrivalDate: '2025-06-15' });
  });
});

describe('Second_Life_Provider commands', () => {
  it('accepts a battery once; rejects safety-flagged and out-of-view batteries', async () => {
    const { as, repo } = setup();
    const r = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-SLP/second-life/accept');
    expect(r.status).toBe(200);
    expect(r.body.endOfLife).toMatchObject({ pathway: 'Second_Life_Review', date: TODAY, receivingPartyId: 'SLP-001' });
    expect(r.body.battery.acceptance).toBe('Accepted');

    await expectNoWrite(repo, async () => {
      const again = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-SLP/second-life/accept');
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('NOT_AVAILABLE');
      const hot = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-SLP-HOT/second-life/accept');
      expect(hot.status).toBe(409);
      expect(hot.body.error.code).toBe('SAFETY_FLAGGED');
      const out = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-REC/second-life/accept');
      const missing = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/NOPE/second-life/accept');
      expect(out.status).toBe(409);
      expect(out.body.error.code).toBe('NOT_AVAILABLE');
      expect(missing.body).toEqual(out.body);
      const outDispatch = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-REC/dispatch', {
        recyclerId: 'REC-001',
        expectedArrivalDate: TODAY,
      });
      expect(outDispatch.body).toEqual(out.body);
    });
  });

  it('dispatches a safety-flagged battery to a Recycler', async () => {
    const { as, repo } = setup();
    const r = await as('Second_Life_Provider', 'SLP-001').post('/api/batteries/BR-SLP-HOT/dispatch', {
      recyclerId: 'REC-001',
      expectedArrivalDate: '2025-08-30',
    });
    expect(r.status).toBe(200);
    expect((await repo.getTwin('BR-SLP-HOT'))!.routedPathway).toBe('Certified_Recycling');
  });
});

describe('Recycler commands', () => {
  it('logs intake then materials, enforcing order and ranges', async () => {
    const { as, repo } = setup();
    const rec = as('Recycler', 'REC-001');
    await expectNoWrite(repo, async () => {
      const early = await rec.post('/api/batteries/BR-REC/materials', { materials: { cobalt: 10 } });
      expect(early.status).toBe(409);
      expect(early.body.error.code).toBe('INTAKE_REQUIRED');
      const before = await rec.post('/api/batteries/BR-REC/intake', { intakeDate: '2025-03-01' });
      expect(before.status).toBe(422);
      expect(fieldsOf(before.body)).toEqual(['intakeDate']);
      const out = await rec.post('/api/batteries/BR-SLP/intake', { intakeDate: TODAY });
      const missing = await rec.post('/api/batteries/NOPE/intake', { intakeDate: TODAY });
      expect(out.status).toBe(422);
      expect(fieldsOf(out.body)).toEqual(['batteryId']);
      expect(missing.body).toEqual(out.body);
    });

    const intake = await rec.post('/api/batteries/BR-REC/intake', { intakeDate: '2025-05-01' });
    expect(intake.status).toBe(200);
    expect(intake.body).toMatchObject({ intakeDate: '2025-05-01', intakeStatus: 'Received' });
    expect(intake.body.battery.intakeStatus).toBe('Received');
    expect((await repo.getTwin('BR-REC'))!.custodyLog).toHaveLength(3);

    await expectNoWrite(repo, async () => {
      const twice = await rec.post('/api/batteries/BR-REC/intake', { intakeDate: '2025-05-02' });
      expect(twice.status).toBe(422);
      expect(fieldsOf(twice.body)).toEqual(['intakeStatus']);
      const heavy = await rec.post('/api/batteries/BR-REC/materials', { materials: { cobalt: 300, nickel: 200 } });
      expect(heavy.status).toBe(422);
      expect(fieldsOf(heavy.body)).toEqual(['materials']);
    });

    const m = await rec.post('/api/batteries/BR-REC/materials', { materials: { cobalt: 20, lithium: 15.5 } });
    expect(m.status).toBe(200);
    expect(m.body.endOfLife).toEqual({
      pathway: 'Certified_Recycling',
      date: TODAY,
      receivingPartyId: 'REC-001',
      materialsRecoveredKg: { cobalt: 20, lithium: 15.5 },
    });
    expect((await repo.getTwin('BR-REC'))!.endOfLife?.pathway).toBe('Certified_Recycling');
  });
});

describe('persistence failure', () => {
  class FailingRepository extends BaseRepository {
    constructor(store: Store) {
      super(store);
    }
    protected async persist(): Promise<void> {
      throw new Error('disk full at C:\\secret');
    }
  }

  it('returns a generic INTERNAL error and keeps the store unchanged', async () => {
    const { as, repo } = setup(new FailingRepository(buildStore()));
    await expectNoWrite(repo, async () => {
      const r = await as('Owner', 'OWN-001').post('/api/batteries/BR-OWN/consent', { action: 'grant' });
      expect(r.status).toBe(500);
      expect(r.body).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    });
  });
});
