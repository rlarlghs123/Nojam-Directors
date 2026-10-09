import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const { app, library, tagger, close } = await createApp(config);

const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  ${config.title} is running at http://${host}:${config.port}`);
  console.log(`  Library: ${config.libraryDir}`);
  const t = tagger.status();
  const how = `${t.label}, ${t.model}${t.free ? ', free' : ''}`;
  console.log(`  Auto-tags: ${t.enabled ? `on (${how})` : t.autoTag ? `off. ${t.setupHint}` : 'off (AUTO_TAG=off)'}\n`);
  // In Docker, ARCHIVE_BIND=127.0.0.1 (from .env) publishes the page on the server itself only, e.g. behind Tailscale.
  const onNetwork = config.host !== '127.0.0.1' && config.host !== 'localhost' && process.env.ARCHIVE_BIND !== '127.0.0.1';
  if (onNetwork && !config.password) {
    console.warn('  Warning: listening on the network without ARCHIVE_PASSWORD. Anyone on this network can open the archive.\n');
  }
});

library
  .start()
  .then(() => tagger.start())
  .catch((err) => console.error('Library scan failed:', err));

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
