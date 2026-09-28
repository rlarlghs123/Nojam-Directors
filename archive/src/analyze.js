import fsp from 'node:fs/promises';
import sharp from 'sharp';
import { clampBody, excerptOf, extractText, looksLikeText } from './extract.js';
import { HEIC, RAW, WEB_IMAGES } from './kinds.js';
import { fetchImage, fetchLinkMeta, parseLinkFile } from './links.js';
import { frame, pdfFirstPage, probe, quickLook, sips } from './media.js';
import { readHead } from './util.js';
import { openZip } from './zip.js';

const MB = 1024 * 1024;

/**
 * Look inside a file and produce everything a block needs: thumbnail, preview, text, metadata.
 * `file` is { abs, name, ext, kind, size, hash }.
 */
export async function analyze(file, thumbs) {
  const handler = HANDLERS[file.kind] || analyzeOther;
  const out = await handler(file, thumbs);
  return { kind: file.kind, thumb: false, preview: false, ...out };
}

const HANDLERS = {
  image: analyzeImage,
  video: analyzeVideo,
  audio: analyzeAudio,
  text: analyzeText,
  pdf: analyzePdf,
  link: analyzeLink,
  font: analyzeFont,
  design: analyzeDesign,
  file: analyzeOther,
};

/** Try image sources in order until sharp can make a thumbnail from one. */
async function thumbFromSources(sources, file, thumbs, { forcePreview = false } = {}) {
  const tried = new Set();
  for (const [label, get] of sources) {
    if (tried.has(label)) continue;
    tried.add(label);
    let input;
    try {
      input = await get();
    } catch {
      continue;
    }
    if (!input) continue;
    const native = input === file.abs;
    // Web formats are shown as-is; big files and everything else also get a lighter JPEG preview.
    const preview = forcePreview || !native || !WEB_IMAGES.has(file.ext) || file.size > 12 * MB;
    try {
      const r = await thumbs.fromImage(input, file.hash, {
        preview,
        animated: native && (file.ext === 'gif' || file.ext === 'webp'),
        density: native && file.ext === 'svg' ? 216 : undefined, // render vector art crisply
      });
      return { ...r, thumb: true, preview, source: label };
    } catch {}
  }
  return null;
}

// ---------- images ----------

function imageSources(file) {
  const { abs, ext, size } = file;
  const sources = [];
  if (RAW.has(ext)) sources.push(['sips', () => sips(abs)], ['embedded', () => embeddedImage(abs, size)]);
  if (HEIC.has(ext)) sources.push(['sips', () => sips(abs)], ['heic', () => decodeHeic(abs)]);
  if ((ext === 'psd' || ext === 'psb') && size < 400 * MB) sources.push(['psd', () => decodePsd(abs)]);
  sources.push(
    ['sharp', () => abs],
    ['sips', () => sips(abs)],
    ['ffmpeg', () => frame(abs, 0)],
    ['embedded', () => embeddedImage(abs, size)],
    ['quicklook', () => quickLook(abs)],
  );
  return sources;
}

async function analyzeImage(file, thumbs) {
  const r = await thumbFromSources(imageSources(file), file, thumbs);
  return r ? { width: r.width, height: r.height, color: r.color, thumb: true, preview: r.preview, source: r.source } : {};
}

async function decodeHeic(abs) {
  const decode = (await import('heic-decode')).default;
  const { width, height, data } = await decode({ buffer: await fsp.readFile(abs) });
  const pixels = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data);
  return sharp(pixels, { raw: { width, height, channels: 4 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

let psdReady = false;
async function decodePsd(abs) {
  const { initializeCanvas, readPsd } = await import('ag-psd');
  if (!psdReady) {
    // We only want raw pixels, so hand ag-psd a plain ImageData factory instead of a real canvas.
    initializeCanvas(
      () => {
        throw new Error('canvas not available');
      },
      (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4), colorSpace: 'srgb' }),
    );
    psdReady = true;
  }
  const psd = readPsd(await fsp.readFile(abs), {
    skipLayerImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    useImageData: true,
  });
  const img = psd.imageData;
  if (!img?.data) return null;
  return sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength), {
    raw: { width: img.width, height: img.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

// ---------- embedded previews (RAW, Illustrator, InDesign, Affinity, EPS, …) ----------

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);

function pngEnd(buf, p) {
  let i = p + 8;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.toString('latin1', i + 4, i + 8);
    i += 12 + len;
    if (type === 'IEND') return i <= buf.length ? i : 0;
    if (!/^[a-zA-Z]{4}$/.test(type)) return 0;
  }
  return 0;
}

function jpegEnd(buf, p) {
  let i = p + 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return 0;
    const marker = buf[i + 1];
    if (marker === 0xd9) return i + 2;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    i += 2 + len;
    if (marker === 0xda) {
      // Entropy-coded data runs until the next real marker (FF 00 is a stuffed byte, FF D0–D7 are restarts).
      while (i + 1 < buf.length) {
        if (buf[i] === 0xff && buf[i + 1] !== 0 && !(buf[i + 1] >= 0xd0 && buf[i + 1] <= 0xd7)) break;
        i++;
      }
    }
  }
  return 0;
}

