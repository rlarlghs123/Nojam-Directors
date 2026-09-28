import { decodeEntities, htmlTitle, htmlToText } from './extract.js';

// Links are stored as ordinary shortcut files (.url, .webloc, …) in the library, so they sync
// with your drive like everything else. Their preview (title, description, image) is fetched here.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const HTML_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;

/** The URL inside a shortcut file. */
export function parseLinkFile(buf, ext) {
  const text = buf.toString('utf8');
  if (ext === 'url' || ext === 'desktop') return text.match(/^\s*URL\s*=\s*(\S+)/im)?.[1] || null;
  if (ext === 'webloc') {
    const xml = text.match(/<key>URL<\/key>\s*<string>([^<]+)<\/string>/);
    if (xml) return decodeEntities(xml[1].trim());
    return buf.toString('latin1').match(/https?:\/\/[^\s\x00-\x1f"<>]+/)?.[0] || null; // binary plist
  }
  try {
    // Google Drive shortcuts (.gdoc, .gsheet, …) are small JSON files.
    const json = JSON.parse(text);
    return json.url || (json.doc_id ? `https://drive.google.com/open?id=${json.doc_id}` : null);
  } catch {
    return null;
  }
}

export function linkFileContent(url) {
  return `[InternetShortcut]\r\nURL=${url}\r\n`;
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+/.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links are supported');
  return u.toString();
}

export function youtubeId(u) {
  const url = new URL(u);
  const host = url.hostname.replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const m = url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }
  return null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function readLimited(res, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= limit) break;
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

function metaTags(html) {
  const out = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1] || '').toLowerCase();
    const content = tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ?? tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
    if (key && content != null && !(key in out)) out[key] = decodeEntities(content).trim();
  }
  return out;
}

function charsetOf(contentType, head) {
  const fromHeader = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  const fromMeta = head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  const label = (fromHeader || fromMeta || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label) && label;
  } catch {
    return 'utf-8';
  }
}

/**
 * Title, description, preview image and page text for a URL.
 * Never throws: on failure returns what it knows plus an `error`.
 */
export async function fetchLinkMeta(url) {
  const u = new URL(url);
  const out = { url, site: u.hostname.replace(/^www\./, '') };
  try {
    const yt = youtubeId(url);
    if (yt) {
      const o = await getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`).catch(() => ({}));
      return {
        ...out,
        provider: 'YouTube',
        title: o.title || '',
        author: o.author_name || '',
        image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`,
        embed: `https://www.youtube-nocookie.com/embed/${yt}`,
      };
    }
    if (/(^|\.)vimeo\.com$/.test(u.hostname)) {
      const o = await getJson(`https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(url)}`);
      return {
        ...out,
        provider: 'Vimeo',
        title: o.title || '',
        author: o.author_name || '',
        description: o.description || '',
        image: o.thumbnail_url || null,
        embed: o.video_id ? `https://player.vimeo.com/video/${o.video_id}` : null,
      };
    }
    if (/(^|\.)(docs|drive)\.google\.com$/.test(u.hostname)) return { ...out, provider: 'Google Drive' };

    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8', 'Accept-Language': 'en,ko;q=0.8,*;q=0.5' },
    });
    const type = res.headers.get('content-type') || '';
    out.finalUrl = res.url;
    if (!res.ok) return { ...out, error: `HTTP ${res.status}` };
    if (type.startsWith('image/')) {
      res.body?.cancel().catch(() => {});
      return { ...out, isImage: true, contentType: type };
    }
    if (!/html|xml/.test(type)) {
      res.body?.cancel().catch(() => {});
      return { ...out, contentType: type, title: decodeURIComponent(u.pathname.split('/').pop() || '') };
    }
    const buf = await readLimited(res, HTML_LIMIT);
    const head = buf.subarray(0, 4096).toString('latin1');
    const html = new TextDecoder(charsetOf(type, head)).decode(buf);
    const meta = metaTags(html);
    const image = meta['og:image'] || meta['og:image:url'] || meta['og:image:secure_url'] || meta['twitter:image'] || meta['twitter:image:src'];
    return {
      ...out,
      title: meta['og:title'] || meta['twitter:title'] || htmlTitle(html) || '',
      description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
      site: meta['og:site_name'] || out.site,
      image: image ? new URL(image, res.url).toString() : null,
      text: htmlToText(html).slice(0, 8000),
    };
  } catch (err) {
    return { ...out, error: err.name === 'TimeoutError' ? 'Timed out' : err.message };
  }
}

/** Download an image (link preview, or a pasted image URL). */
export async function fetchImage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.5' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > IMAGE_LIMIT) throw new Error('Image too large');
  const buf = await readLimited(res, IMAGE_LIMIT + 1);
  if (buf.length > IMAGE_LIMIT) throw new Error('Image too large');
  return { data: buf, contentType: res.headers.get('content-type') || '' };
}
