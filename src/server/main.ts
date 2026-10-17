/**
 * `npm start` entry point. Thin wrapper around startServer (see startup.ts).
 *   PORT      optional listen port (default 3000); the host is always 127.0.0.1
 *   BR_TODAY  optional YYYY-MM-DD override for the current/evaluation date
 */
import { StoreLoadError } from './repo';
import { parsePort, startServer } from './startup';

async function main(): Promise<void> {
  try {
    const started = await startServer({ port: parsePort(process.env.PORT) });
    console.log(`Battery ReRoute running at ${started.url}`);
    if (!started.webAvailable) {
      console.warn('Web app build not found in dist/web; run "npm run build:web". The API is still available.');
    }
    console.log('No authentication: the Role_Switcher stands in for login. Listening on loopback only.');
    const shutdown = () => {
      started.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (err) {
    if (err instanceof StoreLoadError) {
      console.error(err.message);
    } else {
      console.error(`Server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

void main();
