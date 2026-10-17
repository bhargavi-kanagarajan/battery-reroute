/**
 * Server startup (Req 13.5, 14.1, 14.8).
 *
 * - Opens and validates the JSON store through FileRepository. A missing or invalid store
 *   (including an old `version`) raises StoreLoadError, whose message tells the user to run
 *   `npm run seed`; the caller prints it and exits non-zero.
 * - Mounts the API (createApp, without the internal test routes) and serves the built Plugin
 *   host page from `dist/web`. If the web build is absent, the API still works and non-API
 *   GET requests receive a 503 page explaining how to build it.
 * - Binds to 127.0.0.1 only. There is no authentication (prototype; Role_Switcher stands in).
 * - Makes no outbound network calls.
 */
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { createApp } from './app';
import { clockFromEnv, type Clock } from './clock';
import { DEFAULT_STORE_PATH, FileRepository } from './repo';

/** Loopback only: the prototype has no authentication. */
export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;

/** `dist/web`, resolved from this file so it does not depend on the working directory. */
export const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../dist/web', import.meta.url));

export interface StartServerOptions {
  /** Store file; defaults to `data/store.json` relative to the working directory. */
  storePath?: string;
  /** TCP port; 0 picks an ephemeral port (tests). Defaults to DEFAULT_PORT. */
  port?: number;
  /** Directory with the Vite build output. Defaults to `dist/web`. */
  webDir?: string;
  clock?: Clock;
  logError?: (err: unknown) => void;
}

export interface StartedServer {
  server: Server;
  app: Express;
  /** Base URL, e.g. `http://127.0.0.1:3000`. */
  url: string;
  webAvailable: boolean;
  close(): Promise<void>;
}

const WEB_MISSING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Battery ReRoute</title></head>
<body><main><h1>Battery ReRoute</h1>
<p>The web app has not been built. Run <code>npm run build:web</code> (or <code>npm start</code>, which builds it) and reload this page.</p>
<p>The API is available under <code>/api</code>.</p></main></body></html>`;

/** Registers static assets and the host page; returns whether a build was found. */
export function mountWeb(app: Express, webDir: string): boolean {
  const indexHtml = path.join(webDir, 'index.html');
  const available = existsSync(indexHtml);
  if (available) {
    app.use(express.static(webDir, { index: 'index.html' }));
  }
  app.get('*', (_req, res) => {
    if (available) {
      res.sendFile(indexHtml);
    } else {
      res.status(503).type('html').send(WEB_MISSING_HTML);
    }
  });
  return available;
}

/** Parses a PORT value; throws on anything that is not an integer in 0..65535. */
export function parsePort(value: string | undefined, fallback = DEFAULT_PORT): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Loads the store and starts listening. Rejects with StoreLoadError when the store is missing
 * or invalid, before any port is opened.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<StartedServer> {
  const repo = await FileRepository.open(opts.storePath ?? DEFAULT_STORE_PATH);
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  let webAvailable = false;
  const app = createApp({
    repo,
    clock: opts.clock ?? clockFromEnv(),
    internal: false,
    logError: opts.logError,
    configure: (a) => {
      webAvailable = mountWeb(a, webDir);
    },
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port ?? DEFAULT_PORT, HOST);
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : (opts.port ?? DEFAULT_PORT);
  return {
    server,
    app,
    url: `http://${HOST}:${port}`,
    webAvailable,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
