import fsp from 'node:fs/promises';
import { MARKDOWN } from './kinds.js';
import { textutil } from './media.js';
import { readHead } from './util.js';
import { openZip } from './zip.js';

// Turns writings of every kind into plain text: the first lines become the block's "thumbnail",
// the rest goes into the search index.

const MAX_BODY = 200_000;

// ---------- decoding ----------

/** Decode bytes of unknown encoding: BOMs, UTF-8, then legacy Korean (CP949) or Western (1252). */
export function decodeText(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.toString('utf8', 3);
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {}
  return new TextDecoder(looksLikeCp949(buf) ? 'euc-kr' : 'windows-1252').decode(buf);
}

/** Old Korean text files are CP949: nearly all high bytes pair up as Hangul syllables (B0–C8, A1–FE). */
function looksLikeCp949(buf) {
  let high = 0;
  let hangul = 0;
  for (let i = 0; i < buf.length && i < 65_536; i++) {
    const b = buf[i];
    if (b < 0x80) continue;
    const t = buf[i + 1];
    if (b >= 0xb0 && b <= 0xc8 && t >= 0xa1 && t <= 0xfe) {
      hangul += 2;
      high += 2;
      i++;
    } else {
      high++;
    }
  }
  return high > 0 && hangul / high > 0.6;
}

/** Heuristic: is this unknown file actually text? (no NUL bytes in the first 8 KB, decodes cleanly) */
export function looksLikeText(buf) {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - 4));
    return true;
  } catch {
    return false;
  }
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×',
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function tidy(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- formats ----------

export function htmlTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

export function htmlToText(html) {
  const body = html
    .replace(/<(script|style|noscript|template|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|table|ul|ol|header|figure)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  return tidy(decodeEntities(body).replace(/[ \t\f\v ]+/g, ' ').replace(/ *\n */g, '\n'));
}

/** Text inside XML runs: turn paragraph ends into newlines, drop all tags. */
function xmlText(xml, { para, tab = null, br = null }) {
  let s = xml;
  if (tab) s = s.replace(tab, '\t');
  if (br) s = s.replace(br, '\n');
  s = s.replace(para, '\n').replace(/<[^>]+>/g, '');
  return tidy(decodeEntities(s));
}

const RTF_SKIP = new Set([
  'fonttbl', 'colortbl', 'expandedcolortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr',
  'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata',
  'colorschememapping', 'latentstyles', 'datastore', 'fldinst', 'object', 'objdata', 'filetbl', 'revtbl', 'mmathPr',
]);
const RTF_CHARS = { emdash: '—', endash: '–', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', bullet: '•', tab: '\t', cell: '\t' };
const CODEPAGES = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 10000: 'macintosh', 65001: 'utf-8' };

/** Minimal RTF reader: text, \uN unicode escapes, and \'hh bytes in the document's code page (e.g. CP949). */
export function rtfToText(src) {
  let out = '';
  let bytes = [];
  let codepage = 'windows-1252';
  const stack = [];
  let skip = false;
  let uc = 1;
  let pendingSkip = 0;
  const flush = () => {
    if (!bytes.length) return;
    try {
      out += new TextDecoder(codepage).decode(Uint8Array.from(bytes));
    } catch {
      out += Buffer.from(bytes).toString('latin1');
    }
    bytes = [];
  };
  const emit = (s) => {
    if (skip) return;
    flush();
    out += s;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      stack.push({ skip, uc });
      i++;
    } else if (c === '}') {
      flush();
      ({ skip, uc } = stack.pop() || { skip: false, uc: 1 });
      i++;
    } else if (c === '\\') {
      const n = src[i + 1];
      if (n === "'") {
        const byte = parseInt(src.substr(i + 2, 2), 16);
        i += 4;
        if (pendingSkip > 0) pendingSkip--;
        else if (!skip && Number.isFinite(byte)) bytes.push(byte);
      } else if (n === '\\' || n === '{' || n === '}') {
        i += 2;
        if (pendingSkip > 0) pendingSkip--;
        else emit(n);
      } else if (n === '*') {
        skip = true;
        i += 2;
      } else if (n === '~') {
        emit(' ');
        i += 2;
      } else if (n === '\n' || n === '\r') {
        emit('\n');
        i += 2;
      } else if (/[a-z]/i.test(n || '')) {
        let j = i + 1;
        while (j < src.length && /[a-z]/i.test(src[j])) j++;
        const word = src.slice(i + 1, j);
        let param = null;
        if (/[-\d]/.test(src[j] || '')) {
          let k = j + 1;
          while (k < src.length && /\d/.test(src[k])) k++;
          param = parseInt(src.slice(j, k), 10);
          j = k;
        }
        if (src[j] === ' ') j++;
        i = j;
        if (RTF_SKIP.has(word)) skip = true;
        else if (word === 'ansicpg') codepage = CODEPAGES[param] || `windows-${param}`;
        else if (word === 'uc') uc = param ?? 1;
        else if (word === 'u' && param != null) {
          emit(String.fromCharCode(param < 0 ? param + 65536 : param));
          pendingSkip = uc;
        } else if (word === 'par' || word === 'line' || word === 'sect' || word === 'page' || word === 'row') emit('\n');
        else if (RTF_CHARS[word]) emit(RTF_CHARS[word]);
      } else {
        i += 2;
      }
    } else if (c === '\n' || c === '\r') {
      i++;
    } else {
      if (pendingSkip > 0) pendingSkip--;
      else emit(c);
      i++;
    }
  }
  flush();
  return tidy(out);
}

/** Subtitles: keep the dialogue, drop numbering and timecodes. */
function subtitleText(text) {
  return tidy(
    text
      .split('\n')
      .filter((l) => !/^\s*\d+\s*$/.test(l) && !/-->/.test(l) && !/^WEBVTT/.test(l))
      .join('\n'),
  );
}

function stripFrontMatter(text) {
  return text.replace(/^---\n[\s\S]*?\n---\n/, '');
}

async function fromZip(file, ext) {
  const zip = await openZip(file);
  if (ext === 'docx') {
    const xml = await zip.text('word/document.xml');
    return xml && xmlText(xml, { para: /<\/w:p>/g, tab: /<w:tab\/>/g, br: /<w:(br|cr)\/>/g });
  }
  if (ext === 'odt') {
    const xml = await zip.text('content.xml');
    return xml && xmlText(xml.replace(/<text:s(?: text:c="(\d+)")?\/>/g, (m, n) => ' '.repeat(Number(n || 1))), {
      para: /<\/text:(p|h)>/g,
      tab: /<text:tab\/>/g,
      br: /<text:line-break\/>/g,
    });
  }
  if (ext === 'hwpx') {
    const sections = zip.find((n) => /^Contents\/section\d+\.xml$/i.test(n)).sort((a, b) => sectionNo(a) - sectionNo(b));
    let out = '';
    for (const s of sections) {
      out += xmlText(await zip.text(s), { para: /<\/hp:p>/g, tab: /<hp:tab\b[^>]*\/>/g, br: /<hp:lineBreak\/>/g }) + '\n';
      if (out.length > MAX_BODY) break;
    }
    return tidy(out);
  }
  if (ext === 'pptx') {
    const slides = zip.find((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => sectionNo(a) - sectionNo(b));
    let out = '';
    for (const s of slides) out += xmlText(await zip.text(s), { para: /<\/a:p>/g }) + '\n\n';
    return tidy(out);
  }
  if (ext === 'epub') return epubText(zip);
  return null;
}

const sectionNo = (name) => Number(name.match(/(\d+)\.xml$/)?.[1] ?? 0);

async function epubText(zip) {
  const opfPath = (await zip.text('META-INF/container.xml'))?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath && (await zip.text(opfPath));
  if (!opf) return null;
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  let out = '';
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]);
    const html = href && (await zip.text(base + href));
    if (html) out += htmlToText(html) + '\n\n';
    if (out.length > MAX_BODY) break;
  }
  return tidy(out);
}

