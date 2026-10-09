import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { poster } from './fixtures.js';
import { testApp, waitFor } from './helpers.js';

describe('HTTP API', () => {
  test('upload, search, tag, fetch and delete', async () => {
    const t = await testApp({ listen: true });
    const json = async (url, opts = {}) => {
      const res = await fetch(t.base + url, opts);
      return { status: res.status, body: await res.json() };
    };
    try {
      t.tagger.start();
      // Upload with a Korean file name (NFD, as macOS sends it) into a new folder.
      const name = '포스터 초안.jpg'.normalize('NFD');
      const up = await json(`/api/upload?name=${encodeURIComponent(name)}&folder=${encodeURIComponent('레퍼런스/포스터')}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await poster(),
      });
      assert.equal(up.status, 201);
      const item = up.body.item;
      assert.equal(item.name, '포스터 초안.jpg'); // stored as NFC
      assert.equal(item.folder, '레퍼런스/포스터');
      assert.ok(item.thumb);
      await fs.access(path.join(t.config.libraryDir, '레퍼런스', '포스터', '포스터 초안.jpg'));

      // Same bytes again: reported as a duplicate, not stored twice.
      const dup = await json('/api/upload?name=copy.jpg', { method: 'POST', body: await poster() });
      assert.equal(dup.status, 200);
      assert.equal(dup.body.duplicate, true);

      await t.idle();
      const memo = await json('/api/memo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Brutalist 영화관 facade', folder: '' }) });
      assert.equal(memo.status, 201);
      await t.idle();

      assert.equal((await json(`/api/items?q=${encodeURIComponent('초안')}`)).body.total, 1);
      assert.equal((await json(`/api/items?q=${encodeURIComponent('영화')}`)).body.total, 1);
      assert.equal((await json('/api/items?q=brutal')).body.total, 1);
      assert.equal((await json('/api/items?tag=poster')).body.total, 2);
      assert.equal((await json(`/api/items?folder=${encodeURIComponent('레퍼런스')}`)).body.total, 1);
      assert.deepEqual((await json('/api/folders')).body, [
        { folder: '레퍼런스', count: 1 },
        { folder: '레퍼런스/포스터', count: 1 },
      ]);

      // Edit tags
      const patched = await json(`/api/items/${item.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addTags: ['#Favourite'], removeTags: ['reference'] }),
      });
      assert.deepEqual(patched.body.userTags, ['favourite']);
      assert.deepEqual(patched.body.hiddenTags, ['reference']);
      assert.ok(!patched.body.tags.includes('reference'));

      // Describe it: saved as typed (trimmed), searchable, and clearable
      const describe = (description) =>
        json(`/api/items/${item.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ description }) });
      assert.equal((await describe('  Poster for the June screening ')).body.description, 'Poster for the June screening');
      assert.equal((await json(`/api/items?q=${encodeURIComponent('june screening')}`)).body.items[0].id, item.id);
      assert.equal((await describe('')).body.description, '');
      assert.equal((await json(`/api/items?q=${encodeURIComponent('june screening')}`)).body.total, 0);
      assert.equal((await json('/api/items?sort=alpha')).status, 200);

      // The original file, with byte ranges (video seeking)
      const res = await fetch(`${t.base}${item.file}`, { headers: { Range: 'bytes=0-9' } });
      assert.equal(res.status, 206);
      assert.equal((await res.arrayBuffer()).byteLength, 10);
      const thumb = await fetch(t.base + item.thumb);
      assert.equal(thumb.headers.get('content-type'), 'image/webp');

      // Delete → .trash
      assert.equal((await json(`/api/items/${item.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await json(`/api/items/${item.id}`)).status, 404);
      assert.equal((await fs.readdir(path.join(t.config.libraryDir, '.trash'))).length, 1);
    } finally {
      await t.close();
    }
  });

  test('rejects path tricks and bad input', async () => {
    const t = await testApp({ listen: true });
    try {
      const up = await fetch(`${t.base}/api/upload?name=x.txt&folder=${encodeURIComponent('../../etc')}`, { method: 'POST', body: 'x' });
      assert.equal(up.status, 400);
      assert.deepEqual(await fs.readdir(path.join(t.config.dataDir, 'tmp')), []);
      const sneaky = await fetch(`${t.base}/api/upload?name=${encodeURIComponent('../../evil.txt')}`, { method: 'POST', body: 'x' });
      assert.equal(sneaky.status, 201);
      assert.equal((await sneaky.json()).item.path, '-..-evil.txt'); // slashes replaced, leading dots dropped
      assert.equal((await fetch(`${t.base}/thumb/..%2F..%2Farchive.db`)).status, 404);
      assert.equal((await fetch(`${t.base}/thumb/../data/archive.db`)).status, 404);
      assert.equal((await fetch(`${t.base}/file/999`)).status, 404);
      const bad = await fetch(`${t.base}/api/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'javascript:alert(1)' }) });
      assert.equal(bad.status, 400);
      const empty = await fetch(`${t.base}/api/memo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"  "}' });
      assert.equal(empty.status, 400);
    } finally {
      await t.close();
    }
  });

  test('SVG files are served with a sandbox so scripts cannot run', async () => {
    const t = await testApp({ listen: true });
    try {
      const up = await fetch(`${t.base}/api/upload?name=evil.svg`, {
        method: 'POST',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>',
      });
      const { item } = await up.json();
      const res = await fetch(t.base + item.file);
      assert.match(res.headers.get('content-security-policy'), /sandbox/);
    } finally {
      await t.close();
    }
  });

  test('ARCHIVE_PASSWORD protects everything', async () => {
    const t = await testApp({ listen: true, config: { password: 'secret' } });
    try {
      assert.equal((await fetch(`${t.base}/`)).status, 401);
      assert.equal((await fetch(`${t.base}/api/items`)).status, 401);
      const wrong = { Authorization: `Basic ${Buffer.from('me:nope').toString('base64')}` };
      assert.equal((await fetch(`${t.base}/api/items`, { headers: wrong })).status, 401);
      const right = { Authorization: `Basic ${Buffer.from('me:secret').toString('base64')}` };
      assert.equal((await fetch(`${t.base}/api/items`, { headers: right })).status, 200);
    } finally {
      await t.close();
    }
  });

  test('live events announce new blocks', async () => {
    const t = await testApp({ listen: true });
    try {
      const res = await fetch(`${t.base}/api/events`);
      const reader = res.body.getReader();
      let text = '';
      const got = waitFor(async () => {
        const { value } = await reader.read();
        text += new TextDecoder().decode(value);
        return text.includes('event: item') && text.includes('"created":true');
      });
      await fetch(`${t.base}/api/memo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"hello"}' });
      await got;
      await reader.cancel();
    } finally {
      await t.close();
    }
  });
});
