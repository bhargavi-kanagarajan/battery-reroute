/**
 * Repository abstraction over the Battery ReRoute data store (Req 1.1, 1.9, 2.9, 2.13).
 *
 * The store is held in memory as a single `Store` value. Every mutation runs through one
 * in-process queue, builds a complete next `Store`, persists it, and only then swaps the
 * in-memory cache. If persisting fails, the cache (and therefore every later read) still
 * reflects the previous store, so a failed write leaves stored data unchanged.
 *
 * All values handed in or out are deep copies: callers can never mutate the cache.
 *
 * The repository does not run domain validation (Zod schemas, append-only guard); route
 * handlers do that before calling a mutation. It only enforces store-level invariants:
 * one twin per battery ID (DUPLICATE_BATTERY_ID) and existence for replace (NOT_FOUND).
 */
import type { DigitalTwin, DomainError, Result, Stakeholder, Store } from '../../core/types';

/** A twin mutation run under the write queue. Return an error to abort without writing. */
export type TwinMutator = (current: DigitalTwin) => Result<DigitalTwin, DomainError>;

export interface Repository {
  /** Deep copy of the whole store. */
  getStore(): Promise<Store>;
  /** Every stakeholder identity, in stored order. */
  getStakeholders(): Promise<Stakeholder[]>;
  /** Every twin, ordered by battery ID ascending. */
  listTwins(): Promise<DigitalTwin[]>;
  /** The twin with this battery ID, or `undefined` when none is stored. */
  getTwin(batteryId: string): Promise<DigitalTwin | undefined>;
  /** Stores a new twin; rejects with DUPLICATE_BATTERY_ID if the ID is already stored (Req 1.12). */
  createTwin(twin: DigitalTwin): Promise<Result<DigitalTwin, DomainError>>;
  /** Replaces an existing twin (keyed by `passport.batteryId`); NOT_FOUND if absent. */
  replaceTwin(twin: DigitalTwin): Promise<Result<DigitalTwin, DomainError>>;
  /**
   * Atomic read-modify-write: loads the current twin and runs `mutate` inside the write queue,
   * so concurrent commands cannot interleave. Nothing is written when `mutate` returns an error.
   * The mutator must keep the same battery ID.
   */
  updateTwin(batteryId: string, mutate: TwinMutator): Promise<Result<DigitalTwin, DomainError>>;
  /** Replaces the entire store in one write (Seed_Script, Req 2.9). */
  replaceStore(store: Store): Promise<void>;
}

const clone = <T>(v: T): T => structuredClone(v);

function notFound(batteryId: string): DomainError {
  return { code: 'NOT_FOUND', message: `Battery ${batteryId} was not found` };
}

/** Shared cache + write-queue logic. Subclasses decide how a next store is persisted. */
export abstract class BaseRepository implements Repository {
  private cache: Store;
  private queue: Promise<unknown> = Promise.resolve();

  protected constructor(initial: Store) {
    this.cache = clone(initial);
  }

  /** Persists `next`. Must throw on failure; the cache is swapped only on success. */
  protected abstract persist(next: Store): Promise<void>;

  /** Runs `task` after every previously queued mutation settles. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    // Keep the chain alive regardless of this task's outcome.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Persists `next`, then makes it the cache. On failure the cache is untouched. */
  private async commit(next: Store): Promise<void> {
    await this.persist(next);
    this.cache = next;
  }

  async getStore(): Promise<Store> {
    return clone(this.cache);
  }

  async getStakeholders(): Promise<Stakeholder[]> {
    return clone(this.cache.stakeholders);
  }

  async listTwins(): Promise<DigitalTwin[]> {
    return Object.keys(this.cache.twins)
      .sort()
      .map((id) => clone(this.cache.twins[id] as DigitalTwin));
  }

  async getTwin(batteryId: string): Promise<DigitalTwin | undefined> {
    if (!Object.prototype.hasOwnProperty.call(this.cache.twins, batteryId)) return undefined;
    return clone(this.cache.twins[batteryId]);
  }

  createTwin(twin: DigitalTwin): Promise<Result<DigitalTwin, DomainError>> {
    return this.enqueue(async () => {
      const id = twin.passport.batteryId;
      if (Object.prototype.hasOwnProperty.call(this.cache.twins, id)) {
        return {
          ok: false,
          error: { code: 'DUPLICATE_BATTERY_ID', message: `Battery ID ${id} is already stored` },
        };
      }
      const copy = clone(twin);
      await this.commit({ ...this.cache, twins: { ...this.cache.twins, [id]: copy } });
      return { ok: true, value: clone(copy) };
    });
  }

  replaceTwin(twin: DigitalTwin): Promise<Result<DigitalTwin, DomainError>> {
    return this.updateTwin(twin.passport.batteryId, () => ({ ok: true, value: twin }));
  }

  updateTwin(batteryId: string, mutate: TwinMutator): Promise<Result<DigitalTwin, DomainError>> {
    return this.enqueue(async () => {
      if (!Object.prototype.hasOwnProperty.call(this.cache.twins, batteryId)) {
        return { ok: false, error: notFound(batteryId) };
      }
      const result = mutate(clone(this.cache.twins[batteryId] as DigitalTwin));
      if (!result.ok) return result;
      if (result.value.passport.batteryId !== batteryId) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Battery ID must not change',
            fields: [{ field: 'passport.batteryId', message: 'Must equal the stored battery ID' }],
          },
        };
      }
      const copy = clone(result.value);
      await this.commit({ ...this.cache, twins: { ...this.cache.twins, [batteryId]: copy } });
      return { ok: true, value: clone(copy) };
    });
  }

  replaceStore(store: Store): Promise<void> {
    return this.enqueue(() => this.commit(clone(store)));
  }
}

/** In-memory repository for tests. Nothing touches the file system. */
export class MemoryRepository extends BaseRepository {
  constructor(initial: Store = emptyStore()) {
    super(initial);
  }

  protected async persist(): Promise<void> {
    // Memory only: the base class swaps the cache.
  }
}

/** An empty, valid version-2 store. */
export function emptyStore(runDate = '2025-01-01', seed = 0): Store {
  return { version: 2, seed, runDate, stakeholders: [], twins: {} };
}
