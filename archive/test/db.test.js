import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { openStore, parseQuery } from '../src/db.js';

function seed(store) {
  const now = Date.now();
  const add = (path, fields = {}, tags = []) => {
    const name = path.split('/').pop();
    const id = store.insertItem({
      path,
      folder: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      name,
      ext: name.split('.').pop(),
      kind: 'image',
      added_at: now - store.allPaths().length * 1000,
      updated_at: now,
      ...fields,
    });
    store.setAiTags(id, tags);
    return id;
  };
  return {
    poster: add('Posters/swiss jazz poster.jpg', { ai_summary: 'A red Swiss poster' }, ['poster', 'swiss style', 'red']),
    nested: add('Posters/Swiss/grid study.png', {}, ['poster', 'grid']),
    memo: add('Memos/영화 메모.md', { kind: 'text', body: '아핏차퐁 영화감독의 기억과 꿈에 대한 메모' }, ['memo', 'film']),
    still: add('Film stills/IMG_2931.jpg', { ai_title: 'Foggy field', ai_keywords: '안개, brume' }, ['film still', 'fog']),
    link: add('Stalker.url', { kind: 'link', url: 'https://example.com/stalker', title: 'Stalker trailer' }, ['film', 'trailer']),
  };
}

describe('search', () => {
  let store;
  let ids;
  const names = (r) => r.rows.map((x) => x.name);

  beforeEach(() => {
    store = openStore(':memory:');
    ids = seed(store);
  });

  test('empty query lists everything, newest first', () => {
    const r = store.search({});
    assert.equal(r.total, 5);
    assert.equal(r.rows[0].id, ids.poster);
  });

  test('substring matches across names, tags, summaries and text', () => {
    assert.deepEqual(names(store.search({ q: 'swis' })), ['swiss jazz poster.jpg', 'grid study.png']);
    assert.deepEqual(names(store.search({ q: 'foggy' })), ['IMG_2931.jpg']); // Claude's title
    assert.deepEqual(names(store.search({ q: 'brume' })), ['IMG_2931.jpg']); // hidden keyword
    assert.deepEqual(names(store.search({ q: 'example.com' })), ['Stalker.url']);
    assert.deepEqual(names(store.search({ q: '영화감독' })), ['영화 메모.md']); // inside the text
  });

  test('two-letter words (e.g. Korean) still match, including document text', () => {
    assert.deepEqual(names(store.search({ q: '영화' })), ['영화 메모.md']);
    assert.deepEqual(names(store.search({ q: '안개' })), ['IMG_2931.jpg']);
    assert.deepEqual(names(store.search({ q: '기억' })), ['영화 메모.md']);
  });

  test('all words must match', () => {
    assert.deepEqual(names(store.search({ q: 'red poster' })), ['swiss jazz poster.jpg']);
    assert.equal(store.search({ q: 'red fog' }).total, 0);
  });

  test('#tag in the query and tag filters are exact', () => {
    assert.deepEqual(names(store.search({ q: '#film' })), ['영화 메모.md', 'Stalker.url']);
    assert.deepEqual(names(store.search({ tags: ['poster', 'grid'] })), ['grid study.png']);
    assert.equal(store.search({ tags: ['fil'] }).total, 0);
  });

  test('folder scope includes subfolders; kinds filter', () => {
    assert.equal(store.search({ folder: 'Posters' }).total, 2);
    assert.equal(store.search({ folder: 'Posters/Swiss' }).total, 1);
    assert.deepEqual(names(store.search({ kinds: ['text', 'link'] })), ['영화 메모.md', 'Stalker.url']);
  });

  test('queries with SQL/FTS syntax are treated as text', () => {
    for (const q of ['"', 'a" OR "b', "'; DROP TABLE items; --", 'NEAR(', '*', '%', '_', 'title:x']) {
      assert.doesNotThrow(() => store.search({ q }), q);
    }
    assert.equal(store.search({ q: '%' }).total, 0);
  });

  test('removed AI tags stay hidden and are not searchable', () => {
    store.removeTag(ids.poster, 'red');
    assert.deepEqual(store.visibleTags(ids.poster), ['poster', 'swiss style']);
    assert.equal(store.search({ tags: ['red'] }).total, 0);
    // A fresh round of AI tags doesn't bring it back.
    store.setAiTags(ids.poster, ['poster', 'red', 'jazz']);
    assert.deepEqual(store.visibleTags(ids.poster), ['poster', 'jazz']);
    // Adding it yourself does.
    store.addUserTag(ids.poster, 'red');
    assert.ok(store.visibleTags(ids.poster).includes('red'));
  });

  test('tag counts follow the current search', () => {
    const all = Object.fromEntries(store.tagCounts({}).map((t) => [t.tag, t.n]));
    assert.equal(all.poster, 2);
    const inPosters = store.tagCounts({ q: 'swiss jazz' }).map((t) => t.tag);
    assert.deepEqual(inPosters.sort(), ['poster', 'red', 'swiss style']);
  });

  test('related items share tags', () => {
    assert.deepEqual(store.related(ids.poster).map((r) => r.id), [ids.nested]);
    assert.deepEqual(store.related(ids.memo).map((r) => r.id), [ids.link]);
  });

  test('shuffle is stable for a seed', () => {
    const a = store.search({ sort: 'random', seed: 42 }).rows.map((r) => r.id);
    const b = store.search({ sort: 'random', seed: 42 }).rows.map((r) => r.id);
    assert.deepEqual(a, b);
  });
});

test('parseQuery splits words, quoted phrases and #tags', () => {
  assert.deepEqual(parseQuery('Red "swiss style" #Poster #'), { words: ['red', 'swiss style', '#'], tags: ['poster'] });
});
