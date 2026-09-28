// Archive UI: an are.na-style grid of blocks. Vanilla JS, no build step.

const $ = (sel, root = document) => root.querySelector(sel);

/** Tiny element builder. Strings become text nodes, so user content is never parsed as HTML. */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- formatting ----------

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function ago(ms) {
  const s = (ms - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  }
  return 'just now';
}
const shortDate = (ms) =>
  Date.now() - ms < 6 * 86400000 ? ago(ms) : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const money = (n) => (n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`);

const MARKDOWN = new Set(['md', 'markdown', 'mdown', 'mkd']);
const WEB_VIDEO = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const TEXT_LABEL = { md: 'Note', markdown: 'Note', txt: 'Note', text: 'Note', docx: 'Word', doc: 'Word', odt: 'Document', hwp: 'HWP', hwpx: 'HWP', rtf: 'RTF', html: 'Web page', htm: 'Web page', srt: 'Subtitles', vtt: 'Subtitles', fountain: 'Screenplay', epub: 'EPUB' };

function kindLabel(it) {
  switch (it.kind) {
    case 'image': return it.ext.toUpperCase() || 'Image';
    case 'video': return 'Video';
    case 'audio': return 'Audio';
    case 'text': return TEXT_LABEL[it.ext] || 'Text';
    case 'pdf': return it.ext === 'ai' ? 'Illustrator' : 'PDF';
    case 'link': return it.meta?.provider || it.meta?.site || 'Link';
    case 'font': return 'Font';
    default: return it.ext ? it.ext.toUpperCase() : 'File';
  }
}

// ---------- a small, safe markdown renderer (escape first, then format) ----------

const safeUrl = (u) => /^(https?:|mailto:)/i.test(u);
function inline(s) {
  const codes = [];
  let out = esc(s).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (safeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>` : text));
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (m, a, b) => `<strong>${a ?? b}</strong>`);
  out = out.replace(/(^|[^*\w])\*([^*\s](?:[^*]*[^*\s])?)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out.replace(/\u0000(\d+)\u0000/g, (m, i) => `<code>${codes[i]}</code>`);
}
function markdown(src) {
  let html = '';
  let para = [];
  let list = null;
  let code = null;
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list) html += `<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`;
    list = null;
  };
  const block = () => (flushPara(), flushList());
  for (const line of String(src ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      if (code) {
        html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
        code = null;
      } else {
        block();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    let m;
    if (!line.trim()) block();
    else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      block();
      html += `<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`;
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      block();
      html += '<hr>';
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      block();
      html += `<blockquote>${inline(m[1])}</blockquote>`;
    } else if ((m = line.match(/^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
      flushPara();
      if (list?.type !== 'ul') (flushList(), (list = { type: 'ul', items: [] }));
      list.items.push((m[1] ? (m[1] === ' ' ? '☐ ' : '☑ ') : '') + m[2]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (list?.type !== 'ol') (flushList(), (list = { type: 'ol', items: [] }));
      list.items.push(m[1]);
    } else {
      flushList();
      para.push(line);
    }
  }
  if (code) html += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
  block();
  return html;
}
const plainHtml = (text) =>
  String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

// ---------- API ----------

async function api(path, opts = {}) {
  const headers = { ...(opts.json ? { 'Content-Type': 'application/json' } : {}), ...opts.headers };
  const res = await fetch(path, { ...opts, headers, body: opts.json ? JSON.stringify(opts.json) : opts.body });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `${res.status} ${res.statusText}`);
  return data;
}

// ---------- state ----------

const KINDS = [
  ['', 'All'],
  ['image', 'Images'],
  ['video', 'Video'],
  ['text', 'Text'],
  ['pdf', 'PDF'],
  ['link', 'Links'],
  ['audio,font,design,file', 'Other'],
];
const PAGE = 60;

const state = {
  q: '',
  tags: [],
  folder: '',
  kind: '',
  sort: '',
  seed: Math.floor(Math.random() * 1e9),
  items: [],
  total: 0,
  done: false,
  loading: null,
  status: null,
  folders: [],
  openId: null,
  pushedDetail: false,
  editing: false,
};

const grid = $('#grid');
const detail = $('#detail');
const fileInput = $('#file-input');
let addText; // the add-block textarea
let addCellEl; // created once, so a half-written note survives filter changes

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get('q') || '';
  state.tags = p.getAll('tag');
  state.folder = p.get('folder') || '';
  state.kind = p.get('kind') || '';
  state.sort = p.get('sort') || '';
  $('#q').value = state.q;
  $('#sort').value = state.sort;
  return Number(p.get('item')) || null;
}

function urlFor({ item = state.openId, ...over } = {}) {
  const s = { ...state, ...over };
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  for (const t of s.tags) p.append('tag', t);
  if (s.folder) p.set('folder', s.folder);
  if (s.kind) p.set('kind', s.kind);
  if (s.sort) p.set('sort', s.sort);
  if (item) p.set('item', item);
  const qs = p.toString();
  return qs ? `?${qs}` : location.pathname;
}

// ---------- loading the grid ----------

function matchesView(it) {
  if (state.q || state.tags.length) return false;
  if (state.folder && it.folder !== state.folder && !it.folder.startsWith(`${state.folder}/`)) return false;
  if (state.kind && !state.kind.split(',').includes(it.kind)) return false;
  return true;
}

async function load({ reset = false } = {}) {
  if (reset) {
    state.loading?.abort();
    state.loading = null;
    state.items = [];
    state.total = 0;
    state.done = false;
    addCellEl ||= addCell();
    $('.head', addCellEl).textContent = `+ Add block${state.folder ? ` to ${state.folder.split('/').pop()}` : ''}`;
    grid.replaceChildren(addCellEl);
    renderHeading();
  }
  if (state.loading || state.done) return;
  const ctrl = new AbortController();
  state.loading = ctrl;
  const p = new URLSearchParams({ q: state.q, folder: state.folder, kind: state.kind, sort: state.sort, seed: state.seed, offset: state.items.length, limit: PAGE });
  for (const t of state.tags) p.append('tag', t);
  try {
    const data = await api(`/api/items?${p}`, { signal: ctrl.signal });
    if (state.loading !== ctrl) return;
    state.total = data.total;
    for (const it of data.items) {
      if (state.items.some((x) => x.id === it.id)) continue;
      state.items.push(it);
      grid.append(block(it));
    }
    state.done = data.items.length < PAGE;
    renderHeading();
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, { error: true });
  } finally {
    if (state.loading === ctrl) state.loading = null;
  }
  // Keep filling while the sentinel is still on screen.
  if (!state.done && $('#sentinel').getBoundingClientRect().top < innerHeight + 800) load();
}

