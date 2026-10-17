/**
 * JSON-file repository over `data/store.json` (Req 1.1, 1.9, 2.9, 2.13).
 *
 * Writes are atomic: the full store is written to `<file>.tmp` in the same directory and then
 * renamed over the target, so readers see either the old or the new store, never a partial one.
 * On Windows, renaming over a file that another process briefly holds open can fail with
 * EPERM/EBUSY/EACCES; the rename is retried with a short backoff before giving up. If the write
 * fails, the temp file is removed, the previous `store.json` is untouched, and the in-memory
 * cache keeps the previous store.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { formatZodErrors, storeSchema } from '../../core/schemas';
import type { FieldError, Store } from '../../core/types';
import { BaseRepository } from './repository';

/** Default store location, relative to the process working directory. */
export const DEFAULT_STORE_PATH = path.join('data', 'store.json');

/** Current store format version (Store.version). */
export const STORE_VERSION = 2;

/**
 * Write date used when validating a stored file on load. "Manufacture date not later than the
 * write date" (Req 1.2) is a write-time rule already checked when each twin was written, so the
 * load-time check only guards structure and ranges.
 */
const LOAD_WRITE_DATE = '9999-12-31';

/** File-system operations used for writes; injectable so tests can simulate failures. */
export interface FsOps {
  writeFile(file: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export const nodeFsOps: FsOps = {
  writeFile: (file, data) => fsp.writeFile(file, data, { encoding: 'utf8', flush: true }),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (file) => fsp.unlink(file),
};

export interface AtomicWriteOptions {
  fsOps?: FsOps;
  /** Rename attempts for transient Windows lock errors (default 8). */
  renameAttempts?: number;
  /** Base backoff in ms, multiplied by the attempt number (default 25). */
  renameBackoffMs?: number;
}

const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Serializes a store exactly as it is written to disk. */
export function serializeStore(store: Store): string {
  return `${JSON.stringify(store, null, 2)}\n`;
}

/**
 * Atomically writes `store` to `filePath` via `<filePath>.tmp` + rename. Creates the parent
 * directory if needed. Throws on failure, after removing the temp file; the target is unchanged.
 */
export async function writeStoreAtomic(
  filePath: string,
  store: Store,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const fsOps = opts.fsOps ?? nodeFsOps;
  const attempts = Math.max(1, opts.renameAttempts ?? 8);
  const backoff = opts.renameBackoffMs ?? 25;
  const tmp = `${filePath}.tmp`;

  await fsp.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  try {
    await fsOps.writeFile(tmp, serializeStore(store));
    for (let attempt = 1; ; attempt++) {
      try {
        await fsOps.rename(tmp, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (attempt >= attempts || !code || !TRANSIENT_RENAME_CODES.has(code)) throw err;
        await sleep(backoff * attempt);
      }
    }
  } catch (err) {
    await fsOps.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export type StoreLoadErrorKind = 'missing' | 'unreadable' | 'invalid_json' | 'wrong_version' | 'invalid';

/** Raised when the store file cannot be used. The message tells the user to run `npm run seed`. */
export class StoreLoadError extends Error {
  readonly kind: StoreLoadErrorKind;
  readonly fields: FieldError[];

  constructor(kind: StoreLoadErrorKind, detail: string, fields: FieldError[] = []) {
    super(`${detail}. Run "npm run seed" to create a fresh data store.`);
    this.name = 'StoreLoadError';
    this.kind = kind;
    this.fields = fields;
  }
}

/** Reads and validates a store file. Throws `StoreLoadError` when it is missing or invalid. */
export async function readStoreFile(filePath: string): Promise<Store> {
  let text: string;
  try {
    text = await fsp.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new StoreLoadError('missing', `Data store not found at ${filePath}`);
    throw new StoreLoadError('unreadable', `Data store at ${filePath} could not be read (${code ?? 'error'})`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new StoreLoadError('invalid_json', `Data store at ${filePath} is not valid JSON`);
  }

  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof raw === 'object' && raw !== null && version !== STORE_VERSION) {
    throw new StoreLoadError(
      'wrong_version',
      `Data store at ${filePath} has version ${JSON.stringify(version)}; version ${STORE_VERSION} is required`,
    );
  }

  const parsed = storeSchema(LOAD_WRITE_DATE).safeParse(raw);
  if (!parsed.success) {
    const fields = formatZodErrors(parsed.error);
    const first = fields
      .slice(0, 3)
      .map((f) => `${f.field}: ${f.message}`)
      .join('; ');
    throw new StoreLoadError('invalid', `Data store at ${filePath} failed validation (${first})`, fields);
  }
  return parsed.data;
}

export type FileRepositoryOptions = AtomicWriteOptions;

/** Repository persisted to a JSON file with atomic, serialized writes. */
export class FileRepository extends BaseRepository {
  readonly filePath: string;
  private readonly writeOpts: AtomicWriteOptions;

  private constructor(filePath: string, initial: Store, opts: FileRepositoryOptions) {
    super(initial);
    this.filePath = filePath;
    this.writeOpts = opts;
  }

  /** Opens an existing, valid store file. Throws `StoreLoadError` if it is missing or invalid. */
  static async open(filePath: string = DEFAULT_STORE_PATH, opts: FileRepositoryOptions = {}): Promise<FileRepository> {
    const store = await readStoreFile(filePath);
    return new FileRepository(filePath, store, opts);
  }

  /** Creates (or overwrites) the store file with `store`, then opens it. Used by the Seed_Script. */
  static async create(
    filePath: string,
    store: Store,
    opts: FileRepositoryOptions = {},
  ): Promise<FileRepository> {
    await writeStoreAtomic(filePath, store, opts);
    return new FileRepository(filePath, store, opts);
  }

  protected persist(next: Store): Promise<void> {
    return writeStoreAtomic(this.filePath, next, this.writeOpts);
  }
}
