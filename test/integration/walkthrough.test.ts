/**
 * Demo walkthrough integration test (task 16.2; Req 3.16, 3.17, 7.18, 7.21, 14.1, 14.6,
 * 14.8–14.10, 14.12, 14.13). Seeds a temporary store with the real Seed_Script, then drives the
 * API in README order with the README's IDs and reporting period.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEMO_BATTERY_ID,
  DEMO_ESG_OFFICER_ID,
  DEMO_MANUFACTURER,
  DEMO_OWNER_ID,
  DEMO_RECYCLER_ID,
  DEMO_SECOND_LIFE_PROVIDER_ID,
  DEMO_SERVICE_PARTNER_ID,
} from '../../scripts/seedGenerator';
import { parseScope3Csv } from '../../src/core/scope3';
import { RUN_DATE, as, installOfflineGuard, seededApp, type SeededApp } from './helpers/seededApp';

const OWNER = as('Owner', DEMO_OWNER_ID);
const SP = as('Service_Partner', DEMO_SERVICE_PARTNER_ID);
const SLP = as('Second_Life_Provider', DEMO_SECOND_LIFE_PROVIDER_ID);
const RCY = as('Recycler', DEMO_RECYCLER_ID);
const ESG = as('ESG_Officer', DEMO_ESG_OFFICER_ID);
const PERIOD = { start: `${RUN_DATE.slice(0, 4)}-01-01`, end: `${RUN_DATE.slice(0, 4)}-12-31` };

describe('README demo walkthrough (BR-DEMO-0001)', () => {
  let ctx: SeededApp;
  let guard: ReturnType<typeof installOfflineGuard>;
  const url = (p: string) => `/api/batteries/${encodeURIComponent(DEMO_BATTERY_ID)}${p}`;

  beforeAll(async () => {
    guard = installOfflineGuard();
    ctx = await seededApp();
  });
  afterAll(async () => {
    guard.restore();
    await ctx.cleanup();
  });

  it('runs every step from Owner to ESG export', async () => {
    const { app } = ctx;

    // Start state (Req 14.6): Owner-held, no consent, Second_Life_Review with a Return_Offer.
    const start = await request(app).get('/api/batteries').set(OWNER).expect(200);
    const demo = start.body.batteries.find((b: { batteryId: string }) => b.batteryId === DEMO_BATTERY_ID);
    expect(demo).toBeDefined();
    expect(demo.consentStatus).toBe('not_granted');
    expect(demo.pathway.pathway).toBe('Second_Life_Review');
    expect(demo.returnOffer.servicePartnerId).toBe(DEMO_SERVICE_PARTNER_ID);

    // 1. Owner grants Consent.
    const consent = await request(app).post(url('/consent')).set(OWNER).send({ action: 'grant' }).expect(200);
    expect(consent.body.consentStatus).toBe('granted');

    // 2. Owner accepts the Return_Offer → confirmation (Req 7.18).
    const accept = await request(app).post(url('/return-offer/accept')).set(OWNER).send({}).expect(200);
    expect(accept.body.confirmation.message).toBe('Return accepted, +25 Impact points');
    expect(accept.body.confirmation.servicePartnerName).toBeTruthy();
    expect(accept.body.confirmation.acceptanceDate).toBe(RUN_DATE);

    // 3. Returned batteries: Final_Impact_Score ≥ 50 with Consent and Return earned (Req 14.13).
    const afterReturn = await request(app).get('/api/batteries').set(OWNER).expect(200);
    expect(afterReturn.body.batteries.some((b: { batteryId: string }) => b.batteryId === DEMO_BATTERY_ID)).toBe(false);
    const returned = afterReturn.body.returnedBatteries.find((r: { batteryId: string }) => r.batteryId === DEMO_BATTERY_ID);
    expect(returned.finalImpactScore).toBeGreaterThanOrEqual(50);
    expect(returned.components.consent).toBe(true);
    expect(returned.components.return).toBe(true);
    expect(Object.keys(returned).sort()).toEqual(['batteryId', 'components', 'finalImpactScore', 'returnDate', 'servicePartnerName']);
    const snapshot = structuredClone(returned);

    // 4. Service_Partner refers the battery to the Second_Life_Provider.
    await request(app).post(url('/referral')).set(SP).send({ secondLifeProviderId: DEMO_SECOND_LIFE_PROVIDER_ID }).expect(200);

    // 5. Second_Life_Provider accepts, then dispatches to the Recycler.
    await request(app).post(url('/second-life/accept')).set(SLP).send({}).expect(200);
    await request(app)
      .post(url('/dispatch'))
      .set(SLP)
      .send({ recyclerId: DEMO_RECYCLER_ID, expectedArrivalDate: RUN_DATE })
      .expect(200);

    // 6. Recycler logs intake, then materials.
    await request(app).post(url('/intake')).set(RCY).send({ intakeDate: RUN_DATE }).expect(200);
    await request(app)
      .post(url('/materials'))
      .set(RCY)
      .send({ materials: { lithium: 45, nickel: 120, cobalt: 30 } })
      .expect(200);

    // Custody order SP → SLP → Recycler, Recycler is Current_Holder (Req 14.9).
    const twin = await ctx.repo.getTwin(DEMO_BATTERY_ID);
    const roles = twin!.custodyLog.map((e) => e.toHolderRole);
    expect(roles.slice(-3)).toEqual(['Service_Partner', 'Second_Life_Provider', 'Recycler']);
    expect(twin!.custodyLog.at(-1)!.toHolderId).toBe(DEMO_RECYCLER_ID);
    expect(twin!.endOfLife?.pathway).toBe('Certified_Recycling');

    // The Owner's returned entry is unchanged by everything after the handover (Req 7.21, 3.17).
    const later = await request(app).get('/api/batteries').set(OWNER).expect(200);
    expect(later.body.returnedBatteries.find((r: { batteryId: string }) => r.batteryId === DEMO_BATTERY_ID)).toEqual(snapshot);

    // 7. ESG_Officer: report and CSV show Recycled + Measured (Req 14.10).
    const report = await request(app).get('/api/scope3').query(PERIOD).set(ESG).expect(200);
    expect(report.body.report.manufacturer).toBe(DEMO_MANUFACTURER);
    const row = report.body.report.rows.find((r: { batteryId: string }) => r.batteryId === DEMO_BATTERY_ID);
    expect(row.disposition).toBe('Recycled');
    expect(row.measurementStatus).toBe('Measured');

    const csvRes = await request(app).get('/api/scope3.csv').query(PERIOD).set(ESG).expect(200);
    expect(csvRes.headers['content-type']).toMatch(/text\/csv/);
    const parsed = parseScope3Csv(csvRes.text);
    const csvRow = parsed.rows.find((r) => r.batteryId === DEMO_BATTERY_ID);
    expect(csvRow?.disposition).toBe('Recycled');
    expect(csvRow?.measurementStatus).toBe('Measured');

    // No Owner identity in any ESG output (Req 3.16).
    const esgList = await request(app).get('/api/batteries').set(ESG).expect(200);
    for (const body of [JSON.stringify(report.body), csvRes.text, JSON.stringify(esgList.body)]) {
      expect(body).not.toContain(DEMO_OWNER_ID);
      expect(body).not.toMatch(/OWN-\d{3}/);
      expect(body).not.toContain('Sample Owner');
    }

    // Offline (Req 14.1): no connection to anything but loopback.
    expect(guard.offending).toEqual([]);
  });
});