new IntersectionObserver((entries) => entries[0].isIntersecting && load(), { rootMargin: '800px' }).observe($('#sentinel'));

function applyFilters(over, { resetSeed = false } = {}) {
  Object.assign(state, over);
  if (resetSeed) state.seed = Math.floor(Math.random() * 1e9);
  history.replaceState(null, '', urlFor({ item: null }));
  renderFilters();
  load({ reset: true });
  loadTags();
}

// ---------- blocks ----------

const PLAY = '<svg viewBox="0 0 10 10"><path d="M2 1l7 4-7 4z"/></svg>';

function media(it) {
  const w = it.width;
  const hgt = it.height;
  const ar = w && hgt ? w / hgt : 1;
  const doc = ['pdf', 'design', 'link'].includes(it.kind) ? ' doc' : '';
  const frame = h('div', { class: `frame ${ar >= 1 ? 'land' : 'port'}${doc}` });
  const box = h('span', { class: 'media', style: `--ar:${ar};${it.color ? `--tint:${it.color}40` : ''}` });
  const img = h('img', { src: it.thumb, alt: it.title, loading: 'lazy', decoding: 'async', draggable: 'false' });
  img.addEventListener('load', () => {
    img.classList.add('loaded');
    box.classList.add('loaded-bg');
    if (!w || !hgt) {
      const r = img.naturalWidth / img.naturalHeight || 1;
      box.style.setProperty('--ar', r);
      frame.className = `frame ${r >= 1 ? 'land' : 'port'}${doc}`;
    }
  });
  box.append(img);
  const badge = (html, text) => box.append(h('span', { class: 'badge', html: html ? `${html}${esc(text)}` : esc(text) }));
  if (it.kind === 'video') badge(PLAY, it.duration ? clock(it.duration) : '');
  else if (it.kind === 'audio') badge('♪ ', it.duration ? clock(it.duration) : '');
  else if (it.kind === 'pdf') badge('', it.pages ? `${kindLabel(it)} · ${it.pages} ${it.pages === 1 ? 'page' : 'pages'}` : kindLabel(it));
  else if (it.kind === 'link') badge('', it.meta?.site || 'link');
  else if (it.ext === 'gif') badge('', 'GIF');
  frame.append(box);
  return frame;
}

const loadedFonts = new Set();
const fontObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    fontObserver.unobserve(e.target);
    loadFont(e.target.dataset.fontId, e.target.dataset.fontUrl);
  }
});
function loadFont(id, url) {
  if (loadedFonts.has(id)) return;
  loadedFonts.add(id);
  new FontFace(`archive-font-${id}`, `url("${url}")`)
    .load()
    .then((f) => document.fonts.add(f))
    .catch(() => {});
}

function frameFor(it) {
  if (it.thumb) return media(it);
  const frame = h('div', { class: 'frame' });
  if (it.kind === 'font') {
    const el = h('div', { class: 'file-block font', 'data-font-id': it.id, 'data-font-url': it.file },
      h('span', { style: `font-family: "archive-font-${it.id}", var(--serif)` }, 'Aa'),
      h('span', { class: 'sample' }, it.meta?.family || it.title));
    fontObserver.observe(el);
    frame.append(el);
  } else if (it.kind === 'link') {
    frame.append(h('div', { class: 'text-block link-text' }, h('strong', {}, it.title), h('div', { class: 'site' }, it.meta?.site || it.url || ''), it.excerpt ? h('div', { html: plainHtml(it.excerpt) }) : null));
  } else if (it.excerpt) {
    const html = MARKDOWN.has(it.ext) ? markdown(it.excerpt) : plainHtml(it.excerpt);
    const label = it.kind === 'text' && !['md', 'markdown', 'txt', 'text'].includes(it.ext) ? kindLabel(it) : it.kind === 'pdf' ? kindLabel(it) : '';
    frame.append(h('div', { class: 'text-block', html }, label ? h('span', { class: 'kind-label' }, label) : null));
  } else {
    frame.append(h('div', { class: 'file-block' }, h('span', { class: 'ext' }, it.ext ? `.${it.ext.toUpperCase()}` : 'FILE'), h('span', { class: 'name' }, it.name)));
  }
  return frame;
}

