import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { watch } from 'chokidar';
import { analyze } from './analyze.js';
import { EDITABLE, kindOf } from './kinds.js';
import { fetchImage, fetchLinkMeta, linkFileContent, normalizeUrl } from './links.js';
import { icloudDownload } from './media.js';
import {
  extOf, isIgnoredName, isIgnoredPath, keyedLock, limiter, moveFile, nfc, safeFolder, safeName, toPosix, uniquePath,
} from './util.js';

const MB = 1024 * 1024;
const ICLOUD_STUB = /^\.(.+)\.icloud$/;
const IMAGE_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/svg+xml': 'svg', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff', 'image/bmp': 'bmp',
};
// macOS "packages" look like folders on disk but are single documents. Don't walk into them.
const PACKAGE_DIR = /\.(app|bundle|framework|photoslibrary|musiclibrary|fcpbundle|logicx|rtfd|pages|key|numbers|sketch|lrlibrary|lrdata|imovielibrary|band|xcodeproj|xcworkspace)$/i;

/** Content fingerprint. Big files hash size + three 1 MB samples so videos don't need a full read. */
export async function fingerprint(file, size) {
  const h = crypto.createHash('sha1');
  h.update(`${size}:`);
  if (size <= 4 * MB) {
    h.update(await fsp.readFile(file));
  } else {
    const fh = await fsp.open(file, 'r');
    try {
      const chunk = Buffer.alloc(MB);
      for (const pos of [0, Math.floor(size / 2), size - MB]) {
        const { bytesRead } = await fh.read(chunk, 0, MB, pos);
        h.update(chunk.subarray(0, bytesRead));
      }
    } finally {
      await fh.close();
    }
  }
  return h.digest('hex').slice(0, 32);
}

export class Library {
  constructor({ config, store, thumbs, sidecars, events }) {
    this.root = config.libraryDir;
    this.dataDir = config.dataDir;
    this.config = config;
    this.store = store;
    this.thumbs = thumbs;
    this.sidecars = sidecars;
    this.events = events;
    this.lock = keyedLock();
    this.scanLimit = limiter(4);
    this.analyzeLimit = limiter(2);
    this.folders = new Set();
    this.pendingUnlinks = new Map();
    this.onPending = () => {}; // set by the tagger
    this.progress = { scanning: false, seen: 0, indexed: 0 };
  }

  abs(rel) {
    return rel ? path.join(this.root, ...rel.split('/')) : this.root;
  }

  rel(abs) {
    return toPosix(path.relative(this.root, abs));
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    // If ARCHIVE_DIR is itself a symlink (e.g. ~/Archive → iCloud Drive), work on the real folder.
    this.root = await fsp.realpath(this.root);
    await fsp.mkdir(path.join(this.dataDir, 'tmp'), { recursive: true });
  }

  async start() {
    await this.init();
    if (this.config.watch) await this.watch();
    await this.scan();
    if (this.config.rescanMinutes > 0) {
      this.rescanTimer = setInterval(() => this.scan().catch((e) => console.error('rescan failed:', e.message)), this.config.rescanMinutes * 60_000);
      this.rescanTimer.unref();
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.rescanTimer);
    clearTimeout(this.statusTimer);
    for (const t of this.pendingUnlinks.values()) clearTimeout(t);
    await this.watcher?.close();
  }

  // ---------- scanning & watching ----------