/** The largest image embedded in a file: XMP thumbnails, PNG or JPEG previews. */
export async function embeddedImage(abs, size) {
  const buf = await readHead(abs, size, 48 * MB);
  const candidates = [];
  const xmpArea = buf.subarray(0, 16 * MB).toString('latin1');
  for (const m of xmpArea.matchAll(/<xmpGImg:image>([^<]{100,})<\/xmpGImg:image>/g)) {
    candidates.push(Buffer.from(m[1].replace(/&#xA;|\s/g, ''), 'base64'));
  }
  for (let i = buf.indexOf(PNG_SIG); i !== -1 && candidates.length < 30; i = buf.indexOf(PNG_SIG, i + 8)) {
    const end = pngEnd(buf, i);
    if (end) candidates.push(buf.subarray(i, end));
  }
  for (let i = buf.indexOf(JPEG_SOI); i !== -1 && candidates.length < 60; i = buf.indexOf(JPEG_SOI, i + 3)) {
    const end = jpegEnd(buf, i);
    if (end - i > 2048) candidates.push(buf.subarray(i, end));
  }
  let best = null;
  let bestArea = 64 * 64;
  for (const c of candidates) {
    try {
      const { width, height } = await sharp(c).metadata();
      if (width * height > bestArea) {
        await sharp(c).resize(8).toBuffer(); // make sure it really decodes
        best = c;
        bestArea = width * height;
      }
    } catch {}
  }
  return best;
}

// ---------- video & audio ----------

async function pickSharpest(frames) {
  let best = frames[0];
  let score = -1;
  for (const f of frames) {
    const { entropy } = await sharp(f).stats();
    if (entropy > score) {
      best = f;
      score = entropy;
    }
  }
  return best;
}

async function analyzeVideo(file, thumbs) {
  const info = await probe(file.abs);
  if (info) {
    const d = info.duration || 0;
    const times = d > 2 ? [0.1, 0.35, 0.6, 0.85].map((f) => f * d) : [0];
    const frames = [];
    for (const t of times) {
      const f = await frame(file.abs, t);
      if (f) frames.push(f);
    }
    if (frames.length) {
      const r = await thumbs.fromImage(await pickSharpest(frames), file.hash, { preview: frames.length === 1 });
      if (frames.length > 1) await thumbs.contactSheet(frames, file.hash);
      return { width: info.width || r.width, height: info.height || r.height, duration: d || null, color: r.color, thumb: true, preview: true };
    }
    return { width: info.width, height: info.height, duration: d || null };
  }
  const r = await thumbFromSources([['quicklook', () => quickLook(file.abs)]], file, thumbs);
  return r ? { color: r.color, thumb: true, preview: true } : {};
}

async function analyzeAudio(file, thumbs) {
  const info = await probe(file.abs);
  const out = { duration: info?.duration || null };
  if (info?.hasCover) {
    const r = await thumbFromSources([['cover', () => frame(file.abs, 0)]], file, thumbs);
    if (r) Object.assign(out, { color: r.color, thumb: true, preview: true });
  }
  return out;
}

// ---------- writings ----------

async function analyzeText(file) {
  let r = null;
  try {
    r = await extractText(file.abs, file.ext, file.size);
  } catch {}
  const text = r?.text || '';
  return { title: r?.title || null, excerpt: excerptOf(text), body: clampBody(text) };
}

async function renderPdf(abs, size) {
  if (size > 300 * MB) return null;
  const { renderPageAsImage } = await import('unpdf');
  const png = await renderPageAsImage(new Uint8Array(await fsp.readFile(abs)), 1, {
    canvasImport: () => import('@napi-rs/canvas'),
    width: 1400,
  });
  return Buffer.from(png);
}

async function analyzePdf(file, thumbs) {
  let r = null;
  try {
    r = await extractText(file.abs, file.ext, file.size);
  } catch {}
  const text = r?.text || '';
  const out = { pages: r?.pages || null, excerpt: excerptOf(text), body: clampBody(text) };
  const img = await thumbFromSources(
    [
      ['pdfjs', () => renderPdf(file.abs, file.size)],
      ['pdftoppm', () => pdfFirstPage(file.abs)],
      ['sips', () => sips(file.abs)],
      ['quicklook', () => quickLook(file.abs)],
      ['embedded', () => embeddedImage(file.abs, file.size)],
    ],
    file,
    thumbs,
  );
  if (img) Object.assign(out, { width: img.width, height: img.height, color: img.color, thumb: true, preview: true });
  return out;
}

// ---------- links ----------

async function analyzeLink(file, thumbs) {
  const url = parseLinkFile(await fsp.readFile(file.abs), file.ext);
  // Only web links: a shortcut to javascript: or file: must never become a clickable link.
  if (!url || !/^https?:\/\//i.test(url)) return { kind: 'file' };
  const meta = file.linkMeta?.url === url ? file.linkMeta : await fetchLinkMeta(url);
  const out = {
    url,
    title: meta.title || null,
    excerpt: excerptOf(meta.description || ''),
    body: clampBody([meta.description, meta.author, meta.text].filter(Boolean).join('\n\n')),
    meta: { site: meta.site, provider: meta.provider || null, embed: meta.embed || null, author: meta.author || null, error: meta.error || null },
  };
  const imageUrl = meta.isImage ? meta.finalUrl || url : meta.image;
  if (imageUrl) {
    const img = await thumbFromSources([['og:image', async () => (await fetchImage(imageUrl)).data]], file, thumbs);
    if (img) Object.assign(out, { color: img.color, thumb: true, preview: true });
  }
  return out;
}

// ---------- fonts ----------

/** Family/style names from a TrueType/OpenType 'name' table. */
function fontNames(buf) {
  const sig = buf.readUInt32BE(0);
  if (![0x00010000, 0x4f54544f, 0x74727565].includes(sig)) return null; // TrueType, 'OTTO', 'true'
  const numTables = buf.readUInt16BE(4);
  for (let t = 0; t < numTables; t++) {
    const rec = 12 + t * 16;
    if (buf.toString('latin1', rec, rec + 4) !== 'name') continue;
    const off = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(off + 2);
    const strings = off + buf.readUInt16BE(off + 4);
    const names = {};
    for (let i = 0; i < count; i++) {
      const r = off + 6 + i * 12;
      const platform = buf.readUInt16BE(r);
      const nameId = buf.readUInt16BE(r + 6);
      const len = buf.readUInt16BE(r + 8);
      const start = strings + buf.readUInt16BE(r + 10);
      if (![1, 2, 4, 16, 17].includes(nameId) || names[nameId]) continue;
      const raw = buf.subarray(start, start + len);
      names[nameId] = (platform === 3 || platform === 0 ? new TextDecoder('utf-16be').decode(raw) : raw.toString('latin1')).trim();
    }
    return { family: names[16] || names[1] || null, style: names[17] || names[2] || null, full: names[4] || null };
  }
  return null;
}

async function analyzeFont(file) {
  if (file.ext === 'woff' || file.ext === 'woff2') return {};
  try {
    const names = fontNames(Buffer.from(await readHead(file.abs, file.size, 16 * MB)));
    return names ? { title: names.full || names.family, meta: names } : {};
  } catch {
    return {};
  }
}

// ---------- design files ----------

const ZIP_DESIGN = new Set(['pages', 'key', 'numbers', 'sketch', 'fig', 'xd', 'pptx', 'epub']);

async function zipPreview(file) {
  const zip = await openZip(file.abs);
  if (file.ext === 'epub') {
    const opfPath = (await zip.text('META-INF/container.xml'))?.match(/full-path="([^"]+)"/)?.[1];
    const opf = opfPath && (await zip.text(opfPath));
    if (opf) {
      const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
      const coverId = opf.match(/<meta\b[^>]*name="cover"[^>]*content="([^"]+)"/)?.[1];
      const item =
        opf.match(/<item\b[^>]*properties="[^"]*cover-image[^"]*"[^>]*>/)?.[0] ||
        (coverId && opf.match(new RegExp(`<item\\b[^>]*id="${coverId.replace(/[^\w-]/g, '')}"[^>]*>`))?.[0]);
      const href = item?.match(/href="([^"]+)"/)?.[1];
      if (href) return zip.read(base + decodeURIComponent(href));
    }
  }
  const preferred = ['preview.jpg', 'QuickLook/Preview.jpg', 'QuickLook/Thumbnail.jpg', 'previews/preview.png', 'thumbnail.png', 'docProps/thumbnail.jpeg', 'Thumbnails/thumbnail.png'];
  const name =
    preferred.find((n) => zip.has(n)) ||
    zip
      .find((n) => /(^|\/)(preview|thumbnail)[^/]*\.(png|jpe?g)$/i.test(n))
      .sort((a, b) => zip.entries.get(b).usize - zip.entries.get(a).usize)[0];
  return name ? zip.read(name) : null;
}

async function analyzeDesign(file, thumbs) {
  const out = {};
  if (file.ext === 'pptx' || file.ext === 'epub') Object.assign(out, await analyzeText(file));
  const sources = [];
  if (ZIP_DESIGN.has(file.ext)) sources.push(['zip', () => zipPreview(file)]);
  sources.push(['quicklook', () => quickLook(file.abs)], ['embedded', () => embeddedImage(file.abs, file.size)]);
  const r = await thumbFromSources(sources, file, thumbs, { forcePreview: true });
  if (r) Object.assign(out, { width: r.width, height: r.height, color: r.color, thumb: true, preview: true });
  return out;
}

// ---------- anything else ----------

async function analyzeOther(file, thumbs) {
  if (file.size < 4 * MB && looksLikeText(await readHead(file.abs, file.size, 64 * 1024))) {
    return { kind: 'text', ...(await analyzeText(file)) };
  }
  const r = await thumbFromSources([['quicklook', () => quickLook(file.abs)]], file, thumbs, { forcePreview: true });
  return r ? { width: r.width, height: r.height, color: r.color, thumb: true, preview: true } : {};
}