function caption(it) {
  const pending = state.status?.tagging?.enabled && (it.tagStatus === 'pending' || it.tagStatus === 'tagging');
  return h('div', { class: 'caption' },
    h('div', { class: 't' }, pending ? h('span', { class: 'tagging-dot', title: 'Claude is tagging this' }) : null, it.title),
    h('div', { class: 's' }, `${kindLabel(it)} · ${shortDate(it.addedAt)}`));
}

function block(it) {
  const a = h('a', { class: 'block', href: urlFor({ item: it.id }), 'data-id': it.id }, frameFor(it), caption(it));
  a._item = it;
  a.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    openDetail(it.id, { push: true });
  });
  return a;
}

function updateBlock(it) {
  const i = state.items.findIndex((x) => x.id === it.id);
  if (i < 0) return false;
  const old = state.items[i];
  state.items[i] = it;
  const el = grid.querySelector(`.block[data-id="${it.id}"]`);
  if (!el) return true;
  const sameLook = old.thumb === it.thumb && old.excerpt === it.excerpt && old.kind === it.kind && old.title === it.title;
  if (sameLook) {
    el._item = it;
    el.querySelector('.caption').replaceWith(caption(it));
  } else {
    el.replaceWith(block(it));
  }
  return true;
}

function insertBlock(it) {
  if (updateBlock(it) || !matchesView(it) || state.sort) return;
  state.items.unshift(it);
  state.total++;
  grid.querySelector('.add-cell')?.after(block(it));
  $('#empty').hidden = true;
  renderHeading();
  loadFoldersSoon();
}

function removeBlock(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i >= 0) {
    state.items.splice(i, 1);
    state.total = Math.max(0, state.total - 1);
  }
  grid.querySelector(`.block[data-id="${id}"]`)?.remove();
  renderHeading();
  loadFoldersSoon();
}

// ---------- the "add block" cell ----------

function addCell() {
  addText = h('textarea', { placeholder: 'Write a note or paste a link…', 'aria-label': 'New note or link' });
  const addBtn = h('button', { class: 'btn small', type: 'button', disabled: true }, 'Add');
  addText.addEventListener('input', () => (addBtn.disabled = !addText.value.trim()));
  addText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submitText(addText.value);
    }
  });
  addText.addEventListener('paste', (e) => {
    const files = pastedFiles(e);
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });
  addBtn.addEventListener('click', () => submitText(addText.value));
  return h('div', { class: 'block add-cell' },
    h('div', { class: 'frame' },
      h('div', { class: 'head' }, '+ Add block'),
      addText,
      h('div', { class: 'row' }, h('button', { class: 'linkish', type: 'button', onclick: () => fileInput.click() }, 'or choose files'), addBtn)),
    h('div', { class: 'caption' }, h('div', { class: 's' }, 'Drop or paste files anywhere')));
}

const isUrl = (s) => /^(https?:\/\/|www\.)\S+$/i.test(s);

async function submitText(text) {
  const value = text.trim();
  if (!value) return;
  const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
  try {
    if (lines.every(isUrl)) {
      for (const url of lines) {
        const t = toast(`Adding ${url}`);
        const r = await api('/api/link', { method: 'POST', json: { url, folder: state.folder } });
        t.done(r.duplicate ? 'Already in your archive' : `Added “${r.item.title}”`);
        insertBlock(r.item);
      }
    } else {
      const r = await api('/api/memo', { method: 'POST', json: { text, folder: state.folder } });
      insertBlock(r.item);
    }
    addText.value = '';
    addText.dispatchEvent(new Event('input'));
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ---------- uploads ----------

function pastedFiles(e) {
  const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
  return [...(e.clipboardData?.files || [])].map((f, i) =>
    /^image\.\w+$/i.test(f.name) ? new File([f], `Pasted image ${stamp}${i ? ` ${i + 1}` : ''}.${f.name.split('.').pop()}`, { type: f.type }) : f,
  );
}

const uploadQueue = [];
let uploading = 0;
function uploadFiles(files) {
  const folder = state.folder;
  for (const file of files) uploadQueue.push({ file, folder });
  pumpUploads();
}
function pumpUploads() {
  while (uploading < 3 && uploadQueue.length) {
    const job = uploadQueue.shift();
    uploading++;
    uploadOne(job).finally(() => {
      uploading--;
      pumpUploads();
    });
  }
}
function uploadOne({ file, folder }) {
  const t = toast(`Uploading ${file.name}`, { progress: true });
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(file.name)}&folder=${encodeURIComponent(folder)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && t.progress(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data?.item) {
        t.done(data.duplicate ? `Already in your archive: ${file.name}` : `Added ${file.name}`);
        insertBlock(data.item);
      } else {
        t.fail(`${file.name}: ${data?.error || xhr.statusText || 'upload failed'}`);
      }
      resolve();
    };
    xhr.onerror = () => {
      t.fail(`${file.name}: upload failed`);
      resolve();
    };
    xhr.send(file);
  });
}

