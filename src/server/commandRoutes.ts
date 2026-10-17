/**
 * Command routes (task 12.3; Req 3.9, 3.13, 3.14, 3.18, 4.1, 4.2, 4.12, 4.14, 7.6–7.8, 7.11,
 * 7.18, 7.21, 8.6, 8.10, 8.12, 8.13, 9.2, 9.4, 9.5, 10.3, 10.4, 11.3, 11.5).
 *
 * Every route runs the same flow; any failure writes nothing:
 *  1. resolve the role context (middleware, before any battery read);
 *  2. static role/action gate (`roleCanPerform`) → ACTION_NOT_PERMITTED, before the battery
 *     is loaded, so it reveals nothing about which battery IDs exist;
 *  3. inside `repo.updateTwin` (one queued read-modify-write):
 *     a. Owner Returned_Battery guard → ACTION_NOT_PERMITTED (Req 3.18, 4.14). It runs before
 *        the scope check because a Returned_Battery is not in the Owner's live scope;
 *     b. scope check (`inScope`) → the route's "out of view" error. A nonexistent battery ID gets
 *        the very same error body, so the two cases are indistinguishable (Req 3.8);
 *     c. payload validation + the pure command from `core/commands`, which owns the
 *        state-dependent checks and their specific codes;
 *     d. full-twin schema validation and the append-only guard on the result;
 *  4. the repository persists the new twin in one atomic write;
 *  5. respond with the updated projected view for the viewer (`battery`, or `null` when the
 *     command moved the battery out of the viewer's scope) plus the command payload.
 *
 * "Out of view" error per route (identical for nonexistent and out-of-scope IDs):
 *  - consent, return-offer accept, repairs, referral, SP dispatch: ACCESS_DENIED
 *  - inspection-flag, handover (Fleet_Operator): NOT_CURRENT_HOLDER (Req 8.10, 8.13)
 *  - second-life accept, SLP dispatch: NOT_AVAILABLE (Req 10.7)
 *  - intake, materials: VALIDATION_ERROR on `batteryId` (Req 11.4)
 */
import { Router } from 'express';
import { z } from 'zod';
import { inScope, roleCanPerform } from '../core/access';
import {
  acceptReturnOffer,
  acceptSecondLife,
  dispatchToRecycler,
  flagInspection,
  handOverToServicePartner,
  logIntake,
  logMaterials,
  logRepair,
  recordConsent,
  referToSecondLife,
  type CommandResult,
} from '../core/commands';
import { evaluateDerived, project } from '../core/projection';
import { assertAppendOnlyChanges, seededDigitalTwinSchema, validate } from '../core/schemas';
import { isReturnedFor } from '../core/telemetry';
import type { Action, DigitalTwin, DomainError, ISODate, ISODateTime, Stakeholder, ViewerContext } from '../core/types';
import { HttpError, accessDenied, fromDomainError } from './errors';
import { asyncHandler, type AppDeps } from './http';
import { getContext } from './roleContext';

type Body = Record<string, unknown>;

interface CommandSpec<P extends object> {
  action: Action;
  /** Error for a battery the viewer cannot see (also used for nonexistent IDs). */
  outOfView: (viewer: ViewerContext) => HttpError;
  run: (twin: DigitalTwin, viewer: ViewerContext, body: Body, stakeholders: Stakeholder[], today: ISODate) => CommandResult<P>;
  /** Command-specific response fields added next to `battery`. */
  respond: (output: P) => object;
}

const actionNotPermitted = () =>
  new HttpError('ACTION_NOT_PERMITTED', 'This action is not permitted for the active role');

const notCurrentHolderFlag = () =>
  new HttpError('NOT_CURRENT_HOLDER', 'Only the Fleet_Operator holding this battery can flag it for inspection');
const notCurrentHolderHandover = () =>
  new HttpError('NOT_CURRENT_HOLDER', 'Only the Fleet_Operator holding this battery can hand it over');
const notAvailableToSlp = () =>
  new HttpError('NOT_AVAILABLE', 'The battery is not available to this Second_Life_Provider');
const notInRecyclerView = () =>
  new HttpError('VALIDATION_ERROR', 'The battery is not in this Recycler\u2019s incoming list', [
    { field: 'batteryId', message: 'Must be a battery dispatched to this Recycler' },
  ]);

/** Sentinel the mutator returns when the battery is out of the viewer's scope. */
const OUT_OF_VIEW: DomainError = { code: 'ACCESS_DENIED', message: 'out of view' };

const consentBodySchema = z.object({
  action: z.enum(['grant', 'withdraw'], { required_error: 'Required', invalid_type_error: "Must be 'grant' or 'withdraw'" }),
});

/** Consent timestamp: the clock's date with the current UTC time of day (ordering within a day). */
function consentTimestamp(today: ISODate): ISODateTime {
  return `${today}T${new Date().toISOString().slice(11)}`;
}

const asBody = (value: unknown): Body =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Body) : {};

