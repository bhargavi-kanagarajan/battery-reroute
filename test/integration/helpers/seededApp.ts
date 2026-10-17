/**
 * Shared setup for the end-to-end integration tests (tasks 16.2, 16.3): seeds a temporary store
 * with the real Seed_Script, opens it through FileRepository, and builds the app on a fixed clock.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import { runSeed } from '../../../scripts/seedCli';
import { createApp } from '../../../src/server/app';
import { fixedClock } from '../../../src/server/clock';
import { FileRepository } from '../../../src/server/repo';
import type { Role } from '../../../src/core/types';

export const RUN_DATE = '2026-10-17';

export interface SeededApp {
  app: ReturnType<typeof createApp>;
  repo: FileRepository;
  storePath: string;
  cleanup: () => Promise<void>;
}

export async function seededApp(): Promise<SeededApp> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'br-e2e-'));
  const storePath = path.join(dir, 'store.json');
  const quiet = { write: () => undefined };
  const code = await runSeed({ argv: [], env: { BR_TODAY: RUN_DATE }, storePath, stdout: quiet, stderr: quiet });
  if (code !== 0) throw new Error(`Seeding failed with exit code ${code}`);
  const repo = await FileRepository.open(storePath);
  const app = createApp({ repo, clock: fixedClock(RUN_DATE), internal: false });
  return { app, repo, storePath, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** Headers for a role context. */
export function as(role: Role, identityId: string): Record<string, string> {
  return { 'X-Role': role, 'X-Identity': identityId };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1', undefined, '']);

/**
 * Fails the test on any outbound TCP connection to a non-loopback address (Req 14.1).
 * Returns the list of offending hosts; call `restore()` when done.
 */
export function installOfflineGuard(): { offending: string[]; restore: () => void } {
  const offending: string[] = [];
  const original = net.Socket.prototype.connect;
  const spy = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; path?: string } | number | string | undefined;
    let host: string | undefined;
    if (typeof first === 'object' && first !== null) host = first.path ? undefined : first.host;
    else if (typeof first === 'number' && typeof args[1] === 'string') host = args[1];
    if (!LOOPBACK.has(host)) offending.push(String(host));
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  });
  return { offending, restore: () => spy.mockRestore() };
}
