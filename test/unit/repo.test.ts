import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DigitalTwin, Store } from '../../src/core/types';
import {
  FileRepository,
  MemoryRepository,
  StoreLoadError,
  nodeFsOps,
  readStoreFile,
  serializeStore,
  writeStoreAtomic,
  type FsOps,
  type Repository,
} from '../../src/server/repo';

function twin(id: string): DigitalTwin {
  return {
    passport: {
      batteryId: id,
      chemistry: 'NMC',
      capacityKwh: 75,
      packMassKg: 450,
      manufactureDate: '2021-03-15',
      manufacturer: 'Volt Motors',
      embeddedCarbonKgCo2e: 6000,
      recycledContentPct: 12,
    },
    modules: [{ moduleId: 'M1', condition: 'Good' }],
    telemetry: [{ timestamp: '2025-05-01T00:00:00.000Z', sohPct: 88, cycleCount: 500, thermalEventCount: 0 }],
    chargingHistory: [],
    serviceHistory: [],
    custodyLog: [{ date: '2021-04-01', fromHolderId: null, toHolderId: 'OWN-001', toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: 'OWN-001', role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

function store(...ids: string[]): Store {
  return {
    version: 2,
    seed: 20250101,
    runDate: '2025-06-01',
    stakeholders: [
      { id: 'OWN-001', role: 'Owner', name: 'Asha Rao', location: { city: 'Austin', state: 'TX' } },
    ],
    twins: Object.fromEntries(ids.map((id) => [id, twin(id)])),
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br-repo-'));
  file = path.join(dir, 'store.json');
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

const readJson = async (p: string) => JSON.parse(await fsp.readFile(p, 'utf8')) as Store;

/** Shared contract for both repositories. */
function contract(name: string, make: (s: Store) => Promise<Repository>) {
  describe(`${name} contract`, () => {
    it('creates and retrieves a twin; rejects a duplicate battery ID unchanged', async () => {
      const repo = await make(store());
      const created = await repo.createTwin(twin('BR-1'));
      expect(created.ok).toBe(true);
      expect(await repo.getTwin('BR-1')).toEqual(twin('BR-1'));

      const dup = twin('BR-1');
      dup.passport.chemistry = 'LFP';
      const again = await repo.createTwin(dup);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.error.code).toBe('DUPLICATE_BATTERY_ID');
      expect((await repo.getTwin('BR-1'))?.passport.chemistry).toBe('NMC');
    });

    it('returns undefined for unknown IDs and NOT_FOUND on replace/update', async () => {
      const repo = await make(store());
      expect(await repo.getTwin('nope')).toBeUndefined();
      const r = await repo.replaceTwin(twin('nope'));
      expect(!r.ok && r.error.code).toBe('NOT_FOUND');
    });

    it('returns deep copies so callers cannot mutate the store', async () => {
      const repo = await make(store('BR-1'));
      const t = (await repo.getTwin('BR-1'))!;
      t.passport.chemistry = 'MUTATED';
      (await repo.listTwins())[0]!.modules.push({ moduleId: 'X', condition: 'Failed' });
      expect(await repo.getTwin('BR-1')).toEqual(twin('BR-1'));
    });

    it('updateTwin applies the mutator, and writes nothing when it returns an error', async () => {
      const repo = await make(store('BR-1'));
      const fail = await repo.updateTwin('BR-1', () => ({
        ok: false,
        error: { code: 'VALIDATION_ERROR', message: 'bad' },
      }));
      expect(fail.ok).toBe(false);
      expect(await repo.getTwin('BR-1')).toEqual(twin('BR-1'));

      const ok = await repo.updateTwin('BR-1', (t) => ({
        ok: true,
        value: { ...t, routedPathway: 'Certified_Recycling' },
      }));
      expect(ok.ok).toBe(true);
      expect((await repo.getTwin('BR-1'))?.routedPathway).toBe('Certified_Recycling');

      const rename = await repo.updateTwin('BR-1', (t) => ({
        ok: true,
        value: { ...t, passport: { ...t.passport, batteryId: 'BR-2' } },
      }));
      expect(!rename.ok && rename.error.code).toBe('VALIDATION_ERROR');
    });

    it('serializes concurrent updates without losing writes', async () => {
      const repo = await make(store('BR-1'));
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          repo.updateTwin('BR-1', (t) => ({
            ok: true,
            value: { ...t, modules: [...t.modules, { moduleId: `N${i}`, condition: 'Good' }] },
          })),
        ),
      );
      expect((await repo.getTwin('BR-1'))?.modules).toHaveLength(11);
    });

    it('replaceStore replaces every prior twin', async () => {
      const repo = await make(store('BR-1', 'BR-2'));
      await repo.replaceStore(store('BR-9'));
      expect((await repo.listTwins()).map((t) => t.passport.batteryId)).toEqual(['BR-9']);
    });
  });
}

contract('MemoryRepository', async (s) => new MemoryRepository(s));
contract('FileRepository', async (s) => FileRepository.create(file, s));

describe('FileRepository persistence', () => {
  it('round-trips through disk: every mutation is visible after reopening', async () => {
    const repo = await FileRepository.create(file, store('BR-1'));
    await repo.createTwin(twin('BR-2'));
    await repo.updateTwin('BR-1', (t) => ({ ok: true, value: { ...t, routedPathway: 'Second_Life_Review' } }));

    const reopened = await FileRepository.open(file);
    expect(await reopened.getStore()).toEqual(await repo.getStore());
    expect((await reopened.getTwin('BR-1'))?.routedPathway).toBe('Second_Life_Review');
    expect(await fsp.readFile(file, 'utf8')).toBe(serializeStore(await repo.getStore()));
    // No temp file is left behind.
    expect(await fsp.readdir(dir)).toEqual(['store.json']);
  });

  it('reports a missing store with a hint to run the seed', async () => {
    const err = await FileRepository.open(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreLoadError);
    expect((err as StoreLoadError).kind).toBe('missing');
    expect((err as Error).message).toContain('npm run seed');
  });

  it('rejects invalid JSON, an old version, and schema violations', async () => {
    await fsp.writeFile(file, '{ not json');
    await expect(readStoreFile(file)).rejects.toMatchObject({ kind: 'invalid_json' });

    await fsp.writeFile(file, JSON.stringify({ ...store('BR-1'), version: 1 }));
    await expect(readStoreFile(file)).rejects.toMatchObject({ kind: 'wrong_version' });

    const bad = store('BR-1') as any;
    bad.twins['BR-1'].telemetry[0].sohPct = 150;
    await fsp.writeFile(file, JSON.stringify(bad));
    const err = (await readStoreFile(file).catch((e: unknown) => e)) as StoreLoadError;
    expect(err.kind).toBe('invalid');
    expect(err.fields.map((f) => f.field)).toContain('twins.BR-1.telemetry.0.sohPct');

    const mismatched = store('BR-1') as any;
    mismatched.twins['BR-X'] = mismatched.twins['BR-1'];
    await fsp.writeFile(file, JSON.stringify(mismatched));
    await expect(readStoreFile(file)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('keeps the old file and cache when the rename fails', async () => {
    let failRename = false;
    const fsOps: FsOps = {
      ...nodeFsOps,
      rename: (a, b) => (failRename ? Promise.reject(new Error('disk gone')) : nodeFsOps.rename(a, b)),
    };
    const repo = await FileRepository.create(file, store('BR-1'), { fsOps });
    const before = await fsp.readFile(file, 'utf8');

    failRename = true;
    await expect(repo.createTwin(twin('BR-2'))).rejects.toThrow('disk gone');
    expect(await fsp.readFile(file, 'utf8')).toBe(before);
    expect(await repo.getTwin('BR-2')).toBeUndefined();
    expect(await fsp.readdir(dir)).toEqual(['store.json']);

    // The queue still works after a failure.
    failRename = false;
    expect((await repo.createTwin(twin('BR-2'))).ok).toBe(true);
    expect(Object.keys((await readJson(file)).twins).sort()).toEqual(['BR-1', 'BR-2']);
  });

  it('retries transient EPERM/EBUSY renames (Windows file locks)', async () => {
    let failures = 2;
    const fsOps: FsOps = {
      ...nodeFsOps,
      rename: (a, b) => {
        if (failures-- > 0) {
          return Promise.reject(Object.assign(new Error('locked'), { code: failures % 2 ? 'EPERM' : 'EBUSY' }));
        }
        return nodeFsOps.rename(a, b);
      },
    };
    await writeStoreAtomic(file, store('BR-1'), { fsOps, renameBackoffMs: 1 });
    expect(Object.keys((await readJson(file)).twins)).toEqual(['BR-1']);
  });

  it('gives up after the retry limit and leaves the target untouched', async () => {
    await writeStoreAtomic(file, store('BR-1'));
    const fsOps: FsOps = {
      ...nodeFsOps,
      rename: () => Promise.reject(Object.assign(new Error('locked'), { code: 'EBUSY' })),
    };
    await expect(
      writeStoreAtomic(file, store('BR-2'), { fsOps, renameAttempts: 3, renameBackoffMs: 1 }),
    ).rejects.toThrow('locked');
    expect(Object.keys((await readJson(file)).twins)).toEqual(['BR-1']);
    expect(await fsp.readdir(dir)).toEqual(['store.json']);
  });

  it('overwrites an existing store and creates missing parent directories', async () => {
    const nested = path.join(dir, 'a', 'b', 'store.json');
    await writeStoreAtomic(nested, store('BR-1'));
    await writeStoreAtomic(nested, store('BR-2'));
    expect(Object.keys((await readStoreFile(nested)).twins)).toEqual(['BR-2']);
  });
});