fileInput.addEventListener('change', () => {
  uploadFiles([...fileInput.files]);
  fileInput.value = '';
});
$('#add-btn').addEventListener('click', () => fileInput.click());

let dragDepth = 0;
const dragHasContent = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list');
window.addEventListener('dragenter', (e) => {
  if (!dragHasContent(e)) return;
  dragDepth++;
  $('#dropzone-label').textContent = `Drop to add to ${state.folder ? state.folder.split('/').pop() : $('#brand-title').textContent}`;
  $('#dropzone').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $('#dropzone').hidden = true;
  }
});
window.addEventListener('dragover', (e) => dragHasContent(e) && e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!dragHasContent(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#dropzone').hidden = true;
  const files = [...e.dataTransfer.files];
  if (files.length) return uploadFiles(files);
  const url = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find((l) => l && !l.startsWith('#'));
  if (url) submitText(url);
});

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
document.addEventListener('paste', (e) => {
  if (typing(document.activeElement) || state.openId) return;
  const files = pastedFiles(e);
  if (files.length) {
    e.preventDefault();
    return uploadFiles(files);
  }
  const text = e.clipboardData.getData('text');
  if (text && addText) {
    e.preventDefault();
    addText.value = text;
    addText.dispatchEvent(new Event('input'));
    addText.focus();
    addText.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
});

// ---------- toasts ----------

function toast(message, { error = false, progress = false } = {}) {
  const bar = progress ? h('div', { class: 'bar' }, h('i')) : null;
  const text = h('div', {}, message);
  const el = h('div', { class: `toast${error ? ' error' : ''}` }, text, bar);
  $('#toasts').append(el);
  const close = (ms) => setTimeout(() => el.remove(), ms);
  if (!progress) close(error ? 6000 : 3000);
  return {
    progress: (f) => bar && (bar.firstChild.style.width = `${Math.round(f * 100)}%`),
    done: (msg) => {
      text.textContent = msg;
      bar?.remove();
      close(2500);
    },
    fail: (msg) => {
      text.textContent = msg;
      el.classList.add('error');
      bar?.remove();
      close(7000);
    },
  };
}

// ---------- header, folders, filters, tags ----------

function renderHeading() {
  const title = state.status?.title || 'Archive';
  const folderName = state.folder.split('/').pop();
  let heading = state.q ? `“${state.q}”` : state.folder ? folderName : title;
  if (!state.q && !state.folder && state.tags.length === 1) heading = `#${state.tags[0]}`;
  $('#heading').textContent = heading;
  const bits = [`${state.total.toLocaleString()} ${state.total === 1 ? 'block' : 'blocks'}`];
  if (state.folder && state.folder.includes('/')) bits.push(`in ${state.folder.split('/').slice(0, -1).join(' / ')}`);
  if (state.q && state.folder) bits.push(`in ${folderName}`);
  $('#subheading').textContent = bits.join(' · ');
  document.title = state.q ? `${state.q} – ${title}` : state.folder ? `${folderName} – ${title}` : title;
  $('#empty').hidden = !(state.done && !state.items.length);
  $('#empty').textContent = state.q || state.tags.length ? 'Nothing found. Try fewer words, or a word in another language.' : 'Nothing here yet. Drop some files, paste a link or write a note.';
}

function renderFilters() {
  const kinds = $('#kinds');
  kinds.replaceChildren(
    ...KINDS.map(([key, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(state.kind === key), onclick: () => applyFilters({ kind: key }) }, label),
    ),
  );
  $('#sort').value = state.sort;
  const active = $('#active-filters');
  const chips = state.tags.map((t) =>
    h('button', { class: 'chip on', type: 'button', title: 'Remove filter', onclick: () => applyFilters({ tags: state.tags.filter((x) => x !== t) }) }, `#${t}`, h('span', { class: 'x' }, '×')),
  );
  if (state.q || state.tags.length || state.kind || state.folder) {
    chips.push(h('button', { class: 'linkish', type: 'button', onclick: () => { $('#q').value = ''; applyFilters({ q: '', tags: [], kind: '', folder: '' }); } }, 'Clear all'));
  }
  active.replaceChildren(...chips);
  renderFolders();
}

function renderFolders() {
  const nav = $('#folders');
  const total = state.folders.reduce((n, f) => (f.folder.includes('/') ? n : n + f.count), 0);
  const link = (folder, label, count) =>
    h('a', {
      href: urlFor({ folder, item: null }),
      class: state.folder === folder ? 'active' : '',
      onclick: (e) => {
        e.preventDefault();
        applyFilters({ folder });
      },
    }, label, count != null ? h('span', { class: 'count' }, count) : null);
  nav.replaceChildren(
    link('', 'All', state.status ? state.status.counts.total : total || null),
    ...state.folders.map((f) => link(f.folder, f.folder.split('/').join(' / '), f.count)),
    h('button', { class: 'new', type: 'button', onclick: newFolder }, '+ New folder'),
  );
}

async function newFolder() {
  const name = prompt('New folder name (use / for a subfolder, e.g. Posters/Swiss)');
  if (!name?.trim()) return;
  try {
    const { folder } = await api('/api/folders', { method: 'POST', json: { name } });
    await loadFolders();
    applyFilters({ folder });
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function loadFolders() {
  clearTimeout(folderTimer);
  try {
    state.folders = await api('/api/folders');
    renderFolders();
  } catch {}
}
let folderTimer;
const loadFoldersSoon = () => {
  clearTimeout(folderTimer);
  folderTimer = setTimeout(loadFolders, 1500);
};

let tagTimer;
async function loadTags() {
  clearTimeout(tagTimer);
  const p = new URLSearchParams({ q: state.q, folder: state.folder, kind: state.kind, limit: 40 });
  for (const t of state.tags) p.append('tag', t);
  try {
    const tags = await api(`/api/tags?${p}`);
    $('#tag-strip').replaceChildren(
      ...tags
        .filter((t) => !state.tags.includes(t.tag))
        .map((t) => h('a', {
          class: 'chip',
          href: urlFor({ tags: [...state.tags, t.tag], item: null }),
          onclick: (e) => {
            e.preventDefault();
            applyFilters({ tags: [...state.tags, t.tag] });
          },
        }, t.tag, h('span', { class: 'n' }, t.n))),
    );
  } catch {}
}
const loadTagsSoon = () => {
  clearTimeout(tagTimer);
  tagTimer = setTimeout(loadTags, 2500);
};

let searchTimer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => applyFilters({ q: e.target.value.trim() }), 220);
});
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    applyFilters({ q: e.target.value.trim() });
  } else if (e.key === 'Escape') {
    e.target.blur();
  }
});
$('#sort').addEventListener('change', (e) => applyFilters({ sort: e.target.value }, { resetSeed: true }));
$('#brand').addEventListener('click', (e) => {
  e.preventDefault();
  $('#q').value = '';
  applyFilters({ q: '', tags: [], folder: '', kind: '', sort: '' });
});

