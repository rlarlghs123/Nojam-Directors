import { DatabaseSync } from 'node:sqlite';
import { nfc } from './util.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,      -- on-disk path relative to the library root, '/' separated
  folder      TEXT NOT NULL DEFAULT '',  -- display folder (NFC)
  name        TEXT NOT NULL,             -- display file name (NFC)
  ext         TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,             -- image | video | audio | text | pdf | link | font | design | file
  size        INTEGER NOT NULL DEFAULT 0,
  mtime       INTEGER NOT NULL DEFAULT 0,
  hash        TEXT,
  width       INTEGER,
  height      INTEGER,
  duration    REAL,
  pages       INTEGER,
  title       TEXT,                      -- title found in the content (links, documents)
  excerpt     TEXT,                      -- first lines, shown on text blocks
  body        TEXT,                      -- extracted text, for search
  url         TEXT,
  meta        TEXT,                      -- JSON: link provider/embed, font family, ...
  thumb       INTEGER NOT NULL DEFAULT 0,
  preview     INTEGER NOT NULL DEFAULT 0,
  color       TEXT,
  description TEXT,                      -- written by you in the block's panel
  ai_title    TEXT,
  ai_summary  TEXT,
  ai_keywords TEXT,
  tag_status  TEXT NOT NULL DEFAULT 'pending',  -- pending | tagging | done | error
  tag_error   TEXT,
  tag_model   TEXT,
  tagged_at   INTEGER,
  added_at    INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_hash ON items(hash);
CREATE INDEX IF NOT EXISTS items_added ON items(added_at);
CREATE INDEX IF NOT EXISTS items_status ON items(tag_status);
CREATE INDEX IF NOT EXISTS items_folder ON items(folder);

CREATE TABLE IF NOT EXISTS tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  source  TEXT NOT NULL,   -- ai | user | hidden (an AI tag the user removed)
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS tags_tag ON tags(tag);

