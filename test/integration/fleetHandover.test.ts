/**
 * Fleet handover integration scenario (task 16.3; Req 3.13, 3.14, 8.6, 8.7, 8.11–8.13, 9.2, 9.9).
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FLAGGED_FLEET_BATTERY_ID,
  FLAGGED_FLEET_SERVICE_PARTNER_ID,
  MAIN_FLEET_OPERATOR_ID,
  UNFLAGGED_FLEET_BATTERY_ID,
} from '../../scripts/seedGenerator';
import { PENDING_HANDOVER_REASON } from '../../src/core/projection';
import { RUN_DATE, as, seededApp, type SeededApp } from './helpers/seededApp';

const FLEET = as('Fleet_Operator', MAIN_FLEET_OPERATOR_ID);
const OTHER_FLEET = as('Fleet_Operator', 'FLT-002');

describe('fleet handover to the flagged Service_Partner', () => {
  let ctx: SeededApp;
  beforeAll(async () => {
    ctx = await seededApp();
  });
  afterAll(async () => {
    await ctx.cleanup();
  });

  it('flag → referred view with actions disabled → handover → repair', async () => {
    const { app, repo } = ctx;
    // Use a fresh unflagged fleet battery and a Service_Partner other than the seeded flag's.
    const batteryId = UNFLAGGED_FLEET_BATTERY_ID;
    const spId = FLAGGED_FLEET_SERVICE_PARTNER_ID;
    const SPH = as('Service_Partner', spId);
    const url = (p: string) => `/api/batteries/${batteryId}${p}`;

    // Handover before any flag is rejected with NO_INSPECTION_FLAG (Req 8.13).
    const early = await request(app).post(url('/handover')).set(FLEET).send({});
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(early.body.error.code).toBe('NO_INSPECTION_FLAG');

    // 1. Fleet_Operator flags the battery for the Service_Partner (Req 8.6).
    await request(app).post(url('/inspection-flag')).set(FLEET).send({ servicePartnerId: spId }).expect(200);

    // 2. The SP sees it as ReferredForInspection with actions disabled (Req 3.13, 9.9).
    const spList = await request(app).get('/api/batteries').set(SPH).expect(200);
    const view = spList.body.batteries.find((b: { batteryId: string }) => b.batteryId === batteryId);
    expect(view.assignment).toBe('ReferredForInspection');
    expect(view.actionsEnabled).toBe(false);
    expect(view.actionsDisabledReason).toBe(PENDING_HANDOVER_REASON);

    // 3. Repair, referral and dispatch are rejected and change nothing.
    const before = JSON.stringify(await repo.getTwin(batteryId));
    const repair = { date: RUN_DATE, faultCode: '', actionTaken: 'Replaced coolant pump', modulesReplaced: [] };
    for (const [path, body] of [
      ['/repairs', repair],
      ['/referral', { secondLifeProviderId: 'SLP-001' }],
      ['/dispatch', { recyclerId: 'RCY-001', expectedArrivalDate: RUN_DATE }],
    ] as const) {
      const res = await request(app).post(url(path)).set(SPH).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ACTION_NOT_PERMITTED');
    }
    expect(JSON.stringify(await repo.getTwin(batteryId))).toBe(before);

    // 4. A Fleet_Operator that does not hold the battery cannot hand it over.
    const other = await request(app).post(url('/handover')).set(OTHER_FLEET).send({});
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(['NOT_CURRENT_HOLDER', 'ACCESS_DENIED', 'ACTION_NOT_PERMITTED']).toContain(other.body.error.code);
    expect(JSON.stringify(await repo.getTwin(batteryId))).toBe(before);

    // 5. Handover makes the SP the Current_Holder (Req 8.12, 3.14).
    await request(app).post(url('/handover')).set(FLEET).send({}).expect(200);
    const twin = await repo.getTwin(batteryId);
    expect(twin!.custodyLog.at(-1)).toMatchObject({ toHolderId: spId, toHolderRole: 'Service_Partner', fromHolderId: MAIN_FLEET_OPERATOR_ID });

    // The battery leaves the fleet list.
    const fleetList = await request(app).get('/api/batteries').set(FLEET).expect(200);
    expect(fleetList.body.batteries.some((b: { batteryId: string }) => b.batteryId === batteryId)).toBe(false);

    // 6. The SP can now log a repair (Req 9.2).
    await request(app).post(url('/repairs')).set(SPH).send(repair).expect(200);
    const repaired = await repo.getTwin(batteryId);
    expect(repaired!.serviceHistory.at(-1)?.actionTaken).toBe('Replaced coolant pump');
  });

  it('the seeded flagged battery can be handed over to its flagged Service_Partner', async () => {
    const { app, repo } = ctx;
    await request(app).post(`/api/batteries/${FLAGGED_FLEET_BATTERY_ID}/handover`).set(FLEET).send({}).expect(200);
    const twin = await repo.getTwin(FLAGGED_FLEET_BATTERY_ID);
    expect(twin!.custodyLog.at(-1)?.toHolderId).toBe(FLAGGED_FLEET_SERVICE_PARTNER_ID);
  });
});
