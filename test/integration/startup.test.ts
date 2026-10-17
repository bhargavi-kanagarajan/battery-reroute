import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DigitalTwin, Store } from '../../src/core/types';
import { fixedClock } from '../../src/server/clock';
import { StoreLoadError, serializeStore } from '../../src/server/repo';
import { HOST, parsePort, startServer, type StartedServer } from '../../src/server/startup';

function twin(id: string, ownerId: string): DigitalTwin {
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
    custodyLog: [{ date: '2021-04-01', fromHolderId: null, toHolderId: ownerId, toHolderRole: 'Owner' }],
    endOfLife: null,
    dataOwner: { id: ownerId, role: 'Owner' },
    consentEvents: [],
    routedPathway: null,
    inspectionFlags: [],
    nudges: [],
    returnRecords: [],
    recyclerIntake: null,
  };
}

const store: Store = {
  version: 2,
  seed: 20250101,
  runDate: '2025-06-01',
  stakeholders: [
    { id: 'OWN-001', role: 'Owner', name: 'Asha Rao', location: { city: 'Austin', state: 'TX' } },
    { id: 'OWN-002', role: 'Owner', name: 'Ben Ito', location: { city: 'Reno', state: 'NV' } },
    { id: 'SP-001', role: 'Service_Partner', name: 'Spark Service', location: { city: 'Austin', state: 'TX' } },
  ],
  twins: { 'BR-1': twin('BR-1', 'OWN-001'), 'BR-2': twin('BR-2', 'OWN-002') },
};

let dir: string;
let storePath: string;
let started: StartedServer | undefined;

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'br-startup-'));
  storePath = path.join(dir, 'store.json');
});

afterEach(async () => {
  await started?.close();
  started = undefined;
  await fsp.rm(dir, { recursive: true, force: true });
});

const ownerHeaders = { 'X-Role': 'Owner', 'X-Identity': 'OWN-001' };

describe('startServer', () => {
  it('serves the API on loopback from a valid store, and a build message when dist/web is absent', async () => {
    await fsp.writeFile(storePath, serializeStore(store));
    started = await startServer({
      storePath,
      port: 0,
      webDir: path.join(dir, 'no-web-build'),
      clock: fixedClock('2025-06-01'),
    });
    expect(started.url.startsWith(`http://${HOST}:`)).toBe(true);
    expect(started.webAvailable).toBe(false);

    const sh = await fetch(`${started.url}/api/stakeholders`);
    expect(sh.status).toBe(200);
    const shBody = (await sh.json()) as { roles: string[]; stakeholders: Record<string, { id: string }[]> };
    expect(shBody.roles).toHaveLength(6);
    expect(shBody.stakeholders.Owner?.map((s) => s.id)).toEqual(['OWN-001', 'OWN-002']);

    const list = await fetch(`${started.url}/api/batteries`, { headers: ownerHeaders });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { batteries: { batteryId: string }[]; returnedBatteries: unknown[] };
    expect(listBody.batteries.map((b) => b.batteryId)).toEqual(['BR-1']);
    expect(listBody.returnedBatteries).toEqual([]);

    const noRole = await fetch(`${started.url}/api/batteries`);
    expect(noRole.status).toBe(400);

    const host = await fetch(`${started.url}/`);
    expect(host.status).toBe(503);
    expect(await host.text()).toContain('npm run build:web');

    // Internal test routes are not mounted by the real server.
    const internal = await fetch(`${started.url}/api/internal/twins/BR-1`, { headers: ownerHeaders });
    expect(internal.status).not.toBe(200);
  });

  it('serves the host page from the web build when present', async () => {
    await fsp.writeFile(storePath, serializeStore(store));
    const webDir = path.join(dir, 'web');
    await fsp.mkdir(webDir);
    await fsp.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>Host</title><div id="root"></div>');
    started = await startServer({ storePath, port: 0, webDir, clock: fixedClock('2025-06-01') });
    expect(started.webAvailable).toBe(true);
    const host = await fetch(`${started.url}/`);
    expect(host.status).toBe(200);
    expect(await host.text()).toContain('id="root"');
  });

  it('rejects with StoreLoadError telling the user to seed when the store is missing', async () => {
    const err = await startServer({ storePath, port: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreLoadError);
    expect((err as StoreLoadError).kind).toBe('missing');
    expect((err as Error).message).toContain('npm run seed');
  });

  it('rejects an old store version', async () => {
    await fsp.writeFile(storePath, JSON.stringify({ ...store, version: 1 }));
    const err = await startServer({ storePath, port: 0 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreLoadError);
    expect((err as StoreLoadError).kind).toBe('wrong_version');
  });
});

describe('parsePort', () => {
  it('defaults, parses, and rejects invalid values', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('8080')).toBe(8080);
    expect(() => parsePort('abc')).toThrow();
    expect(() => parsePort('70000')).toThrow();
  });
});