// ---------- status & tagging banner ----------

let bannerDismissed = false;
function renderStatus(s) {
  const first = !state.status;
  state.status = s;
  $('#brand-title').textContent = s.title;
  const t = s.tagging;
  const btn = $('#status');
  let cls = '';
  let label = '';
  let action = null;
  if (s.scan.scanning && s.scan.seen) {
    cls = 'busy';
    label = `Indexing ${s.scan.indexed.toLocaleString()} / ${s.scan.seen.toLocaleString()}`;
  } else if (t.autoTag && !t.configured) {
    cls = 'warn';
    label = 'Auto-tags off';
    action = () => { bannerDismissed = false; renderBanner(); };
  } else if (t.enabled && t.paused) {
    cls = 'warn';
    label = 'Tagging paused';
    action = () => post('resume');
  } else if (t.enabled && t.needsApproval) {
    cls = 'warn';
    label = `${t.queued.toLocaleString()} waiting for tags`;
    action = () => { bannerDismissed = false; renderBanner(); };
  } else if (t.enabled && (t.active || t.queued)) {
    cls = 'busy';
    label = `Tagging ${(t.active + t.queued).toLocaleString()}…`;
  } else if (t.enabled && s.counts.error) {
    label = `${s.counts.error} couldn’t be tagged · retry`;
    action = () => post('retry-failed');
  }
  btn.hidden = !label;
  btn.className = `status ${cls}`;
  btn.replaceChildren(h('span', { class: 'dot' }), h('span', { class: 'label' }, label));
  btn.onclick = action;
  btn.title = label;
  renderBanner();
  if (first) {
    renderHeading();
    for (const el of grid.querySelectorAll('.block[data-id]')) el.querySelector('.caption').replaceWith(caption(el._item));
  }
  renderFolders();
}

async function post(action) {
  try {
    renderStatus(await api('/api/tagging', { method: 'POST', json: { action } }));
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderBanner() {
  const banner = $('#banner');
  const t = state.status?.tagging;
  let content = null;
  if (!t || bannerDismissed) content = null;
  else if (t.enabled && t.paused && t.lastError) {
    content = [h('p', {}, t.lastError), h('div', { class: 'actions' }, h('button', { class: 'btn small', type: 'button', onclick: () => post('resume') }, 'Resume tagging'))];
  } else if (t.enabled && t.needsApproval) {
    const cost = t.estimate != null ? ` (roughly ${money(t.estimate)} with ${t.model})` : '';
    content = [
      h('p', {}, `${t.queued.toLocaleString()} blocks are waiting for Claude’s auto-tags${cost}. Tag them all now?`),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => post('start') }, 'Tag them all'),
        h('button', { class: 'btn small ghost', type: 'button', onclick: () => { bannerDismissed = true; renderBanner(); } }, 'Not now')),
    ];
  } else if (t.autoTag && !t.configured) {
    content = [
      h('p', { html: 'Auto-tagging is off. Add your Anthropic API key to <code>archive/.env</code> as <code>ANTHROPIC_API_KEY=…</code> and restart the server. Search still works on file names and text.' }),
      h('div', { class: 'actions' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { bannerDismissed = true; renderBanner(); } }, 'Dismiss')),
    ];
  }
  banner.hidden = !content;
  if (content) banner.replaceChildren(...content);
}