  /** Walk the whole library: index new/changed files, forget deleted ones. */
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const seen = new Set();
      const folders = new Set();
      const jobs = [];
      this.progress = { scanning: true, seen: 0, indexed: 0 };
      this.#status();
      const walk = async (relDir) => {
        let entries;
        try {
          entries = await fsp.readdir(this.abs(relDir), { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const rel = relDir ? `${relDir}/${e.name}` : e.name;
          if (ICLOUD_STUB.test(e.name)) {
            icloudDownload(this.abs(rel));
            continue;
          }
          if (isIgnoredName(e.name)) continue;
          if (e.isDirectory() && !PACKAGE_DIR.test(e.name)) {
            folders.add(rel);
            await walk(rel);
          } else if (e.isFile()) {
            seen.add(rel);
            this.progress.seen++;
            jobs.push(
              this.scanLimit(() => this.indexPath(rel))
                .catch((err) => console.error(`index failed: ${rel}: ${err.message}`))
                .finally(() => {
                  this.progress.indexed++;
                  this.#status();
                }),
            );
          }
        }
      };
      await walk('');
      await Promise.all(jobs);
      this.folders = folders;
      for (const { id, path: p } of this.store.allPaths()) {
        if (!seen.has(p) && !fs.existsSync(this.abs(p))) this.removeItem(id);
      }
    })().finally(() => {
      this.scanning = null;
      this.progress.scanning = false;
      this.#status(true);
    });
    return this.scanning;
  }

  #status(now = false) {
    clearTimeout(this.statusTimer);
    if (this.stopped) return;
    if (now) this.events.emit('status');
    else this.statusTimer = setTimeout(() => this.events.emit('status'), 500);
  }

  watch() {
    const ignored = (p) => {
      const rel = this.rel(p);
      if (!rel || rel.startsWith('..')) return false;
      if (ICLOUD_STUB.test(path.basename(p))) return false;
      return isIgnoredPath(rel) || rel.split('/').slice(0, -1).some((seg) => PACKAGE_DIR.test(seg));
    };
    this.watcher = watch(this.root, {
      ignoreInitial: true,
      ignored,
      followSymlinks: false, // like the scan: never serve files from outside the library
      // Files arriving from iCloud/Drive sync or big uploads are written gradually; wait until stable.
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 250 },
    });
    const onFile = (p) => {
      const base = path.basename(p);
      if (ICLOUD_STUB.test(base)) return icloudDownload(p);
      const rel = this.rel(p);
      clearTimeout(this.pendingUnlinks.get(rel));
      this.pendingUnlinks.delete(rel);
      this.indexPath(rel).catch((err) => console.error(`index failed: ${rel}: ${err.message}`));
    };
    this.watcher
      .on('add', onFile)
      .on('change', onFile)
      .on('unlink', (p) => {
        // Wait a moment: a rename shows up as unlink + add, and we want to keep the item (and its tags).
        const rel = this.rel(p);
        clearTimeout(this.pendingUnlinks.get(rel));
        this.pendingUnlinks.set(
          rel,
          setTimeout(() => {
            this.pendingUnlinks.delete(rel);
            this.lock(rel, () => {
              if (!fs.existsSync(p)) this.forgetPath(rel);
            });
          }, 3000),
        );
      })
      .on('addDir', (p) => {
        const rel = this.rel(p);
        if (rel && !PACKAGE_DIR.test(p)) this.folders.add(rel);
        this.events.emit('folders');
      })
      .on('unlinkDir', (p) => {
        this.folders.delete(this.rel(p));
        this.events.emit('folders');
      })
      .on('error', (err) => console.error('watch error:', err.message));
    // Resolves once the watcher has seen the whole folder; anything added after that fires an event.
    return new Promise((resolve) => this.watcher.once('ready', resolve));
  }

  // ---------- indexing ----------

  indexPath(rel, opts = {}) {
    return this.lock(rel, () => this.#index(rel, opts));
  }

  async #index(rel, { force = false, addedAt, linkMeta } = {}) {
    const abs = this.abs(rel);
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch {
      this.forgetPath(rel);
      return null;
    }
    if (!st.isFile()) return null; // folders, and symlinks (which could point outside the library)

    const mtime = Math.round(st.mtimeMs);
    let existing = this.store.getByPath(rel);
    if (existing && !force && existing.size === st.size && existing.mtime === mtime) return existing;

    const hash = await fingerprint(abs, st.size);
    const name = nfc(path.posix.basename(rel));
    const dir = path.posix.dirname(rel);
    const folder = dir === '.' ? '' : nfc(dir);
    const ext = extOf(name);
    const now = Date.now();

    if (!existing) {
      // Same content at a path that no longer exists → the file was moved or renamed. Keep the item.
      const twin = this.store.getByHash(hash).find((it) => !fs.existsSync(this.abs(it.path)));
      if (twin) {
        this.store.updateItem(twin.id, { path: rel, name, folder, ext, size: st.size, mtime, updated_at: now });
        if (twin.ext === ext && !force) {
          this.#emitItem(twin.id);
          return this.store.getItem(twin.id);
        }
        existing = this.store.getItem(twin.id);
        force = true; // new extension, maybe a new kind: look at it again (tags stay)
      }
    }
    if (existing && existing.hash === hash && !force) {
      this.store.updateItem(existing.id, { size: st.size, mtime });
      return this.store.getItem(existing.id);
    }

    const kind = kindOf(ext);
    let info;
    try {
      info = await this.analyzeLimit(() => analyze({ abs, name, ext, kind, size: st.size, hash, linkMeta }, this.thumbs));
    } catch (err) {
      console.error(`analyze failed: ${rel}: ${err.message}`);
      info = { kind };
    }

    const fields = {
      path: rel,
      folder,
      name,
      ext,
      kind: info.kind,
      size: st.size,
      mtime,
      hash,
      width: info.width ?? null,
      height: info.height ?? null,
      duration: info.duration ?? null,
      pages: info.pages ?? null,
      title: info.title ?? null,
      excerpt: info.excerpt ?? null,
      body: info.body ?? null,
      url: info.url ?? null,
      meta: info.meta ? JSON.stringify(info.meta) : null,
      thumb: info.thumb ? 1 : 0,
      preview: info.preview ? 1 : 0,
      color: info.color ?? null,
      updated_at: now,
    };

    let id;
    if (existing) {
      id = existing.id;
      this.store.updateItem(id, fields);
      if (existing.hash && existing.hash !== hash && this.store.countHash(existing.hash) === 0) await this.thumbs.remove(existing.hash);
    } else {
      // Earliest date we know: a file synced down from the cloud gets a new birthtime but keeps its mtime.
      const times = [st.birthtimeMs, st.mtimeMs].filter((t) => t > 0);
      fields.added_at = addedAt || (times.length ? Math.round(Math.min(...times)) : now);
      fields.tag_status = 'pending';
      id = this.store.insertItem(fields);
    }

    // Tags: restore them from the sidecar if this content was tagged before, otherwise ask Claude.
    const side = this.sidecars.read(hash);
    if (side) this.#applySidecar(id, side);
    if (!side?.ai) {
      this.store.updateItem(id, { tag_status: 'pending', tag_error: null });
      this.onPending(id);
    }
    this.#emitItem(id, !existing);
    return this.store.getItem(id);
  }

  #applySidecar(id, side) {
    const ai = side.ai || {};
    if (side.ai) {
      this.store.updateItem(id, {
        ai_title: ai.title || null,
        ai_summary: ai.summary || null,
        ai_keywords: (ai.keywords || []).join(', ') || null,
        tag_model: ai.model || null,
        tagged_at: ai.at || null,
        tag_status: 'done',
        tag_error: null,
      });
    }
    this.store.setAllTags(id, { ai: ai.tags || [], user: side.user?.add || [], hidden: side.user?.hide || [] });
    if (typeof side.user?.description === 'string') this.store.updateItem(id, { description: side.user.description || null });
  }

  /** Persist an item's tags and description next to the file (see sidecar.js). */
  async saveSidecar(id) {
    const it = this.store.getItem(id);
    if (!it?.hash) return;
    const bySource = { ai: [], user: [], hidden: [] };
    for (const t of this.store.tagsFor(id)) bySource[t.source]?.push(t.tag);
    const data = { user: { add: bySource.user, hide: bySource.hidden, ...(it.description ? { description: it.description } : {}) } };
    if (it.tag_status === 'done') {
      data.ai = {
        title: it.ai_title,
        summary: it.ai_summary,
        keywords: it.ai_keywords ? it.ai_keywords.split(', ') : [],
        tags: [...bySource.ai, ...bySource.hidden],
        model: it.tag_model,
        at: it.tagged_at,
      };
    }
    try {
      await this.sidecars.write(it.hash, data);
    } catch (err) {
      console.error(`could not save tags for ${it.path}: ${err.message}`);
    }
  }

  forgetPath(rel) {
    const it = this.store.getByPath(rel);
    if (it) this.removeItem(it.id);
  }

  removeItem(id) {
    const it = this.store.getItem(id);
    if (!it) return;
    this.store.deleteItem(id);
    if (it.hash && this.store.countHash(it.hash) === 0) this.thumbs.remove(it.hash).catch(() => {});
    this.events.emit('remove', { id });
  }

  /** `created` tells the browser this is a new block (show it) rather than an update (refresh it). */
  #emitItem(id, created = false) {
    const row = this.store.getItem(id);
    if (row) this.events.emit('item', { ...this.present(row), created });
  }

  // ---------- adding things ----------

  /**
   * Put a new file into `folder` under a name that doesn't clash with existing files.
   * `write(target)` creates it; runs one at a time per folder so parallel uploads never overwrite each other.
   */
  async #place(folder, name, write, indexOpts = {}) {
    const dir = this.abs(safeFolder(folder));
    const target = await this.lock(`dir:${dir}`, async () => {
      await fsp.mkdir(dir, { recursive: true });
      const t = await uniquePath(dir, name);
      await write(t);
      return t;
    });
    return this.indexPath(this.rel(target), { addedAt: Date.now(), ...indexOpts });
  }

  /** Move an uploaded temp file into the library. Returns { item, duplicate }. */
  async importFile(tmp, { name, folder }) {
    try {
      const safe = safeFolder(folder);
      const { size } = await fsp.stat(tmp);
      const hash = await fingerprint(tmp, size);
      const dupe = this.store.getByHash(hash).find((it) => fs.existsSync(this.abs(it.path)));
      if (dupe) return { item: this.present(dupe), duplicate: true };
      const row = await this.#place(safe, safeName(name), (target) => moveFile(tmp, target));
      return { item: this.present(row), duplicate: false };
    } finally {
      await fsp.rm(tmp, { force: true }); // gone already if it was moved
    }
  }

  async createMemo(text, folder = '') {
    const body = String(text ?? '').replace(/\r\n?/g, '\n');
    if (!body.trim()) throw Object.assign(new Error('Memo is empty'), { status: 400 });
    const first = body.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.');
    const name = `${safeName(first, `Memo ${stamp}`)}.md`;
    const row = await this.#place(folder, name, (target) => fsp.writeFile(target, body.endsWith('\n') ? body : body + '\n', { flag: 'wx' }));
    return { item: this.present(row), duplicate: false };
  }

  async updateText(id, text) {
    const it = this.store.getItem(id);
    if (!it) throw Object.assign(new Error('Not found'), { status: 404 });
    if (!EDITABLE.has(it.ext)) throw Object.assign(new Error('Only text and markdown files can be edited'), { status: 400 });
    await fsp.writeFile(this.abs(it.path), String(text ?? '').replace(/\r\n?/g, '\n'));
    return this.present(await this.indexPath(it.path, { force: true }));
  }

  async createLink(input, folder = '') {
    let url;
    try {
      url = normalizeUrl(input);
    } catch (err) {
      throw Object.assign(new Error(`Not a valid link: ${err.message}`), { status: 400 });
    }
    const existing = this.store.getByUrl(url).find((it) => fs.existsSync(this.abs(it.path)));
    if (existing) return { item: this.present(existing), duplicate: true };
    const meta = await fetchLinkMeta(url);
    if (meta.isImage) {
      // A link straight to an image: keep the image itself, like are.na does.
      const { data, contentType } = await fetchImage(meta.finalUrl || url);
      let name = safeName(decodeURIComponent(new URL(meta.finalUrl || url).pathname.split('/').pop() || ''), 'image');
      if (!extOf(name)) name += `.${IMAGE_EXT[contentType.split(';')[0].trim()] || 'jpg'}`;
      const tmp = path.join(this.dataDir, 'tmp', crypto.randomUUID());
      await fsp.writeFile(tmp, data);
      return this.importFile(tmp, { name, folder });
    }
    const u = new URL(url);
    const label = meta.title || `${u.hostname.replace(/^www\./, '')}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`;
    const name = `${safeName(label.slice(0, 90), 'link')}.url`;
    const row = await this.#place(folder, name, (target) => fsp.writeFile(target, linkFileContent(url), { flag: 'wx' }), { linkMeta: meta });
    return { item: this.present(row), duplicate: false };
  }

  async createFolder(name, parent = '') {
    const rel = safeFolder(parent ? `${parent}/${name}` : name);
    if (!rel) throw Object.assign(new Error('Folder name required'), { status: 400 });
    await fsp.mkdir(this.abs(rel), { recursive: true });
    this.folders.add(rel);
    this.events.emit('folders');
    return rel;
  }

  /** Deleting moves the file to <library>/.trash, never destroys it. */
  async trashItem(id) {
    const it = this.store.getItem(id);
    if (!it) throw Object.assign(new Error('Not found'), { status: 404 });
    const trash = path.join(this.root, '.trash');
    await fsp.mkdir(trash, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    await this.lock(it.path, async () => {
      try {
        await moveFile(this.abs(it.path), await uniquePath(trash, `${stamp} ${path.posix.basename(it.path)}`));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      this.removeItem(id);
    });
  }

  /** Folders act like are.na channels. Counts include subfolders. */
  folderList() {
    const direct = this.store.folderCounts().map((r) => [nfc(r.folder), r.n]);
    const all = new Set([...[...this.folders].map(nfc), ...direct.map(([f]) => f)]);
    for (const f of [...all]) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) all.add(parts.slice(0, i).join('/'));
    }
    all.delete('');
    return [...all]
      .sort((a, b) => a.localeCompare(b))
      .map((f) => ({ folder: f, count: direct.reduce((n, [k, c]) => (k === f || k.startsWith(`${f}/`) ? n + c : n), 0) }));
  }

  // ---------- API shape ----------

  present(row, { full = false } = {}) {
    if (!row) return null;
    const meta = row.meta ? JSON.parse(row.meta) : null;
    const item = {
      id: row.id,
      name: row.name,
      folder: row.folder,
      path: row.path,
      ext: row.ext,
      kind: row.kind,
      size: row.size,
      width: row.width,
      height: row.height,
      duration: row.duration,
      pages: row.pages,
      color: row.color,
      title: row.name, // blocks are titled by their file name and format, e.g. "IMG_2931.jpg"
      contentTitle: row.title, // a link's page title, an HTML file's <title>
      aiTitle: row.ai_title,
      description: row.description || '',
      excerpt: row.excerpt,
      url: row.url,
      meta,
      summary: row.ai_summary,
      tags: this.store.visibleTags(row.id),
      tagStatus: row.tag_status,
      tagError: row.tag_error,
      addedAt: row.added_at,
      modifiedAt: row.mtime,
      thumb: row.thumb ? `/thumb/${row.hash}.webp` : null,
      preview: row.preview ? `/preview/${row.hash}.jpg` : null,
      file: `/file/${row.id}/${encodeURIComponent(row.name)}`,
      editable: EDITABLE.has(row.ext),
    };
    if (full) {
      const tags = this.store.tagsFor(row.id);
      item.keywords = row.ai_keywords;
      item.tagModel = row.tag_model;
      item.taggedAt = row.tagged_at;
      item.userTags = tags.filter((t) => t.source === 'user').map((t) => t.tag);
      item.hiddenTags = tags.filter((t) => t.source === 'hidden').map((t) => t.tag);
      item.text = row.body;
    }
    return item;
  }

  async readText(row) {
    if (EDITABLE.has(row.ext) && row.size < 4 * MB) {
      try {
        return await fsp.readFile(this.abs(row.path), 'utf8');
      } catch {}
    }
    return row.body;
  }
}
