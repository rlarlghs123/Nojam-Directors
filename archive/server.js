import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const { app, library, tagger, close } = await createApp(config);

const server = app.listen(config.port, config.host, () => {
  const host = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`\n  ${config.title} is running at http://${host}:${config.port}`);
  console.log(`  Library: ${config.libraryDir}`);
  console.log(`  Auto-tags: ${tagger.enabled ? `on (${config.model})` : 'off — add ANTHROPIC_API_KEY to archive/.env to turn them on'}\n`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.password) {
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
