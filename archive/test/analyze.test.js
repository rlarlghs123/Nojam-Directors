import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import sharp from 'sharp';
import { analyze } from '../src/analyze.js';
import { kindOf } from '../src/kinds.js';
import { Thumbs } from '../src/thumbs.js';
import { extOf } from '../src/util.js';
import { makeFixtures } from './fixtures.js';
import { tempDir } from './helpers.js';

describe('thumbnails', () => {
  let dir;
  let thumbs;
  const run = async (name) => {
    const abs = path.join(dir, 'files', name);
    const { size } = await fs.stat(abs);
    const ext = extOf(name);
    return analyze({ abs, name, ext, kind: kindOf(ext), size, hash: name.replace(/\W/g, '').padEnd(32, '0').slice(0, 32) }, thumbs);
  };

  before(async () => {
    dir = await tempDir();
    await makeFixtures(path.join(dir, 'files'));
    thumbs = new Thumbs(path.join(dir, 'data'));
    await thumbs.init();
  });
  after(() => fs.rm(dir, { recursive: true, force: true }));

  // Each format must be decoded by its own decoder, not rescued by a fallback (ffmpeg, Quick Look).
  const own = process.platform === 'darwin' ? {} : { 'sample.heic': 'heic' };
  for (const [name, source] of Object.entries({ 'poster.jpg': 'sharp', 'poster.avif': 'sharp', 'poster.tiff': 'sharp', 'logo.svg': 'sharp', 'layout.psd': 'psd', ...own })) {
    test(`${name} is decoded by ${source}`, async () => {
      const r = await run(name);
      assert.equal(r.thumb, true);
      assert.equal(r.source, source);
      const meta = await sharp(thumbs.thumbPath(name.replace(/\W/g, '').padEnd(32, '0').slice(0, 32))).metadata();
      assert.equal(meta.format, 'webp');
      assert.ok(Math.max(meta.width, meta.height) <= 640);
    });
  }

  test('PSD composite keeps its size and colour', async () => {
    const r = await run('layout.psd');
    assert.deepEqual([r.width, r.height], [300, 400]);
    assert.match(r.color, /^#e/); // the red poster
  });

  test('PDFs get a first-page image and text; design files use their embedded preview', async () => {
    const pdf = await run('manifesto.pdf');
    assert.equal(pdf.thumb, true);
    assert.equal(pdf.pages, 1);
    assert.match(pdf.excerpt, /^Manifesto for slow cinema/);
    const key = await run('deck.key');
    assert.equal(key.kind, 'design');
    assert.equal(key.thumb, true);
  });

  test('unknown files: text is detected, binary stays a file', async () => {
    assert.equal((await run('notes.unknownext')).kind, 'text');
    const blob = await run('blob.bin');
    assert.equal(blob.kind, 'file');
    assert.equal(blob.thumb, false);
  });
});
