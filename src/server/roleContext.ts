/**
 * Role context middleware (Req 3.1, 3.11).
 *
 * Resolves `X-Role` and `X-Identity` into a `ViewerContext` before any battery data is read.
 * A missing or unknown role, or an identity that is not a stored stakeholder of that role,
 * is rejected with `400 INVALID_ROLE_CONTEXT` and no data. The Role_Switcher stands in for
 * production authentication; these headers are not authenticated.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ROLES } from '../core/schemas';
import type { Role, Stakeholder, ViewerContext } from '../core/types';
import { HttpError } from './errors';
import type { Repository } from './repo';

export const ROLE_HEADER = 'X-Role';
export const IDENTITY_HEADER = 'X-Identity';

/** What the middleware stores on `res.locals` for downstream handlers. */
export interface RequestContext {
  viewer: ViewerContext;
  /** Stakeholder list as read for this request (reused by handlers). */
  stakeholders: Stakeholder[];
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);

/** Pure resolution step, exported for tests. */
export function resolveViewer(
  roleHeader: string | undefined,
  identityHeader: string | undefined,
  stakeholders: readonly Stakeholder[],
): ViewerContext {
  const role = roleHeader?.trim() ?? '';
  const identityId = identityHeader?.trim() ?? '';
  if (role === '') {
    throw new HttpError('INVALID_ROLE_CONTEXT', `Missing ${ROLE_HEADER} header`, [
      { field: ROLE_HEADER, message: 'Required' },
    ]);
  }
  if (!isRole(role)) {
    throw new HttpError('INVALID_ROLE_CONTEXT', `Invalid role: ${ROLE_HEADER} must be one of ${ROLES.join(', ')}`, [
      { field: ROLE_HEADER, message: `Must be one of ${ROLES.join(', ')}` },
    ]);
  }
  if (identityId === '') {
    throw new HttpError('INVALID_ROLE_CONTEXT', `Missing ${IDENTITY_HEADER} header`, [
      { field: IDENTITY_HEADER, message: 'Required' },
    ]);
  }
  const stakeholder = stakeholders.find((s) => s.id === identityId && s.role === role);
  if (!stakeholder) {
    throw new HttpError('INVALID_ROLE_CONTEXT', `Unknown identity for role ${role}`, [
      { field: IDENTITY_HEADER, message: `No ${role} identity with this ID exists` },
    ]);
  }
  const viewer: ViewerContext = { role, identityId };
  if (role === 'ESG_Officer' && stakeholder.manufacturer !== undefined) viewer.manufacturer = stakeholder.manufacturer;
  return viewer;
}

export function roleContext(repo: Repository): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    repo
      .getStakeholders()
      .then((stakeholders) => {
        const viewer = resolveViewer(req.get(ROLE_HEADER), req.get(IDENTITY_HEADER), stakeholders);
        const ctx: RequestContext = { viewer, stakeholders };
        res.locals.ctx = ctx;
        next();
      })
      .catch(next);
  };
}

/** The context set by `roleContext`. Throws INTERNAL if the middleware did not run. */
export function getContext(res: Response): RequestContext {
  const ctx = res.locals.ctx as RequestContext | undefined;
  if (!ctx) throw new HttpError('INTERNAL', 'Internal server error');
  return ctx;
}

/** Rejects with the uniform ACCESS_DENIED unless the viewer has one of `roles`. */
export function requireRole(res: Response, ...roles: Role[]): RequestContext {
  const ctx = getContext(res);
  if (!roles.includes(ctx.viewer.role)) throw new HttpError('ACCESS_DENIED', 'Access denied');
  return ctx;
}
