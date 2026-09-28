import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { appDir } from './config.js';
import { openStore } from './db.js';
import { Library } from './library.js';
import { setFfmpegPath, toolStatus } from './media.js';
import { Sidecars } from './sidecar.js';
import { normalizeTag, Tagger } from './tagger.js';
import { Thumbs } from './thumbs.js';

const int = (v, min, max, fallback) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const httpError = (status, message) => Object.assign(new Error(message), { status });

function basicAuth(password) {
  const expected = crypto.createHash('sha256').update(password).digest();
  return (req, res, next) => {
    const [scheme, value] = (req.get('authorization') || '').split(' ');
    if (scheme === 'Basic' && value) {
      const pass = Buffer.from(value, 'base64').toString('utf8').replace(/^[^:]*:/, '');
      if (crypto.timingSafeEqual(crypto.createHash('sha256').update(pass).digest(), expected)) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Archive", charset="UTF-8"').status(401).send('Password required');
  };
}

/** Wire everything together. `client` lets tests swap in a stand-in for the Anthropic SDK. */
export async function createApp(config, { client } = {}) {
  await fsp.mkdir(config.dataDir, { recursive: true });
  if (config.ffmpegPath) setFfmpegPath(config.ffmpegPath);
  const store = openStore(path.join(config.dataDir, 'archive.db'));
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const thumbs = new Thumbs(config.dataDir);
  await thumbs.init();
  const sidecars = new Sidecars(config.libraryDir);
  const library = new Library({ config, store, thumbs, sidecars, events });
  await library.init();
  const tagger = new Tagger({ config, store, library, thumbs, events, client });
  library.onPending = (id) => tagger.enqueue(id);

  const status = async () => ({
    title: config.title,
    library: config.libraryDir,
    counts: store.statusCounts(),
    scan: library.progress,
    tagging: tagger.status(),
    tools: await toolStatus(),
  });

  const itemOr404 = (req) => {
    const row = store.getItem(Number(req.params.id));
    if (!row) throw httpError(404, 'Not found');
    return row;
  };

  const app = express();
  app.disable('x-powered-by');
  if (config.password) app.use(basicAuth(config.password));
  app.use(express.static(path.join(appDir, 'public')));
  app.use(express.json({ limit: '5mb' }));

  // ---------- browsing & search ----------

  app.get('/api/items', (req, res) => {
    const q = req.query;
    const { total, rows } = store.search({
      q: String(q.q || ''),
      tags: [].concat(q.tag || []).map(String).filter(Boolean),
      folder: String(q.folder || ''),
      kinds: String(q.kind || '').split(',').filter(Boolean),
      sort: String(q.sort || ''),
      seed: int(q.seed, 0, 2 ** 30, 1),
      offset: int(q.offset, 0, 1e9, 0),
      limit: int(q.limit, 1, 200, 60),
    });
    res.json({ total, items: rows.map((r) => library.present(r)) });
  });

  app.get('/api/items/:id', async (req, res) => {
    const row = itemOr404(req);
    const item = library.present(row, { full: true });
    item.text = await library.readText(row);
    res.json(item);
  });

  app.get('/api/items/:id/related', (req, res) => {
    res.json(store.related(itemOr404(req).id).map((r) => library.present(r)));
  });

  app.get('/api/tags', (req, res) => {
    res.json(
      store.tagCounts({
        q: String(req.query.q || ''),
        tags: [].concat(req.query.tag || []).map(String).filter(Boolean),
        folder: String(req.query.folder || ''),
        kinds: String(req.query.kind || '').split(',').filter(Boolean),
        limit: int(req.query.limit, 1, 500, 60),
      }),
    );
  });

  app.get('/api/folders', (req, res) => res.json(library.folderList()));

  app.get('/api/status', async (req, res) => res.json(await status()));

  // ---------- editing ----------

  app.patch('/api/items/:id', async (req, res) => {
    const { id } = itemOr404(req);
    const { addTags = [], removeTags = [], text, description } = req.body || {};
    const add = [].concat(addTags).map(normalizeTag).filter(Boolean);
    const remove = [].concat(removeTags).map(normalizeTag).filter(Boolean);
    for (const t of add) store.addUserTag(id, t);
    for (const t of remove) store.removeTag(id, t);
    if (typeof description === 'string') store.updateItem(id, { description: description.trim().slice(0, 2000) || null });
    if (add.length || remove.length || typeof description === 'string') {
      await library.saveSidecar(id);
      events.emit('item', library.present(store.getItem(id)));
    }
    if (typeof text === 'string') {
      await library.updateText(id, text);
      tagger.prioritize(id);
    }
    const row = store.getItem(id);
    const item = library.present(row, { full: true });
    item.text = await library.readText(row);
    res.json(item);
  });

  app.post('/api/items/:id/retag', (req, res) => {
    const { id } = itemOr404(req);
    if (!tagger.enabled) throw httpError(409, config.autoTag ? tagger.status().setupHint : 'Auto-tagging is turned off (AUTO_TAG=off)');
    tagger.retag(id);
    res.json({ ok: true });
  });

  app.delete('/api/items/:id', async (req, res) => {
    await library.trashItem(itemOr404(req).id);
    res.json({ ok: true });
  });

  // ---------- adding ----------

  // Raw body upload: POST /api/upload?name=poster.jpg&folder=Posters (one file per request).
  app.post('/api/upload', async (req, res) => {
    const name = String(req.query.name || 'untitled');
    const folder = String(req.query.folder || '');
    if (Number(req.get('content-length') || 0) > config.maxUploadBytes) throw httpError(413, 'File is too large');
    const tmp = path.join(config.dataDir, 'tmp', crypto.randomUUID());
    let size = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        size += chunk.length;
        cb(size > config.maxUploadBytes ? httpError(413, 'File is too large') : null, chunk);
      },
    });
    try {
      await pipeline(req, limit, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err.status ? err : httpError(400, 'Upload was interrupted');
    }
    const result = await library.importFile(tmp, { name, folder });
    if (!result.duplicate) tagger.prioritize(result.item.id);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.post('/api/memo', async (req, res) => {
    const result = await library.createMemo(req.body?.text, req.body?.folder || '');
    tagger.prioritize(result.item.id);
    res.status(201).json(result);
  });

  app.post('/api/link', async (req, res) => {
    const result = await library.createLink(req.body?.url, req.body?.folder || '');
    if (!result.duplicate) tagger.prioritize(result.item.id);
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  app.post('/api/folders', async (req, res) => {
    res.status(201).json({ folder: await library.createFolder(req.body?.name, req.body?.parent || '') });
  });

  // ---------- housekeeping ----------

  app.post('/api/tagging', async (req, res) => {
    const action = req.body?.action;
    if (action === 'start' || action === 'resume') tagger.approve();
    else if (action === 'pause') tagger.pause();
    else if (action === 'retry-failed') tagger.retagFailed();
    else throw httpError(400, 'Unknown action');
    res.json(await status());
  });

  app.post('/api/rescan', (req, res) => {
    library.scan().catch((err) => console.error('rescan failed:', err.message));
    res.json({ ok: true });
  });

  // Live updates (Server-Sent Events): new files from the cloud drive, finished tags, deletions.
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    const handlers = {
      item: (item) => send('item', item),
      remove: (data) => send('remove', data),
      folders: () => send('folders'),
      status: async () => send('status', await status()),
    };
    for (const [type, fn] of Object.entries(handlers)) events.on(type, fn);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      for (const [type, fn] of Object.entries(handlers)) events.off(type, fn);
    });
  });

  // ---------- files ----------

  const cacheFile = (dir, ext) => (req, res) => {
    const m = new RegExp(`^([0-9a-f]{32})\\.${ext}$`).exec(req.params.file);
    if (!m) throw httpError(404, 'Not found');
    res.sendFile(path.join(dir, m[0]), { maxAge: '365d', immutable: true });
  };
  app.get('/thumb/:file', cacheFile(thumbs.thumbDir, 'webp'));
  app.get('/preview/:file', cacheFile(thumbs.previewDir, 'jpg'));

  app.get('/file/:id{/:name}', (req, res) => {
    const row = itemOr404(req);
    const headers = { 'X-Content-Type-Options': 'nosniff' };
    // Opened directly, an SVG or HTML file must not be able to run scripts on this site.
    if (['svg', 'html', 'htm', 'xhtml', 'xml'].includes(row.ext)) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'";
    if (req.query.download) res.attachment(row.name);
    res.sendFile(library.abs(row.path), { dotfiles: 'allow', headers });
  });

  app.use((err, req, res, _next) => {
    const expected = Boolean(err.status || err.statusCode);
    if (!expected) console.error(err);
    if (res.headersSent) return res.end();
    res.status(err.status || err.statusCode || 500).json({ error: expected ? err.message : 'Something went wrong' });
  });

  const close = async () => {
    await tagger.stop();
    await library.stop();
    store.close();
  };

  return { app, store, library, tagger, events, thumbs, status, close };
}
