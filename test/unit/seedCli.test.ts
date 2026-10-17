import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSeedArgs, runSeed, type RunSeedOptions } from '../../scripts/seedCli';
import { DEFAULT_SEED, DEMO_BATTERY_ID } from '../../scripts/seedGenerator';
import { FileRepository, nodeFsOps, readStoreFile, type FsOps } from '../../src/server/repo';

const RUN_DATE = '2025-06-15';
const ENV = { BR_TODAY: RUN_DATE };

let dir: string;
let storePath: string;

function capture() {
  let text = '';
  return { out: { write: (t: string) => void (text += t) }, text: () => text };
}

async function seed(argv: string[], extra: Partial<RunSeedOptions> = {}) {
  const stdout = capture();
  const stderr = capture();
  const code = await runSeed({ argv, env: ENV, storePath, stdout: stdout.out, stderr: stderr.out, ...extra });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const SENTINEL = '{"sentinel":true}\n';

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br-seed-'));
  storePath = path.join(dir, 'data', 'store.json');
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

describe('parseSeedArgs', () => {
  it('accepts no args, --seed N, and --seed=N', () => {
    expect(parseSeedArgs([])).toEqual({ ok: true, seedArg: undefined });
    expect(parseSeedArgs(['--seed', '42'])).toEqual({ ok: true, seedArg: '42' });
    expect(parseSeedArgs(['--seed=7'])).toEqual({ ok: true, seedArg: '7' });
  });

  it('rejects a --seed flag without a value and unknown arguments', () => {
    const missing = parseSeedArgs(['--seed']);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/^Invalid seed value/);
    expect(parseSeedArgs(['--sed', '1']).ok).toBe(false);
  });
});

describe('runSeed', () => {
  it('default seed writes a valid store that FileRepository can open', async () => {
    const r = await seed([]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain(`seed ${DEFAULT_SEED}`);

    const store = await readStoreFile(storePath);
    expect(store.seed).toBe(DEFAULT_SEED);
    expect(store.runDate).toBe(RUN_DATE);
    expect(store.twins[DEMO_BATTERY_ID]).toBeDefined();
    await expect(FileRepository.open(storePath)).resolves.toBeInstanceOf(FileRepository);
    await expect(fsp.access(`${storePath}.tmp`)).rejects.toThrow();
  });

  it('--seed 42 is deterministic: two runs give byte-identical files', async () => {
    expect((await seed(['--seed', '42'])).code).toBe(0);
    const first = await fsp.readFile(storePath);
    expect((await seed(['--seed', '42'])).code).toBe(0);
    const second = await fsp.readFile(storePath);
    expect(second.equals(first)).toBe(true);
    expect((await readStoreFile(storePath)).seed).toBe(42);
  });

  it('re-seeding replaces the previous store entirely', async () => {
    expect((await seed(['--seed', '1'])).code).toBe(0);
    expect((await seed([])).code).toBe(0);
    const defaultRun = await fsp.readFile(storePath, 'utf8');
    expect((await readStoreFile(storePath)).seed).toBe(DEFAULT_SEED);
    expect(defaultRun).not.toContain('"seed": 1,');
  });

  it.each([['abc'], ['1.5'], ['12x'], [''], ['1e3']])(
    'rejects non-integer seed %j and leaves an existing store untouched',
    async (bad) => {
      await fsp.mkdir(path.dirname(storePath), { recursive: true });
      await fsp.writeFile(storePath, SENTINEL);
      const r = await seed(['--seed', bad]);
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/^Invalid seed value: /);
      expect(r.stdout).toBe('');
      expect(await fsp.readFile(storePath, 'utf8')).toBe(SENTINEL);
    },
  );

  it('a write failure leaves the existing store untouched and removes the temp file', async () => {
    await fsp.mkdir(path.dirname(storePath), { recursive: true });
    await fsp.writeFile(storePath, SENTINEL);
    const failingRename: FsOps = {
      ...nodeFsOps,
      rename: async () => {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EIO' });
      },
    };
    const r = await seed([], { fsOps: failingRename });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Seeding failed: .*simulated rename failure/);
    expect(await fsp.readFile(storePath, 'utf8')).toBe(SENTINEL);
    await expect(fsp.access(`${storePath}.tmp`)).rejects.toThrow();
  });

  it('an invalid BR_TODAY fails before any write', async () => {
    const r = await seed([], { env: { BR_TODAY: '2025-13-40' } });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^Seeding failed: BR_TODAY/);
    await expect(fsp.access(storePath)).rejects.toThrow();
  });
});