export function createCommandRouter({ repo, clock }: AppDeps): Router {
  const router = Router();

  function mount<P extends object>(path: string, spec: CommandSpec<P>): void {
    router.post(
      `/batteries/:id/${path}`,
      asyncHandler(async (req, res) => {
        const { viewer, stakeholders } = getContext(res);
        if (!roleCanPerform(viewer.role, spec.action)) throw actionNotPermitted();
        const today = clock.today();
        const body = asBody(req.body);
        const batteryId = req.params.id ?? '';

        let output: P | undefined;
        const result = await repo.updateTwin(batteryId, (current) => {
          if (viewer.role === 'Owner' && isReturnedFor(current, viewer.identityId)) {
            return { ok: false, error: actionNotPermitted().toBody().error };
          }
          if (!inScope(current, viewer)) return { ok: false, error: OUT_OF_VIEW };

          const command = spec.run(current, viewer, body, stakeholders, today);
          if (!command.ok) return command;
          const { twin: next } = command.value;

          // Design write-flow step 6: the whole new twin must still be valid and append-only.
          // The seeded variant is used because stored twins may be seeded with empty passport fields.
          const full = validate(seededDigitalTwinSchema(today), next);
          if (!full.ok) return full;
          const guard = assertAppendOnlyChanges(current, next);
          if (!guard.ok) return guard;

          output = command.value;
          return { ok: true, value: next };
        });

        if (!result.ok) {
          if (result.error === OUT_OF_VIEW || result.error.code === 'NOT_FOUND') throw spec.outOfView(viewer);
          throw fromDomainError(result.error);
        }

        const twin = result.value;
        const visible = inScope(twin, viewer) || (viewer.role === 'Owner' && isReturnedFor(twin, viewer.identityId));
        const battery = visible ? project(twin, evaluateDerived(twin, today, viewer, stakeholders), viewer, stakeholders) : null;
        res.json({ battery, ...spec.respond(output as P) });
      }),
    );
  }

  // Owner or Fleet_Operator Data_Owner grants/withdraws Consent (Req 4.1, 4.2, 4.4, 4.12, 4.14).
  mount('consent', {
    action: 'consent',
    outOfView: accessDenied,
    run: (twin, viewer, body, _s, today) => {
      const parsed = validate(consentBodySchema, body);
      if (!parsed.ok) return parsed;
      return recordConsent(twin, viewer, parsed.value.action, consentTimestamp(today));
    },
    respond: ({ consentStatus }) => ({ consentStatus }),
  });

  // Owner accepts the active Return_Offer (Req 7.6, 7.7, 7.11, 7.18–7.20).
  mount('return-offer/accept', {
    action: 'acceptReturnOffer',
    outOfView: accessDenied,
    run: (twin, viewer, _b, stakeholders, today) => acceptReturnOffer(twin, viewer, stakeholders, today),
    respond: ({ confirmation }) => ({ confirmation }),
  });

  // Fleet_Operator flags a held battery for one Service_Partner (Req 8.6, 8.10).
  mount('inspection-flag', {
    action: 'flagInspection',
    outOfView: notCurrentHolderFlag,
    run: (twin, viewer, body, stakeholders, today) =>
      flagInspection(
        twin,
        viewer,
        { servicePartnerId: typeof body.servicePartnerId === 'string' ? body.servicePartnerId : null },
        stakeholders,
        today,
      ),
    respond: ({ inspectionFlag }) => ({ inspectionFlag }),
  });

  // Fleet_Operator hands custody to the most recently flagged Service_Partner (Req 8.12, 8.13).
  mount('handover', {
    action: 'handover',
    outOfView: notCurrentHolderHandover,
    run: (twin, viewer, _b, _s, today) => handOverToServicePartner(twin, viewer, today),
    respond: ({ servicePartnerId }) => ({ servicePartnerId }),
  });

  // Service_Partner holder logs a repair (Req 9.2, 9.3, 9.6).
  mount('repairs', {
    action: 'repair',
    outOfView: accessDenied,
    run: (twin, viewer, body, _s, today) =>
      logRepair(
        twin,
        viewer,
        { date: body.date, faultCode: body.faultCode, actionTaken: body.actionTaken, modulesReplaced: body.modulesReplaced },
        today,
      ),
    respond: ({ serviceRecord }) => ({ serviceRecord }),
  });

  // Service_Partner holder refers to a Second_Life_Provider (Req 9.4, 9.7).
  mount('referral', {
    action: 'referral',
    outOfView: accessDenied,
    run: (twin, viewer, body, stakeholders, today) =>
      referToSecondLife(twin, viewer, { secondLifeProviderId: body.secondLifeProviderId }, stakeholders, today),
    respond: ({ secondLifeProviderId }) => ({ secondLifeProviderId }),
  });

  // Service_Partner or Second_Life_Provider holder dispatches to a Recycler (Req 9.5, 10.4, 10.8).
  mount('dispatch', {
    action: 'dispatch',
    outOfView: (viewer) => (viewer.role === 'Second_Life_Provider' ? notAvailableToSlp() : accessDenied()),
    run: (twin, viewer, body, stakeholders, today) =>
      dispatchToRecycler(
        twin,
        viewer,
        { recyclerId: body.recyclerId, expectedArrivalDate: body.expectedArrivalDate },
        stakeholders,
        today,
      ),
    respond: ({ recyclerId, expectedArrivalDate }) => ({ recyclerId, expectedArrivalDate }),
  });

  // Second_Life_Provider accepts a battery in its view (Req 10.3, 10.6, 10.7).
  mount('second-life/accept', {
    action: 'acceptSecondLife',
    outOfView: notAvailableToSlp,
    run: (twin, viewer, _b, _s, today) => acceptSecondLife(twin, viewer, today),
    respond: ({ endOfLife }) => ({ endOfLife }),
  });

  // Recycler logs intake (Req 11.3, 11.4).
  mount('intake', {
    action: 'intake',
    outOfView: notInRecyclerView,
    run: (twin, viewer, body, _s, today) => logIntake(twin, viewer, { intakeDate: body.intakeDate }, today),
    respond: ({ recyclerIntake }) => ({ intakeDate: recyclerIntake.intakeDate, intakeStatus: 'Received' }),
  });

  // Recycler logs materials recovered (Req 11.5–11.7).
  mount('materials', {
    action: 'materials',
    outOfView: notInRecyclerView,
    run: (twin, viewer, body, _s, today) => logMaterials(twin, viewer, { materials: body.materials }, today),
    respond: ({ endOfLife }) => ({ endOfLife }),
  });

  return router;
}