/** HWP 5 (Hangul) is an OLE file; its PrvText stream holds the first part of the text in UTF-16. */
async function hwpText(buf) {
  const CFB = (await import('cfb')).default;
  const doc = CFB.read(buf, { type: 'buffer' });
  const prv = CFB.find(doc, 'PrvText');
  if (!prv?.content) return null;
  const text = Buffer.from(prv.content).toString('utf16le').replace(/\u0000+$/, '');
  return tidy(text.replace(/>\s*</g, '\n').replace(/^</, '').replace(/>$/, ''));
}

async function pdfText(file) {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(await fsp.readFile(file)));
  try {
    let text = '';
    for (let i = 1; i <= Math.min(pdf.numPages, 60) && text.length < MAX_BODY; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map((it) => (it.str ?? '') + (it.hasEOL ? '\n' : '')).join('') + '\n\n';
    }
    return { text: tidy(text), pages: pdf.numPages };
  } finally {
    await pdf.destroy?.();
  }
}

/**
 * Extract text from a writing. Returns { text, title?, pages? } or null when there's nothing to read.
 */
export async function extractText(file, ext, size) {
  if (ext === 'pdf' || ext === 'ai') return size <= 300 * 1024 * 1024 ? pdfText(file) : null;
  if (['docx', 'odt', 'hwpx', 'pptx', 'epub'].includes(ext)) {
    const text = await fromZip(file, ext);
    return text != null ? { text } : null;
  }
  if (ext === 'doc') {
    const text = await textutil(file);
    return text ? { text: tidy(text) } : null;
  }
  if (ext === 'hwp') {
    const text = size <= 300 * 1024 * 1024 ? await hwpText(await fsp.readFile(file)) : null;
    return text ? { text } : null;
  }
  const raw = decodeText(await readHead(file, size, 4 * 1024 * 1024));
  if (ext === 'rtf') return { text: rtfToText(raw) };
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return { text: htmlToText(raw), title: htmlTitle(raw) };
  if (ext === 'srt' || ext === 'vtt') return { text: subtitleText(raw) };
  if (MARKDOWN.has(ext)) return { text: tidy(stripFrontMatter(raw.replace(/\r\n?/g, '\n'))) };
  return { text: tidy(raw) };
}

export function clampBody(text) {
  return text && text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

/** The first lines of a text, as shown on its block. */
export function excerptOf(text, { lines = 16, chars = 900 } = {}) {
  if (!text) return '';
  const out = [];
  let used = 0;
  for (const line of text.replace(/^\s+/, '').split('\n')) {
    if (out.length >= lines || used >= chars) break;
    const piece = line.length > chars - used ? line.slice(0, chars - used) + '…' : line;
    out.push(piece);
    used += piece.length + 1;
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}
