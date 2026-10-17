/**
 * Small Express helpers shared by route modules.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Clock } from './clock';
import type { Repository } from './repo';

/** Dependencies every route module receives from `createApp`. */
export interface AppDeps {
  repo: Repository;
  clock: Clock;
}

/** Wraps an async handler so rejections reach the Express error middleware (Express 4). */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** First value of a query parameter as a string, or undefined. */
export function queryString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}
