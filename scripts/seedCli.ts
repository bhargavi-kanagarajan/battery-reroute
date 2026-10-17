/**
 * Seed_Script CLI logic (design: Seed_Script steps 1, 2, 8, 9; Req 2.8, 2.9, 2.11–2.13, 14.7).
 *
 *   npm run seed                 # DEFAULT_SEED
 *   npm run seed -- --seed 42    # also accepts --seed=42
 *
 * `runSeed` never calls `process.exit` and takes its I/O as parameters, so tests can run it
 * against a temp directory and an injected file system. It returns the process exit code.
 *
 * Order of operations (nothing touches the store until every check has passed):
 *   1. parse arguments; invalid seed → "Invalid seed value: …", exit 1
 *   2. runDate = BR_TODAY ?? local today
 *   3. generate the dataset in memory
 *   4. checkSeedInvariants (includes storeSchema validation of every twin)
 *   5. atomic write (temp file + rename) that replaces the whole store, so only twins from
 *      this run remain (Req 2.9). Any failure before the rename leaves the old store intact.
 */
import { checkSeedInvariants, formatSeedInvariantViolations } from './seedInvariants';
import { generateDataset, parseSeed } from './seedGenerator';
import { clockFromEnv } from '../src/server/clock';
import { DEFAULT_STORE_PATH, writeStoreAtomic, type FsOps } from '../src/server/repo/fileRepository';

export interface SeedOutput {
  write(text: string): void;
}

export interface RunSeedOptions {
  /** CLI arguments after the script name (i.e. `process.argv.slice(2)`). */
  argv?: readonly string[];
  /** Environment; only `BR_TODAY` is read. */
  env?: Record<string, string | undefined>;
  /** Target store file (default `data/store.json`). */
  storePath?: string;
  /** Injectable file operations for the atomic write (failure tests). */
  fsOps?: FsOps;
  /** Rename retry settings, forwarded to writeStoreAtomic. */
  renameAttempts?: number;
  renameBackoffMs?: number;
  stdout?: SeedOutput;
  stderr?: SeedOutput;
}

export type ParsedSeedArgs = { ok: true; seedArg: string | undefined } | { ok: false; error: string };

/**
 * Parses `--seed <value>` / `--seed=<value>`. A `--seed` flag with no value is reported as an
 * invalid seed; any other argument is rejected so a typo never seeds with an unintended value.
 */
export function parseSeedArgs(argv: readonly string[]): ParsedSeedArgs {
  let seedArg: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--seed') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: 'Invalid seed value: --seed requires an integer value' };
      }
      seedArg = next;
      i++;
    } else if (a.startsWith('--seed=')) {
      seedArg = a.slice('--seed='.length);
    } else {
      return { ok: false, error: `Unknown argument: ${JSON.stringify(a)}. Usage: npm run seed -- [--seed <integer>]` };
    }
  }
  return { ok: true, seedArg };
}

const errMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs the Seed_Script. Returns 0 on success, 1 on any failure (store left unchanged). */
export async function runSeed(opts: RunSeedOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? { write: (t) => process.stdout.write(t) };
  const stderr = opts.stderr ?? { write: (t) => process.stderr.write(t) };
  const storePath = opts.storePath ?? DEFAULT_STORE_PATH;

  // Step 1: arguments and seed (Req 2.11, 2.12).
  const args = parseSeedArgs(opts.argv ?? []);
  if (!args.ok) {
    stderr.write(`${args.error}\n`);
    return 1;
  }
  const seed = parseSeed(args.seedArg);
  if (!seed.ok) {
    stderr.write(`${seed.error}\n`);
    return 1;
  }

  try {
    // Step 2: run date.
    const runDate = clockFromEnv(opts.env ?? process.env).today();

    // Steps 3–8: build in memory, then validate and check invariants.
    const dataset = generateDataset(seed.value, runDate);
    const check = checkSeedInvariants(dataset, runDate);
    if (!check.ok) {
      throw new Error(`seed invariants not met:\n${formatSeedInvariantViolations(check.violations)}`);
    }

    // Step 9: atomic replace of the whole store (Req 2.9, 2.13, 14.7).
    await writeStoreAtomic(storePath, dataset, {
      fsOps: opts.fsOps,
      renameAttempts: opts.renameAttempts,
      renameBackoffMs: opts.renameBackoffMs,
    });

    const count = Object.keys(dataset.twins).length;
    stdout.write(`Seeded ${count} batteries (seed ${seed.value}, run date ${runDate}) into ${storePath}\n`);
    return 0;
  } catch (err) {
    stderr.write(`Seeding failed: ${errMessage(err)}\n`);
    return 1;
  }
}