// ---------- detail view ----------

async function openDetail(id, { push = false } = {}) {
  if (state.editing && state.openId !== id && !confirm('Discard your unsaved changes?')) return;
  state.editing = false;
  if (push && !state.openId) {
    history.pushState({ item: id }, '', urlFor({ item: id }));
    state.pushedDetail = true;
  } else {
    history.replaceState(history.state, '', urlFor({ item: id }));
  }
  state.openId = id;
  document.body.style.overflow = 'hidden';
  detail.hidden = false;
  const known = state.items.find((x) => x.id === id);
  if (known) renderDetail(known);
  try {
    const it = await api(`/api/items/${id}`);
    if (state.openId === id) renderDetail(it);
  } catch (err) {
    toast(err.message, { error: true });
    closeDetail();
  }
}

/**
 * `fromHistory`: the back button already changed the URL.
 * `replace`: we're about to navigate elsewhere, so rewrite the URL instead of going back
 * (history.back() is async and would undo that navigation).
 */
function closeDetail({ fromHistory = false, replace = false } = {}) {
  if (!state.openId) return;
  if (state.editing && !confirm('Discard your unsaved changes?')) return;
  state.editing = false;
  state.openId = null;
  detail.hidden = true;
  detail.replaceChildren();
  document.body.style.overflow = '';
  if (!fromHistory) {
    if (state.pushedDetail && !replace) history.back();
    else history.replaceState(null, '', urlFor({ item: null }));
  }
  state.pushedDetail = false;
}

async function step(dir) {
  const i = state.items.findIndex((x) => x.id === state.openId);
  if (i < 0) return;
  if (dir > 0 && i + 1 >= state.items.length && !state.done) await load();
  const next = state.items[i + dir];
  if (next) openDetail(next.id);
}

