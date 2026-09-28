import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Settings live in archive/.env (see .env.example). Real environment variables win.
const envFile = path.join(appDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function dir(value, fallback) {
  let p = (value || fallback).trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(appDir, p);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value != null ? n : fallback;
}

export function loadConfig(overrides = {}) {
  return {
    // Where your files live. Point this at a folder inside iCloud Drive / Google Drive / a NAS share.
    libraryDir: dir(env.ARCHIVE_DIR, './library'),
    // Local cache: SQLite index + thumbnails. Keep it OUT of the synced folder.
    dataDir: dir(env.DATA_DIR, './data'),
    host: env.HOST || '127.0.0.1',
    port: num(env.PORT, 3000),
    password: env.ARCHIVE_PASSWORD || '',
    title: env.ARCHIVE_TITLE || 'Archive',
    // Who writes the tags: ollama (free, on this computer) | claude | gemini | openrouter | custom (see providers.js).
    tagger: (env.TAGGER || 'ollama').trim().toLowerCase(),
    tagModel: env.TAG_MODEL || '', // empty = the provider's default model
    tagUrl: env.TAG_API_URL || '',
    tagKey: env.TAG_API_KEY || '',
    model: env.CLAUDE_MODEL || 'claude-opus-5', // older setting, still honoured for Claude
    autoTag: (env.AUTO_TAG || 'on').toLowerCase() !== 'off',
    // First language = tag language; the rest are added as hidden search keywords.
    languages: (env.ARCHIVE_LANGUAGES || 'en').split(',').map((s) => s.trim()).filter(Boolean),
    tagConcurrency: Math.max(0, num(env.TAG_CONCURRENCY, 0)), // 0 = the provider's default
    // Ask before auto-tagging a backlog bigger than this (e.g. first scan of a big folder).
    confirmBacklog: num(env.TAG_CONFIRM_OVER, 50),
    rescanMinutes: num(env.RESCAN_MINUTES, 10),
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 4096) * 1024 * 1024,
    ffmpegPath: env.FFMPEG_PATH || '',
    watch: (env.WATCH || 'on').toLowerCase() !== 'off',
    ...overrides,
  };
}
