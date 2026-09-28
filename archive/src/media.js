import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from './util.js';

// External tools are optional. Each one unlocks more previews when it is installed:
//   ffmpeg          video/audio thumbnails, and a fallback decoder for odd image formats
//   pdftoppm        PDF first-page thumbnails (poppler)
//   sips, qlmanage  macOS built-ins: HEIC/RAW/PSD conversion and Quick Look thumbnails for almost anything

const isMac = process.platform === 'darwin';
const found = new Map();

async function locate(name, candidates, probeArgs) {
  if (found.has(name)) return found.get(name);
  for (const c of candidates.filter(Boolean)) {
    const r = await run(c, probeArgs, { timeout: 10_000 });
    if (!r.missing && (r.ok || r.stderr || r.stdout?.length)) {
      found.set(name, c);
      return c;
    }
  }
  found.set(name, null);
  return null;
}

let ffmpegOverride = '';
export function setFfmpegPath(p) {
  ffmpegOverride = p;
  found.delete('ffmpeg');
}

export async function ffmpeg() {
  let bundled = null;
  try {
    bundled = (await import('ffmpeg-static')).default;
  } catch {}
  // A launchd/systemd service often has a short PATH, so also try the usual install locations.
  return locate(
    'ffmpeg',
    [ffmpegOverride, 'ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg', bundled],
    ['-hide_banner', '-version'],
  );
}

export async function pdftoppm() {
  return locate('pdftoppm', ['pdftoppm', '/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'], ['-v']);
}

export async function toolStatus() {
  return {
    ffmpeg: Boolean(await ffmpeg()),
    pdftoppm: Boolean(await pdftoppm()),
    macOS: isMac,
  };
}

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'archive-'));
}

// ---------- ffmpeg ----------

/** Duration, size and rotation from `ffmpeg -i` (it exits non-zero without an output file; that's expected). */
export async function probe(file) {
  const bin = await ffmpeg();
  if (!bin) return null;
  const r = await run(bin, ['-hide_banner', '-i', file], { timeout: 30_000 });
  const text = r.stderr;
  const out = {};
  const d = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (d) out.duration = Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]);
  const videoLines = text.split('\n').filter((l) => /Stream #.*Video:/.test(l));
  const main = videoLines.find((l) => !/attached pic/.test(l)) || videoLines[0];
  const size = main?.match(/,\s*(\d{2,5})x(\d{2,5})[\s,[]/);
  if (size) {
    out.width = Number(size[1]);
    out.height = Number(size[2]);
    const rot = text.match(/rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+)/);
    const deg = rot ? Math.round(Math.abs(Number(rot[1] ?? rot[2]))) % 180 : 0;
    if (deg === 90) [out.width, out.height] = [out.height, out.width];
  }
  out.hasVideo = videoLines.some((l) => !/attached pic/.test(l));
  out.hasCover = videoLines.some((l) => /attached pic/.test(l));
  out.hasAudio = /Stream #.*Audio:/.test(text);
  return out;
}

/** One PNG frame at `seconds` (or the cover art of an audio file). */
export async function frame(file, seconds = 0) {
  const bin = await ffmpeg();
  if (!bin) return null;
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (seconds > 0) args.push('-ss', seconds.toFixed(2));
  args.push('-i', file, '-frames:v', '1', '-vf', "scale='min(1600,iw)':-2", '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1');
  const r = await run(bin, args, { timeout: 60_000 });
  return r.stdout?.length > 100 ? r.stdout : null;
}

// ---------- PDF ----------

export async function pdfFirstPage(file) {
  const bin = await pdftoppm();
  if (!bin) return null;
  const dir = await tmpDir();
  try {
    const base = path.join(dir, 'page');
    const r = await run(bin, ['-f', '1', '-l', '1', '-png', '-singlefile', '-scale-to', '1600', file, base], { timeout: 60_000 });
    if (!r.ok) return null;
    return await fsp.readFile(base + '.png');
  } catch {
    return null;
  } finally {
    fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---------- macOS ----------

/** sips converts HEIC, RAW, PSD, TIFF, PDF (first page) … to JPEG. */
export async function sips(file) {
  if (!isMac) return null;
  const dir = await tmpDir();
  try {
    const out = path.join(dir, 'out.jpg');
    const r = await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '1600', file, '--out', out], { timeout: 60_000 });
    if (!r.ok) return null;
    return await fsp.readFile(out);
  } catch {
    return null;
  } finally {
    fsp.rm(dir, { recursive: true, force: true });
  }
}

/** Quick Look thumbnail: works for Keynote, Pages, Sketch, Illustrator, fonts, … anything with a QL plugin. */
export async function quickLook(file) {
  if (!isMac) return null;
  const dir = await tmpDir();
  try {
    const r = await run('/usr/bin/qlmanage', ['-t', '-s', '1200', '-o', dir, file], { timeout: 60_000 });
    if (!r.ok) return null;
    const png = (await fsp.readdir(dir)).find((n) => n.endsWith('.png'));
    return png ? await fsp.readFile(path.join(dir, png)) : null;
  } catch {
    return null;
  } finally {
    fsp.rm(dir, { recursive: true, force: true });
  }
}

/** textutil reads .doc, .docx, .rtf, .odt, .webarchive … */
export async function textutil(file) {
  if (!isMac) return null;
  const r = await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], { timeout: 60_000, encoding: 'utf8' });
  return r.ok ? String(r.stdout) : null;
}

/** Ask iCloud to download a file that is only a placeholder on this Mac. */
export function icloudDownload(file) {
  if (isMac) run('/usr/bin/brctl', ['download', file], { timeout: 120_000 });
}
