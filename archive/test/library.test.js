import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createApp } from '../src/app.js';
import { isGenericName } from '../src/library.js';
import { makeFixtures, poster } from './fixtures.js';
import { fakeClaude, testApp, waitFor } from './helpers.js';

describe('library', () => {
  test('indexes every kind of file with thumbnails and text', async () => {
    const t = await testApp();
    try {
      await makeFixtures(t.config.libraryDir);
      await t.library.scan();
      const byName = Object.fromEntries(t.store.search({ limit: 200 }).rows.map((r) => [r.name, r]));
      const expect = {
        'poster.jpg': ['image', true],
        'poster.png': ['image', true],
        'poster.webp': ['image', true],
        'poster.avif': ['image', true],
        'poster.tiff': ['image', true],
        'logo.svg': ['image', true],
        'sample.heic': ['image', true],
        'layout.psd': ['image', true],
        'manifesto.pdf': ['pdf', true],
        'deck.key': ['design', true],
        'memo.md': ['text', false],
        'essay.docx': ['text', false],
        'old.hwp': ['text', false],
        'notes.unknownext': ['text', false],
        'YouTube clip.url': ['link', null],
        'blob.bin': ['file', false],
      };
      for (const [name, [kind, thumb]] of Object.entries(expect)) {
        assert.ok(byName[name], `${name} indexed`);
        assert.equal(byName[name].kind, kind, `${name} kind`);
        if (thumb !== null) assert.equal(Boolean(byName[name].thumb), thumb, `${name} thumbnail`);
      }
      // Browsers can't show TIFF/HEIC/PSD, so those get a JPEG preview; JPEG/PNG are shown as-is.
      assert.equal(byName['poster.tiff'].preview, 1);
      assert.equal(byName['sample.heic'].preview, 1);
      assert.equal(byName['poster.jpg'].preview, 0);
      assert.equal(byName['poster.jpg'].width, 600);
      assert.equal(byName['YouTube clip.url'].url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      assert.equal(byName['Mac link.webloc'].url, 'https://example.com/?a=1&b=2');
      assert.match(byName['essay.docx'].excerpt, /^Essay on Tarkovsky/);
      const thumbFile = t.thumbs.thumbPath(byName['sample.heic'].hash);
      assert.ok((await fs.stat(thumbFile)).size > 100);
    } finally {
      await t.close();
    }
  });

  test('tags are saved next to the files (.archive/meta/<hash>.json)', async () => {
    const t = await testApp();
    const lib = t.config.libraryDir;
    try {
      await fs.mkdir(path.join(lib, 'Posters'), { recursive: true });
      await fs.writeFile(path.join(lib, 'Posters', 'red.jpg'), await poster());
      await t.library.scan();
      t.tagger.start();
      await t.idle();
      const id = t.store.getByPath('Posters/red.jpg').id;
      t.store.addUserTag(id, 'favourite');
      t.store.removeTag(id, 'reference');
      await t.library.saveSidecar(id);
      const side = JSON.parse(await fs.readFile(path.join(lib, '.archive', 'meta', `${t.store.getItem(id).hash}.json`), 'utf8'));
      assert.deepEqual(side.user, { add: ['favourite'], hide: ['reference'] });
      assert.ok(side.ai.tags.includes('poster'));
      assert.equal(side.ai.title, 'About red.jpg');
    } finally {
      await t.close();
    }
  });

  test('sidecars restore tags without calling Claude again', async () => {
    const first = await testApp();
    const lib = first.config.libraryDir;
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(path.join(lib, 'poster.jpg'), await poster());
    await first.library.scan();
    first.tagger.start();
    await first.idle();
    const id = first.store.getByPath('poster.jpg').id;
    first.store.addUserTag(id, 'favourite');
    await first.library.saveSidecar(id);
    const tagsBefore = first.store.visibleTags(id);
    await first.library.stop();
    first.store.close();

    const client = fakeClaude();
    const second = await createApp({ ...first.config, dataDir: path.join(first.root, 'data-2') }, { client });
    try {
      await second.library.scan();
      second.tagger.start();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(client.calls.length, 0);
      const row = second.store.getByPath('poster.jpg');
      assert.equal(row.tag_status, 'done');
      assert.deepEqual(second.store.visibleTags(row.id).sort(), tagsBefore.sort());
    } finally {
      await second.close();
      await fs.rm(first.root, { recursive: true, force: true });
    }
  });

  test('renaming or moving a file keeps the block and its tags', async () => {
    const t = await testApp();
    const lib = t.config.libraryDir;
    try {
      await fs.mkdir(lib, { recursive: true });
      await fs.writeFile(path.join(lib, 'IMG_1.jpg'), await poster());
      await t.library.scan();
      t.tagger.start();
      await t.idle();
      const before = t.store.getByPath('IMG_1.jpg');
      t.store.addUserTag(before.id, 'mine');

      await fs.mkdir(path.join(lib, 'Posters'));
      await fs.rename(path.join(lib, 'IMG_1.jpg'), path.join(lib, 'Posters', 'Red poster.jpg'));
      await t.library.scan();
      const after = t.store.getByPath('Posters/Red poster.jpg');
      assert.equal(after.id, before.id);
      assert.equal(after.folder, 'Posters');
      assert.ok(t.store.visibleTags(after.id).includes('mine'));
      assert.equal(t.client.calls.length, 1);
      assert.equal(t.store.getByPath('IMG_1.jpg'), undefined);
    } finally {
      await t.close();
    }
  });

  test('deleted files disappear on rescan; deleting from the app moves to .trash', async () => {
    const t = await testApp();
    const lib = t.config.libraryDir;
    try {
      await fs.mkdir(lib, { recursive: true });
      await fs.writeFile(path.join(lib, 'a.txt'), 'a');
      await fs.writeFile(path.join(lib, 'b.txt'), 'b');
      await t.library.scan();
      await fs.rm(path.join(lib, 'a.txt'));
      await t.library.scan();
      assert.equal(t.store.getByPath('a.txt'), undefined);

      const b = t.store.getByPath('b.txt');
      await t.library.trashItem(b.id);
      assert.equal(t.store.getItem(b.id), undefined);
      const trashed = await fs.readdir(path.join(lib, '.trash'));
      assert.equal(trashed.length, 1);
      assert.match(trashed[0], / b\.txt$/);
      // .trash and .archive are never indexed
      await t.library.scan();
      assert.equal(t.store.search({}).total, 0);
    } finally {
      await t.close();
    }
  });

  test('memos: create, edit (re-tags), and name from the first line', async () => {
    const t = await testApp();
    try {
      t.tagger.start();
      const { item } = await t.library.createMemo('# Ideas: poster/series\nsecond line', 'Memos');
      assert.equal(item.name, 'Ideas- poster-series.md');
      assert.equal(item.folder, 'Memos');
      t.tagger.prioritize(item.id);
      await t.idle();
      const updated = await t.library.updateText(item.id, '# Ideas\nrewritten');
      assert.equal(updated.id, item.id);
      assert.equal(await fs.readFile(path.join(t.config.libraryDir, 'Memos', item.name), 'utf8'), '# Ideas\nrewritten');
      await waitFor(() => t.client.calls.length === 2 && t.store.getItem(item.id).tag_status === 'done');
      assert.match(t.client.calls[1].messages[0].content.at(-1).text, /rewritten/);
      await assert.rejects(t.library.createMemo('   '), /empty/);
    } finally {
      await t.close();
    }
  });

  test('uploads never overwrite, and duplicates are detected', async () => {
    const t = await testApp();
    try {
      const tmp = async (data) => {
        const p = path.join(t.config.dataDir, 'tmp', `${Math.random()}`);
        await fs.writeFile(p, data);
        return p;
      };
      const [a, b] = await Promise.all([
        t.library.importFile(await tmp('first'), { name: 'image.png', folder: '' }),
        t.library.importFile(await tmp('second'), { name: 'image.png', folder: '' }),
      ]);
      assert.deepEqual([a.item.name, b.item.name].sort(), ['image (2).png', 'image.png']);
      const dup = await t.library.importFile(await tmp('first'), { name: 'again.png', folder: 'Elsewhere' });
      assert.equal(dup.duplicate, true);
      assert.equal(dup.item.id, a.item.id);
      await assert.rejects(t.library.importFile(await tmp('x'), { name: 'x.txt', folder: '../outside' }), /Invalid folder/);
    } finally {
      await t.close();
    }
  });
});

test('files synced into the folder (iCloud, Google Drive) show up on their own', async () => {
  const t = await testApp({ config: { watch: true } });
  const lib = t.config.libraryDir;
  try {
    await t.library.start();
    t.tagger.start();
    const seen = [];
    t.events.on('item', (it) => seen.push(it));
    await fs.mkdir(path.join(lib, 'From phone'));
    await fs.writeFile(path.join(lib, 'From phone', 'IMG_7777.jpg'), await poster());
    const row = await waitFor(() => t.store.getByPath('From phone/IMG_7777.jpg'), { timeout: 20_000 });
    await waitFor(() => t.store.getItem(row.id).tag_status === 'done');
    assert.ok(seen.some((it) => it.id === row.id && it.created));

    // Renamed on another device: same block, same tags, no new Claude call.
    await fs.rename(path.join(lib, 'From phone', 'IMG_7777.jpg'), path.join(lib, 'From phone', 'poster.jpg'));
    await waitFor(() => t.store.getByPath('From phone/poster.jpg'), { timeout: 20_000 });
    assert.equal(t.store.getByPath('From phone/poster.jpg').id, row.id);
    assert.equal(t.client.calls.length, 1);

    // Deleted on another device.
    await fs.rm(path.join(lib, 'From phone', 'poster.jpg'));
    await waitFor(() => !t.store.getItem(row.id), { timeout: 20_000 });
  } finally {
    await t.close();
  }
});

test('unsafe shortcuts and symlinks never become links or served files', async () => {
  const t = await testApp();
  const lib = t.config.libraryDir;
  try {
    await fs.mkdir(lib, { recursive: true });
    await fs.writeFile(path.join(lib, 'evil.url'), '[InternetShortcut]\nURL=javascript:alert(document.cookie)\n');
    await fs.writeFile(path.join(lib, 'local.webloc'), '<plist><dict><key>URL</key><string>file:///etc/passwd</string></dict></plist>');
    const outside = path.join(t.root, 'outside.txt');
    await fs.writeFile(outside, 'secret');
    await fs.symlink(outside, path.join(lib, 'link-to-outside.txt'));
    await t.library.scan();
    for (const name of ['evil.url', 'local.webloc']) {
      const row = t.store.getByPath(name);
      assert.equal(row.kind, 'file', name);
      assert.equal(row.url, null, name);
    }
    assert.equal(t.store.getByPath('link-to-outside.txt'), undefined);
    assert.equal(await t.library.indexPath('link-to-outside.txt'), null);
  } finally {
    await t.close();
  }
});

test('isGenericName spots camera and screenshot names', () => {
  for (const n of ['IMG_2931', 'DSC01234', 'PXL_20260101_123456789', 'Screenshot 2026-09-02 at 11.04.51', '스크린샷 2026-09-02 오후 3.04.51', '1234567890', 'a3f9c2e1b7d04e2f9a1c', 'image', 'Untitled']) {
    assert.equal(isGenericName(n), true, n);
  }
  for (const n of ['swiss jazz poster', 'Tarkovsky - Stalker', 'IMG_2931 fog study', '영화 메모']) {
    assert.equal(isGenericName(n), false, n);
  }
});
