import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fetchLinkMeta, normalizeUrl, parseLinkFile, youtubeId } from '../src/links.js';
import { poster } from './fixtures.js';
import { testApp } from './helpers.js';

describe('link files', () => {
  test('parse .url, .webloc (xml and binary), .desktop and Google Drive shortcuts', () => {
    assert.equal(parseLinkFile(Buffer.from('[InternetShortcut]\r\nURL=https://are.na/\r\n'), 'url'), 'https://are.na/');
    assert.equal(
      parseLinkFile(Buffer.from('<plist><dict><key>URL</key><string>https://a.com/?x=1&amp;y=2</string></dict></plist>'), 'webloc'),
      'https://a.com/?x=1&y=2',
    );
    assert.equal(parseLinkFile(Buffer.from('bplist00Ñ\u0001\u0002SURL_\u0010\u0013https://b.com/page\b'), 'webloc'), 'https://b.com/page');
    assert.equal(parseLinkFile(Buffer.from('[Desktop Entry]\nType=Link\nURL=https://c.com\n'), 'desktop'), 'https://c.com');
    assert.equal(parseLinkFile(Buffer.from('{"doc_id":"abc123"}'), 'gdoc'), 'https://drive.google.com/open?id=abc123');
  });

  test('normalizeUrl and youtubeId', () => {
    assert.equal(normalizeUrl('www.are.na/block/1'), 'https://www.are.na/block/1');
    assert.throws(() => normalizeUrl('javascript:alert(1)'));
    assert.throws(() => normalizeUrl('file:///etc/passwd'));
    assert.equal(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
    assert.equal(youtubeId('https://m.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
    assert.equal(youtubeId('https://vimeo.com/1'), null);
  });
});

describe('link previews', () => {
  let server;
  let base;
  let jpg;
  before(async () => {
    jpg = await poster(400, 300);
    server = http.createServer((req, res) => {
      if (req.url === '/article') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(`<html><head><title>Fallback</title>
          <meta property="og:title" content="Concrete &amp; Light">
          <meta name="description" content="A tour of brutalist buildings.">
          <meta property="og:image" content="/cover.jpg"><meta property="og:site_name" content="Arch Mag">
          </head><body><p>Body text about béton brut.</p><script>var x = 1;</script></body></html>`);
      } else if (req.url === '/korean') {
        res.setHeader('Content-Type', 'text/html');
        // EUC-KR page: <title>영화</title>
        res.end(Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"><title>'), Buffer.from([0xbf, 0xb5, 0xc8, 0xad]), Buffer.from('</title></head></html>')]));
      } else if (req.url === '/cover.jpg' || req.url === '/photo.jpg') {
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(jpg);
      } else {
        res.statusCode = 404;
        res.end('nope');
      }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('reads Open Graph tags, resolves relative images, extracts text', async () => {
    const meta = await fetchLinkMeta(`${base}/article`);
    assert.equal(meta.title, 'Concrete & Light');
    assert.equal(meta.description, 'A tour of brutalist buildings.');
    assert.equal(meta.site, 'Arch Mag');
    assert.equal(meta.image, `${base}/cover.jpg`);
    assert.match(meta.text, /béton brut/);
    assert.doesNotMatch(meta.text, /var x/);
  });

  test('decodes legacy charsets and reports errors instead of throwing', async () => {
    assert.equal((await fetchLinkMeta(`${base}/korean`)).title, '영화');
    assert.equal((await fetchLinkMeta(`${base}/missing`)).error, 'HTTP 404');
    assert.ok((await fetchLinkMeta('http://127.0.0.1:1/')).error);
  });

  test('adding a link saves a .url file with a preview; an image link saves the image', async () => {
    const t = await testApp();
    try {
      const { item } = await t.library.createLink(`${base}/article`, 'Links');
      assert.equal(item.kind, 'link');
      assert.equal(item.title, 'Concrete & Light');
      assert.equal(item.name, 'Concrete & Light.url');
      assert.ok(item.thumb);
      const file = await fs.readFile(path.join(t.config.libraryDir, 'Links', 'Concrete & Light.url'), 'utf8');
      assert.match(file, /URL=http:\/\/127\.0\.0\.1:\d+\/article/);
      const again = await t.library.createLink(`${base}/article`, '');
      assert.equal(again.duplicate, true);

      const img = await t.library.createLink(`${base}/photo.jpg`, '');
      assert.equal(img.item.kind, 'image');
      assert.equal(img.item.name, 'photo.jpg');
    } finally {
      await t.close();
    }
  });
});