-- Trigram index: substring search that works for any language (Korean, Japanese, ...).
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(title, tags, meta, body, tokenize = 'trigram');

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`;

const ITEM_COLUMNS = [
  'path', 'folder', 'name', 'ext', 'kind', 'size', 'mtime', 'hash', 'width', 'height', 'duration', 'pages',
  'title', 'excerpt', 'body', 'url', 'meta', 'thumb', 'preview', 'color', 'description', 'ai_title', 'ai_summary', 'ai_keywords',
  'tag_status', 'tag_error', 'tag_model', 'tagged_at', 'added_at', 'updated_at',
];

const ORDERS = {
  new: 'items.added_at DESC, items.id DESC',
  old: 'items.added_at ASC, items.id ASC',
  updated: 'items.mtime DESC, items.id DESC',
  alpha: 'items.name COLLATE NOCASE ASC, items.id ASC',
};

const bind = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);
const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

export function parseQuery(q) {
  const words = [];
  const tags = [];
  for (const m of nfc(q || '').matchAll(/"([^"]+)"|(\S+)/g)) {
    const quoted = m[1] != null;
    const word = (quoted ? m[1] : m[2]).trim().toLowerCase();
    if (!word) continue;
    if (!quoted && word.startsWith('#') && word.length > 1) tags.push(word.slice(1));
    else words.push(word);
  }
  return { words, tags };
}

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // Columns added after the first version: add them to an index made by an older version.
  const have = new Set(db.prepare('PRAGMA table_info(items)').all().map((c) => c.name));
  if (!have.has('description')) db.exec('ALTER TABLE items ADD COLUMN description TEXT');
  return new Store(db);
}

export class Store {
  constructor(db) {
    this.db = db;
    this.stmts = new Map();
  }

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, (s = this.db.prepare(sql)));
    return s;
  }

  tx(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }

  // ---------- items ----------

  insertItem(fields) {
    const cols = ITEM_COLUMNS.filter((c) => fields[c] !== undefined);
    const sql = `INSERT INTO items (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    const { lastInsertRowid } = this.q(sql).run(...cols.map((c) => bind(fields[c])));
    const id = Number(lastInsertRowid);
    this.refreshSearch(id);
    return id;
  }

  updateItem(id, fields) {
    const cols = ITEM_COLUMNS.filter((c) => fields[c] !== undefined);
    if (!cols.length) return;
    const sql = `UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`;
    this.q(sql).run(...cols.map((c) => bind(fields[c])), id);
    this.refreshSearch(id);
  }

  deleteItem(id) {
    this.tx(() => {
      this.q('DELETE FROM search WHERE rowid = ?').run(id);
      this.q('DELETE FROM tags WHERE item_id = ?').run(id);
      this.q('DELETE FROM items WHERE id = ?').run(id);
    });
  }

  getItem(id) {
    return this.q('SELECT * FROM items WHERE id = ?').get(id);
  }

  getByPath(path) {
    return this.q('SELECT * FROM items WHERE path = ?').get(path);
  }

  getByHash(hash) {
    return this.q('SELECT * FROM items WHERE hash = ?').all(hash);
  }

  getByUrl(url) {
    return this.q("SELECT * FROM items WHERE kind = 'link' AND url = ?").all(url);
  }

  countHash(hash) {
    return this.q('SELECT COUNT(*) AS n FROM items WHERE hash = ?').get(hash).n;
  }

  allPaths() {
    return this.q('SELECT id, path FROM items').all();
  }

  idsWithStatus(...statuses) {
    const sql = `SELECT id FROM items WHERE tag_status IN (${statuses.map(() => '?').join(',')}) ORDER BY added_at DESC`;
    return this.q(sql).all(...statuses).map((r) => r.id);
  }

  statusCounts() {
    const out = { total: 0, pending: 0, tagging: 0, done: 0, error: 0 };
    for (const r of this.q('SELECT tag_status AS s, COUNT(*) AS n FROM items GROUP BY tag_status').all()) {
      out[r.s] = r.n;
      out.total += r.n;
    }
    return out;
  }

  // ---------- tags ----------

  tagsFor(id) {
    return this.q('SELECT tag, source FROM tags WHERE item_id = ? ORDER BY rowid').all(id);
  }

  visibleTags(id) {
    return this.q("SELECT tag FROM tags WHERE item_id = ? AND source != 'hidden' ORDER BY source = 'ai', rowid")
      .all(id)
      .map((r) => r.tag);
  }

  /** Replace the AI tags of an item, keeping the user's own edits. */
  setAiTags(id, tags) {
    this.tx(() => {
      this.q("DELETE FROM tags WHERE item_id = ? AND source = 'ai'").run(id);
      const hidden = new Set(this.q("SELECT tag FROM tags WHERE item_id = ? AND source != 'ai'").all(id).map((r) => r.tag));
      const ins = this.q("INSERT OR IGNORE INTO tags (item_id, tag, source) VALUES (?, ?, 'ai')");
      for (const t of tags) if (!hidden.has(t)) ins.run(id, t);
    });
    this.refreshSearch(id);
  }

  /** Restore tags saved in a sidecar file. */
  setAllTags(id, { ai = [], user = [], hidden = [] }) {
    this.tx(() => {
      this.q('DELETE FROM tags WHERE item_id = ?').run(id);
      const ins = this.q('INSERT OR REPLACE INTO tags (item_id, tag, source) VALUES (?, ?, ?)');
      for (const t of ai) ins.run(id, t, 'ai');
      for (const t of user) ins.run(id, t, 'user');
      for (const t of hidden) ins.run(id, t, 'hidden');
    });
    this.refreshSearch(id);
  }

  addUserTag(id, tag) {
    this.q("INSERT INTO tags (item_id, tag, source) VALUES (?, ?, 'user') ON CONFLICT DO UPDATE SET source = 'user'").run(id, tag);
    this.refreshSearch(id);
  }

  removeTag(id, tag) {
    const row = this.q('SELECT source FROM tags WHERE item_id = ? AND tag = ?').get(id, tag);
    if (!row) return;
    if (row.source === 'ai') this.q("UPDATE tags SET source = 'hidden' WHERE item_id = ? AND tag = ?").run(id, tag);
    else if (row.source === 'user') this.q('DELETE FROM tags WHERE item_id = ? AND tag = ?').run(id, tag);
    this.refreshSearch(id);
  }

  /** Most used tags, handed to Claude so it reuses the archive's vocabulary. */
  vocabulary(limit = 150) {
    return this.q("SELECT tag FROM tags WHERE source != 'hidden' GROUP BY tag ORDER BY COUNT(*) DESC, tag LIMIT ?")
      .all(limit)
      .map((r) => r.tag);
  }

  /** Tag counts among the items matching the given search/filters. */
  tagCounts({ q = '', tags = [], folder = '', kinds = [], limit = 60 } = {}) {
    const f = this.#filter({ q, tags, folder, kinds });
    const sql = `SELECT tag, COUNT(*) AS n FROM tags
      WHERE source != 'hidden' AND item_id IN (SELECT items.id FROM ${f.from} ${f.whereSql})
      GROUP BY tag ORDER BY n DESC, tag LIMIT ?`;
    return this.q(sql).all(...f.params, limit);
  }

  folderCounts() {
    return this.q('SELECT folder, COUNT(*) AS n FROM items GROUP BY folder ORDER BY folder').all();
  }

  // ---------- search ----------

  refreshSearch(id) {
    const it = this.getItem(id);
    this.q('DELETE FROM search WHERE rowid = ?').run(id);
    if (!it) return;
    const low = (...parts) => parts.filter(Boolean).join(' \n ').toLowerCase();
    const stem = it.name.replace(/\.[^.]+$/, '');
    this.q('INSERT INTO search (rowid, title, tags, meta, body) VALUES (?, ?, ?, ?, ?)').run(
      id,
      low(stem, it.title, it.ai_title),
      low(this.visibleTags(id).join(' | '), it.description),
      low(it.folder, it.kind, it.ext, it.ai_summary, it.ai_keywords, it.url),
      low(it.body),
    );
  }

  #scope(where, params, { folder, kinds }) {
    if (folder) {
      where.push("(items.folder = ? OR items.folder LIKE ? ESCAPE '\\')");
      params.push(folder, likeEscape(folder) + '/%');
    }
    if (kinds?.length) {
      where.push(`items.kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
  }

  /**
   * Search + filter. Words of 3+ characters use the trigram index (substring match, ranked by bm25);
   * shorter words (e.g. two-syllable Korean words like 영화) fall back to a LIKE scan of the same columns.
   */
  #filter({ q = '', tags = [], folder = '', kinds = [] }) {
    const parsed = parseQuery(q);
    const allTags = [...new Set([...tags.map((t) => nfc(t).toLowerCase()), ...parsed.tags])];
    const where = [];
    const params = [];
    const match = [];

    for (const w of parsed.words) {
      if ([...w].length >= 3) {
        match.push(`"${w.replace(/"/g, '""')}"`);
      } else {
        const like = `%${likeEscape(w)}%`;
        where.push(
          "(search.title LIKE ? ESCAPE '\\' OR search.tags LIKE ? ESCAPE '\\' OR search.meta LIKE ? ESCAPE '\\' OR search.body LIKE ? ESCAPE '\\')",
        );
        params.push(like, like, like, like);
      }
    }
    if (match.length) {
      where.unshift('search MATCH ?');
      params.unshift(match.join(' AND '));
    }
    for (const t of allTags) {
      where.push("EXISTS (SELECT 1 FROM tags t WHERE t.item_id = items.id AND t.tag = ? AND t.source != 'hidden')");
      params.push(t);
    }
    this.#scope(where, params, { folder, kinds });
    return {
      from: parsed.words.length ? 'search JOIN items ON items.id = search.rowid' : 'items',
      whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '',
      params,
      ranked: match.length > 0,
    };
  }

  /**
   * `sort`: relevance (the default: best matches first when searching, else newest), new, old,
   * updated (file last changed), alpha (by file name) or random (stable for a given `seed`).
   */
  search({ q = '', tags = [], folder = '', kinds = [], sort = '', seed = 1, offset = 0, limit = 60 } = {}) {
    const { from, whereSql, params, ranked } = this.#filter({ q, tags, folder, kinds });
    let order = ORDERS[sort];
    if (sort === 'random') order = `((items.id * 1103515245 + ${Number(seed) | 0}) % 2147483647)`;
    else if (!order) order = ranked ? 'bm25(search, 10.0, 8.0, 3.0, 1.0), items.added_at DESC' : ORDERS.new;

    const total = this.q(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...params).n;
    const rows = this.q(`SELECT items.* FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).all(
      ...params,
      limit,
      offset,
    );
    return { total, rows };
  }

  /** Items sharing the most tags with this one. */
  related(id, limit = 12) {
    return this.q(
      `SELECT items.*, COUNT(*) AS shared FROM tags a
       JOIN tags b ON b.tag = a.tag AND b.item_id != a.item_id AND b.source != 'hidden'
       JOIN items ON items.id = b.item_id
       WHERE a.item_id = ? AND a.source != 'hidden'
       GROUP BY b.item_id ORDER BY shared DESC, items.added_at DESC LIMIT ?`,
    ).all(id, limit);
  }

  // ---------- key/value ----------

  get(k) {
    return this.q('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null;
  }

  set(k, v) {
    this.q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  }
}
