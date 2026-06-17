import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Per-request cache for query results that are expensive to compute.
 *
 * Purpose: Avoid redundant MongoDB queries within a single HTTP request.
 * Example: User group relations are fetched multiple times by different
 * services (page queries, grant checks, page listing) — each calling
 * `findAllUserGroupIdsRelatedToUser` independently. This cache ensures
 * the same query runs only once per request.
 */
export type RequestContextStore = Map<string, unknown>;

export const requestContextStorage =
  new AsyncLocalStorage<RequestContextStore>();

/**
 * Create a fresh request-scoped context store.
 */
export function createRequestContextStore(): RequestContextStore {
  return new Map();
}

/**
 * Middleware that initializes a per-request context for query caching.
 * Must be registered early in the Express middleware chain, after
 * session/passport but before route handlers.
 */
export function requestContextMiddleware(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const store = createRequestContextStore();
  requestContextStorage.run(store, () => next());
}

/**
 * Cache key builder for user-group-related queries.
 */
export const UserGroupCacheKeys = {
  groupIds: (userId: string) => `ug:ids:${userId}`,
  groups: (userId: string) => `ug:groups:${userId}`,
} as const;
