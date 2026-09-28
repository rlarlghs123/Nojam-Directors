import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const nfc = (s) => (s == null ? s : String(s).normalize('NFC'));

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/** Library paths are stored with '/' separators, relative to the library root. */
export const toPosix = (p) => p.split(path.sep).join('/');

// Names that should never become library items.
const JUNK = /^(desktop\.ini|thumbs\.db|icon\r|~\$.*|.*\.(tmp|temp|part|crdownload|download|partial|swp|lock))$/i;

/** True for files/folders the archive ignores: dotfiles (.archive, .trash, .DS_Store…), temp files, OS junk. */
export function isIgnoredName(name) {
  return name.startsWith('.') || name === 'node_modules' || JUNK.test(name);
}

export function isIgnoredPath(rel) {
  return rel.split('/').some((seg) => seg && isIgnoredName(seg));
}

/** Make a user-supplied file or folder name safe for every OS we might sync to. */
export function safeName(input, fallback = 'untitled') {
  let s = nfc(String(input ?? ''))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '') // a leading dot would hide the file from the archive
    .replace(/[.\s]+$/, ''); // Windows dislikes trailing dots and spaces
  // Keep names comfortably under the 255-byte limit of most filesystems.
  while (Buffer.byteLength(s) > 180) s = s.slice(0, -1);
  return s || fallback;
}

/** Validate a folder path like "Posters/Swiss". Returns '' for the library root. */
export function safeFolder(input) {
  if (!input) return '';
  const parts = String(input).split(/[/\\]+/).filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) throw Object.assign(new Error('Invalid folder'), { status: 400 });
  return parts.map((p) => safeName(p, 'folder')).join('/');
}

/** "name.ext" → "name (2).ext" until it doesn't exist in dir. */
export async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, i === 1 ? name : `${base} (${i})${ext}`);
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
  }
}

/** Move a file, falling back to copy+delete across filesystems (e.g. Docker volumes). */
export async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(from);
  }
}

export async function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

/** Run at most `n` async jobs at once. */
export function limiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      waiting.push({ fn, resolve, reject });
      next();
    });
}

/** Serialize work per key (e.g. per file path). */
export function keyedLock() {
  const tails = new Map();
  return (key, fn) => {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/** execFile as a promise. Resolves even on non-zero exit (ffmpeg -i does that on purpose). */
export function run(cmd, args, { timeout = 60_000, encoding = 'buffer', maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        missing: err?.code === 'ENOENT',
        stdout,
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
      });
    });
  });
}

/** Read at most `max` bytes from the start of a file. */
export async function readHead(file, size, max) {
  if (size <= max) return fsp.readFile(file);
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
