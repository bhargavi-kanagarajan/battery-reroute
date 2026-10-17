/**
 * `npm run seed` entry point. Thin wrapper around runSeed (see seedCli.ts).
 *   npm run seed -- --seed 42   optional integer seed (default DEFAULT_SEED)
 *   BR_TODAY                    optional YYYY-MM-DD run date override
 */
import { runSeed } from './seedCli';

runSeed({ argv: process.argv.slice(2), env: process.env }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`Seeding failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