function stageFor(it) {
  const src = it.preview || it.file;
  switch (it.kind) {
    case 'image':
      return h('img', { src, alt: it.title });
    case 'video':
      if (WEB_VIDEO.has(it.ext)) return h('video', { src: it.file, poster: it.thumb, controls: true, playsinline: true, preload: 'metadata' });
      return it.preview ? h('img', { src: it.preview, alt: `${it.title} (frames)` }) : fileBig(it, 'This video format can’t play in the browser.');
    case 'audio':
      return h('div', { class: 'audio-wrap' }, it.thumb ? h('img', { src: it.preview || it.thumb, alt: '' }) : null, h('audio', { src: it.file, controls: true, preload: 'metadata' }));
    case 'pdf':
      return h('iframe', { class: 'pdf', src: it.file, title: it.title });
    case 'text':
      if (it.text == null) return h('div', { class: 'reader muted' }, 'Loading…');
      if (!it.text.trim()) return fileBig(it, 'No readable text in this file.');
      return MARKDOWN.has(it.ext) ? h('div', { class: 'reader', html: markdown(it.text) }) : h('div', { class: 'reader plain' }, it.text);
    case 'link': {
      const card = h('div', { class: 'link-card' },
        it.meta?.embed ? null : it.thumb ? h('img', { src: it.preview || it.thumb, alt: '' }) : null,
        h('h2', {}, it.title),
        it.excerpt ? h('p', {}, it.excerpt) : null,
        h('a', { class: 'btn', href: it.url, target: '_blank', rel: 'noopener noreferrer' }, `Open ${it.meta?.site || 'link'} ↗`));
      if (!it.meta?.embed) return card;
      return h('div', { class: 'link-card' },
        h('iframe', { class: 'embed', src: it.meta.embed, title: it.title, allow: 'autoplay; encrypted-media; picture-in-picture; fullscreen', allowfullscreen: true }),
        ...card.children);
    }
    case 'font': {
      loadFont(it.id, it.file);
      const face = `font-family: "archive-font-${it.id}", var(--serif)`;
      return h('div', { class: 'specimen' },
        h('div', { class: 'xl', style: face, contenteditable: 'true', spellcheck: 'false' }, 'Aa Gg 가나'),
        h('div', { class: 'l', style: face, contenteditable: 'true', spellcheck: 'false' }, 'The quick brown fox jumps over the lazy dog'),
        h('div', { class: 'm', style: face, contenteditable: 'true', spellcheck: 'false' }, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&@ — click to type your own text.'));
    }
    default:
      return it.thumb ? h('img', { src: it.preview || it.thumb, alt: it.title }) : fileBig(it);
  }
}

function fileBig(it, note) {
  return h('div', { class: 'file-big' },
    h('span', { class: 'ext' }, it.ext ? `.${it.ext.toUpperCase()}` : 'FILE'),
    h('span', { class: 'muted' }, note || it.name),
    h('a', { class: 'btn', href: `${it.file}?download=1` }, 'Download'));
}

function tagState(it) {
  const t = state.status?.tagging;
  if (it.tagStatus === 'error') {
    return h('p', { class: 'tag-state error' }, `Couldn’t tag: ${it.tagError || 'unknown error'} `, h('button', { class: 'linkish', type: 'button', onclick: () => retag(it.id) }, 'Try again'));
  }
  if (it.tagStatus === 'tagging') return h('p', { class: 'tag-state' }, h('span', { class: 'tagging-dot' }), 'Claude is tagging this…');
  if (it.tagStatus === 'pending') {
    if (!t?.enabled) return h('p', { class: 'tag-state' }, 'Auto-tagging is off.');
    return h('p', { class: 'tag-state' }, h('span', { class: 'tagging-dot' }), t.needsApproval ? 'Waiting — tagging needs your OK (see the banner).' : 'Waiting for Claude…');
  }
  return it.tagModel ? h('p', { class: 'tag-state' }, `Auto-tagged by Claude ${it.taggedAt ? ago(it.taggedAt) : ''}. Dashed tags are yours.`) : null;
}

function renderDetail(it) {
  if (state.editing) return;
  const i = state.items.findIndex((x) => x.id === it.id);
  const stage = h('div', { class: 'stage' }, stageFor(it),
    i > 0 ? h('button', { class: 'nav prev', type: 'button', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹') : null,
    i >= 0 && (i < state.items.length - 1 || !state.done) ? h('button', { class: 'nav next', type: 'button', 'aria-label': 'Next', onclick: () => step(1) }, '›') : null);

  const tagInput = h('input', { class: 'tag-input', placeholder: '+ tag', 'aria-label': 'Add a tag', enterkeyhint: 'done' });
  tagInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !tagInput.value.trim()) return;
    e.preventDefault();
    const tags = tagInput.value.split(',').map((s) => s.trim()).filter(Boolean);
    await patch(it.id, { addTags: tags });
    $('.tag-input', detail)?.focus();
  });
  const userTags = new Set(it.userTags || []);
  const tagChips = (it.tags || []).map((t) =>
    h('span', { class: `chip${userTags.has(t) ? ' user' : ''}` },
      h('a', {
        href: urlFor({ tags: [t], q: '', folder: '', kind: '', item: null }),
        style: 'text-decoration:none',
        onclick: (e) => {
          e.preventDefault();
          closeDetail({ replace: true });
          $('#q').value = '';
          applyFilters({ tags: [t], q: '', folder: '', kind: '' });
        },
      }, t),
      h('button', { class: 'x', type: 'button', title: `Remove “${t}”`, onclick: () => patch(it.id, { removeTags: [t] }) }, '×')));

  const info = [];
  const row = (k, v) => v != null && v !== '' && info.push(h('dt', {}, k), h('dd', {}, v));
  row('Type', `${kindLabel(it)}${it.ext && it.kind !== 'link' ? ` (.${it.ext})` : ''}`);
  if (it.kind !== 'link') row('Size', bytes(it.size));
  if (it.width && it.height && ['image', 'video', 'design'].includes(it.kind)) row('Dimensions', `${it.width} × ${it.height}`);
  if (it.duration) row('Length', clock(it.duration));
  if (it.pages) row('Pages', it.pages);
  if (it.url) row('Link', h('a', { href: it.url, target: '_blank', rel: 'noopener noreferrer' }, it.url));
  row('File', it.path);
  row('Modified', new Date(it.modifiedAt).toLocaleString());

  const actions = [
    h('a', { class: 'btn ghost small', href: it.file, target: '_blank', rel: 'noopener' }, 'Open original ↗'),
    h('a', { class: 'btn ghost small', href: `${it.file}?download=1` }, 'Download'),
    // Only once the full text has loaded, so saving can never overwrite a note with a partial copy.
    it.editable && typeof it.text === 'string' ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => startEdit(it) }, 'Edit') : null,
    state.status?.tagging?.enabled ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => retag(it.id) }, 'Re-tag') : null,
    h('button', { class: 'btn danger small', type: 'button', onclick: () => trash(it) }, 'Delete'),
  ];

  const related = h('div', { class: 'related' });
  const aside = h('aside', {},
    h('div', {},
      h('h2', {}, it.title),
      h('p', { class: 'when' }, `Added ${ago(it.addedAt)} · `,
        h('a', {
          href: urlFor({ folder: it.folder, item: null }),
          onclick: (e) => {
            e.preventDefault();
            closeDetail({ replace: true });
            applyFilters({ folder: it.folder });
          },
        }, it.folder || 'Top level'))),
    it.summary ? h('p', { class: 'summary' }, it.summary) : null,
    h('section', {}, h('p', { class: 'label' }, 'Tags'), h('div', { class: 'tags' }, ...tagChips, tagInput), tagState(it)),
    h('section', {}, h('p', { class: 'label' }, 'Info'), h('dl', {}, ...info)),
    h('div', { class: 'actions' }, ...actions),
    h('section', { hidden: true }, h('p', { class: 'label' }, 'Related'), related));

  detail.replaceChildren(h('button', { class: 'close', type: 'button', 'aria-label': 'Close', onclick: () => closeDetail() }, '×'), stage, aside);
  loadRelated(it.id, related);
}

