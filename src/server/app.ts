/**
 * Express app factory for the API_Server.
 *
 * Route layout:
 *   GET  /api/stakeholders            no role context (Role_Switcher list; no battery data)
 *   /api/internal/*                   only when `internal: true` (tests)
 *   /api/*                            role context middleware, then read routes and command routes
 *                                     (command routes are always mounted; see commandRoutes.ts)
 *
 * Errors use one JSON shape `{ error: { code, message, fields? } }`. Unexpected failures
 * become a generic INTERNAL error; details go to the logger only.
 */
import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Router } from 'express';
import { ROLES } from '../core/schemas';
import type { Role } from '../core/types';
import { clockFromEnv, type Clock } from './clock';
import { HttpError, INTERNAL_MESSAGE } from './errors';
import { createCommandRouter } from './commandRoutes';
import { asyncHandler, type AppDeps } from './http';
import { createInternalRouter } from './internalRoutes';
import { createReadRouter } from './readRoutes';
import type { Repository } from './repo';
import { roleContext } from './roleContext';

export interface CreateAppOptions {
  repo: Repository;
  /** Defaults to `BR_TODAY` or the system date. */
  clock?: Clock;
  /** Mount the test-only `/api/internal` routes. Default false. */
  internal?: boolean;
  /**
   * Extra routers mounted under `/api` after the role context middleware and the built-in
   * read and command routes. Each receives the same deps.
   */
  routers?: ((deps: AppDeps) => Router)[];
  /** Hook for registering non-API routes (static assets, host page) after `/api`. */
  configure?: (app: Express, deps: AppDeps) => void;
  /** Logger for unexpected errors. Defaults to `console.error`. */
  logError?: (err: unknown) => void;
}

export interface StakeholderListEntry {
  id: string;
  name: string;
  manufacturer?: string;
}

function stakeholdersHandler(repo: Repository): RequestHandler {
  return asyncHandler(async (_req, res) => {
    const all = await repo.getStakeholders();
    const grouped = Object.fromEntries(ROLES.map((r) => [r, [] as StakeholderListEntry[]])) as Record<
      Role,
      StakeholderListEntry[]
    >;
    for (const s of all) {
      const entry: StakeholderListEntry = { id: s.id, name: s.name };
      if (s.role === 'ESG_Officer' && s.manufacturer !== undefined) entry.manufacturer = s.manufacturer;
      grouped[s.role].push(entry);
    }
    for (const role of ROLES) {
      grouped[role].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    }
    res.json({ roles: [...ROLES], stakeholders: grouped });
  });
}

export function createApp(opts: CreateAppOptions): Express {
  const deps: AppDeps = { repo: opts.repo, clock: opts.clock ?? clockFromEnv() };
  const logError = opts.logError ?? ((err: unknown) => console.error(err));
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/stakeholders', stakeholdersHandler(deps.repo));
  if (opts.internal) app.use('/api/internal', createInternalRouter(deps));

  const api = express.Router();
  api.use(roleContext(deps.repo));
  api.use(createReadRouter(deps));
  api.use(createCommandRouter(deps));
  for (const make of opts.routers ?? []) api.use(make(deps));
  api.use((_req, _res, next) => next(new HttpError('NOT_FOUND', 'Route not found')));
  app.use('/api', api);

  opts.configure?.(app, deps);

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json(err.toBody());
      return;
    }
    // Malformed JSON body from express.json().
    if ((err as { type?: string } | null)?.type === 'entity.parse.failed') {
      const body = new HttpError('VALIDATION_ERROR', 'Request body is not valid JSON', [
        { field: '(body)', message: 'Must be valid JSON' },
      ]);
      res.status(body.status).json(body.toBody());
      return;
    }
    logError(err);
    res.status(500).json(new HttpError('INTERNAL', INTERNAL_MESSAGE).toBody());
  };
  app.use(onError);

  return app;
}
