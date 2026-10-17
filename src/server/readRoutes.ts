/**
 * Read routes (Req 3.1–3.12, 3.15–3.17, 4.9, 7.10, 7.16, 8.4, 12.1, 12.8, 12.14, 12.15).
 *
 * All routes here run after `roleContext`, so the viewer is resolved before any battery read.
 * Scope and field filtering happen in `core/access` + `core/projection` before serialization;
 * every ESG_Officer response passes through `assertNoOwnerIdentity`.
 */
import { Router, type Response } from 'express';
import { inScope } from '../core/access';
import { replacementForecast } from '../core/forecast';
import { evaluateDerived, project, projectBatteryList, projectReturned } from '../core/projection';
import { buildScope3Report, toCsv, validatePeriod } from '../core/scope3';
import { isReturnedFor, returnRecordFor } from '../core/telemetry';
import type { DigitalTwin, ISODate, Stakeholder, ViewerContext } from '../core/types';
import { accessDenied, fromDomainError } from './errors';
import { assertNoOwnerIdentity, ownerIdentities } from './esgGuard';
import { asyncHandler, queryString, type AppDeps } from './http';
import { persistReconciledNudges } from './nudgeSync';
import { getContext, requireRole } from './roleContext';

/** Sends JSON; ESG_Officer bodies go through the Owner-identity guard first. */
function sendJson(res: Response, viewer: ViewerContext, body: unknown, stakeholders: Stakeholder[], twins: DigitalTwin[]) {
  if (viewer.role === 'ESG_Officer') {
    const { ownerIds, ownerNames } = ownerIdentities(stakeholders, twins);
    assertNoOwnerIdentity(body, ownerIds, ownerNames);
  }
  res.json(body);
}

/** Fleet twins currently held by this Fleet_Operator. */
function fleetTwins(twins: readonly DigitalTwin[], viewer: ViewerContext): DigitalTwin[] {
  return twins.filter((t) => inScope(t, viewer));
}

export function createReadRouter({ repo, clock }: AppDeps): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/batteries: scoped, projected list (empty list when none in scope)
  // -------------------------------------------------------------------------
  router.get(
    '/batteries',
    asyncHandler(async (_req, res) => {
      const { viewer, stakeholders } = getContext(res);
      const evalDate: ISODate = clock.today();
      const twins = await repo.listTwins();
      const list = projectBatteryList(twins, evalDate, viewer, stakeholders);
      await persistReconciledNudges(repo, Object.keys(list.nudgeUpdates), evalDate, viewer, stakeholders);

      if (viewer.role === 'Owner') {
        res.json({ batteries: list.batteries, returnedBatteries: list.returnedBatteries ?? [] });
        return;
      }
      if (viewer.role === 'Fleet_Operator') {
        res.json({ batteries: list.batteries, replacementForecast: replacementForecast(fleetTwins(twins, viewer), evalDate) });
        return;
      }
      sendJson(res, viewer, { batteries: list.batteries }, stakeholders, twins);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/batteries/:id: one projected battery; uniform ACCESS_DENIED otherwise
  // -------------------------------------------------------------------------
  router.get(
    '/batteries/:id',
    asyncHandler(async (req, res) => {
      const { viewer, stakeholders } = getContext(res);
      const evalDate = clock.today();
      const twin = await repo.getTwin(req.params.id ?? '');
      if (!twin) throw accessDenied();

      // Owner's Returned_Battery: only the immutable ReturnRecord view (Req 3.17).
      if (viewer.role === 'Owner' && !inScope(twin, viewer) && isReturnedFor(twin, viewer.identityId)) {
        res.json({ battery: projectReturned(returnRecordFor(twin, viewer.identityId)!) });
        return;
      }
      if (!inScope(twin, viewer)) throw accessDenied();

      const derived = evaluateDerived(twin, evalDate, viewer, stakeholders);
      if (derived.nudgesChanged) {
        await persistReconciledNudges(repo, [twin.passport.batteryId], evalDate, viewer, stakeholders);
      }
      const battery = project(twin, derived, viewer, stakeholders);
      sendJson(res, viewer, { battery }, stakeholders, [twin]);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/fleet/forecast: Replacement_Forecast for the acting Fleet_Operator
  // -------------------------------------------------------------------------
  router.get(
    '/fleet/forecast',
    asyncHandler(async (_req, res) => {
      const { viewer } = requireRole(res, 'Fleet_Operator');
      const evalDate = clock.today();
      const twins = await repo.listTwins();
      res.json({ evalDate, replacementForecast: replacementForecast(fleetTwins(twins, viewer), evalDate) });
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/scope3 and /api/scope3.csv (ESG_Officer only)
  // -------------------------------------------------------------------------
  async function scope3Report(query: Record<string, unknown>, res: Response) {
    const { viewer, stakeholders } = requireRole(res, 'ESG_Officer');
    // Default to the officer's own manufacturer; any other manufacturer is denied (Req 12.15).
    const manufacturer = queryString(query.manufacturer) ?? viewer.manufacturer;
    if (viewer.manufacturer === undefined || manufacturer !== viewer.manufacturer) throw accessDenied();
    const period = validatePeriod(queryString(query.start), queryString(query.end));
    if (!period.ok) throw fromDomainError(period.error);
    const twins = await repo.listTwins();
    const report = buildScope3Report(twins, stakeholders, manufacturer, period.value);
    const { ownerIds, ownerNames } = ownerIdentities(stakeholders, twins);
    return { report, ownerIds, ownerNames };
  }

  router.get(
    '/scope3',
    asyncHandler(async (req, res) => {
      const { report, ownerIds, ownerNames } = await scope3Report(req.query, res);
      assertNoOwnerIdentity(report, ownerIds, ownerNames);
      res.json({ report });
    }),
  );

  router.get(
    '/scope3.csv',
    asyncHandler(async (req, res) => {
      const { report, ownerIds, ownerNames } = await scope3Report(req.query, res);
      const csv = toCsv(report);
      assertNoOwnerIdentity(csv, ownerIds, ownerNames);
      const filename = `scope3-${report.periodStart}-${report.periodEnd}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
    }),
  );

  return router;
}