async function loadRelated(id, el) {
  try {
    const items = await api(`/api/items/${id}/related`);
    if (state.openId !== id || !items.length) return;
    el.replaceChildren(
      ...items.map((r) =>
        h('a', { href: urlFor({ item: r.id }), title: r.title, onclick: (e) => { e.preventDefault(); openDetail(r.id); } },
          r.thumb ? h('img', { src: r.thumb, alt: r.title, loading: 'lazy' }) : r.title)),
    );
    el.parentElement.hidden = false;
  } catch {}
}

async function patch(id, body) {
  try {
    const it = await api(`/api/items/${id}`, { method: 'PATCH', json: body });
    updateBlock(it);
    if (state.openId === id) renderDetail(it);
    loadTagsSoon();
    return it;
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function retag(id) {
  try {
    await api(`/api/items/${id}/retag`, { method: 'POST' });
    toast('Asking Claude for fresh tags…');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

async function trash(it) {
  if (!confirm(`Delete “${it.title}”?\n\nThe file moves to the .trash folder inside your library, so you can still get it back.`)) return;
  try {
    await api(`/api/items/${it.id}`, { method: 'DELETE' });
    removeBlock(it.id);
    closeDetail();
    toast('Moved to .trash');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function startEdit(it) {
  state.editing = true;
  const area = h('textarea', { spellcheck: 'true' });
  area.value = it.text ?? '';
  const save = async () => {
    state.editing = false;
    const updated = await patch(it.id, { text: area.value });
    if (!updated) state.editing = true;
  };
  const cancel = () => {
    state.editing = false;
    renderDetail(it);
  };
  area.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  });
  const stage = $('.stage', detail);
  stage.replaceChildren(h('div', { class: 'editor' }, area,
    h('div', { class: 'row' }, h('span', { class: 'muted' }, '⌘/Ctrl + Enter to save'),
      h('button', { class: 'btn ghost small', type: 'button', onclick: cancel }, 'Cancel'),
      h('button', { class: 'btn small', type: 'button', onclick: save }, 'Save'))));
  area.focus();
}

detail.addEventListener('click', (e) => {
  if (e.target === detail || e.target.classList.contains('stage')) closeDetail();
});

// Swipe left/right between blocks on touch screens.
let touch = null;
detail.addEventListener('touchstart', (e) => {
  touch = e.touches.length === 1 && !typing(e.target) && !e.target.closest('video, audio, iframe, .editor') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
detail.addEventListener('touchend', (e) => {
  if (!touch || state.editing) return;
  const dx = e.changedTouches[0].clientX - touch.x;
  const dy = e.changedTouches[0].clientY - touch.y;
  touch = null;
  if (Math.abs(dx) > 70 && Math.abs(dy) < 50) step(dx < 0 ? 1 : -1);
}, { passive: true });

document.addEventListener('keydown', (e) => {
  if (state.openId) {
    if (e.key === 'Escape' && !state.editing && !typing(document.activeElement)) closeDetail();
    else if (!typing(document.activeElement) && e.key === 'ArrowLeft') step(-1);
    else if (!typing(document.activeElement) && e.key === 'ArrowRight') step(1);
    return;
  }
  if ((e.key === '/' && !typing(document.activeElement)) || (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  }
});

window.addEventListener('popstate', () => {
  const before = urlFor({ item: null });
  const item = readUrl();
  if (urlFor({ item: null }) !== before) {
    renderFilters();
    load({ reset: true });
    loadTags();
  }
  if (item) openDetail(item);
  else closeDetail({ fromHistory: true });
});

window.addEventListener('beforeunload', (e) => {
  if (state.editing) e.preventDefault();
});

// ---------- live updates ----------

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('item', (e) => {
    const { created, ...it } = JSON.parse(e.data);
    // New files show up at the top (unless it's the first big scan of an existing folder); updates refresh in place.
    if (created && (!state.status?.scan?.scanning || Date.now() - it.addedAt < 10 * 60_000)) insertBlock(it);
    else updateBlock(it);
    if (created) loadFoldersSoon(); // counts change even when the block isn't in the current view
    if (state.openId === it.id && !state.editing) {
      api(`/api/items/${it.id}`).then((full) => state.openId === it.id && renderDetail(full)).catch(() => {});
    }
    loadTagsSoon();
  });
  es.addEventListener('remove', (e) => {
    const { id } = JSON.parse(e.data);
    removeBlock(id);
    if (state.openId === id && !state.editing) closeDetail();
  });
  es.addEventListener('status', (e) => renderStatus(JSON.parse(e.data)));
  es.addEventListener('folders', loadFolders);
  es.addEventListener('open', () => api('/api/status').then(renderStatus).catch(() => {}));
}

// ---------- start ----------

const initialItem = readUrl();
renderFilters();
api('/api/status').then(renderStatus).catch(() => {});
loadFolders();
loadTags();
load({ reset: true });
if (initialItem) openDetail(initialItem);
connect();
