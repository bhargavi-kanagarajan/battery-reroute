/**
 * Internal, test-only routes (Req 1.1, 1.9, 1.12, 1.14). Mounted only when
 * `createApp({ internal: true })`; the default app never exposes unfiltered twins.
 */
import { Router } from 'express';
import { digitalTwinSchema, validate } from '../core/schemas';
import type { DigitalTwin } from '../core/types';
import { HttpError, fromDomainError } from './errors';
import { asyncHandler, type AppDeps } from './http';

export function createInternalRouter({ repo, clock }: AppDeps): Router {
  const router = Router();

  // Create a twin: full validation naming every invalid field; nothing is stored on failure.
  router.post(
    '/twins',
    asyncHandler(async (req, res) => {
      const parsed = validate(digitalTwinSchema({ writeDate: clock.today() }), req.body);
      if (!parsed.ok) throw fromDomainError(parsed.error);
      const created = await repo.createTwin(parsed.value as DigitalTwin);
      if (!created.ok) throw fromDomainError(created.error);
      res.status(201).json({ twin: created.value });
    }),
  );

  // Unfiltered retrieval before role-based filtering.
  router.get(
    '/twins/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      const twin = await repo.getTwin(id);
      if (!twin) throw new HttpError('NOT_FOUND', `Battery ${id} was not found`);
      res.json({ twin });
    }),
  );

  return router;
}
