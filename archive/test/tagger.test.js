import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { canonicalTags, estimateCost, normalizeTag, systemPrompt, TAG_SCHEMA } from '../src/tagger.js';
import { poster } from './fixtures.js';
import { fakeClaude, testApp, waitFor } from './helpers.js';

describe('tag cleanup', () => {
  test('normalizeTag', () => {
    assert.equal(normalizeTag('  #Swiss_Style. '), 'swiss style');
    assert.equal(normalizeTag('"Film Still"'), 'film still');
    assert.equal(normalizeTag('포스터'), '포스터');
    assert.equal(normalizeTag('---'), '');
  });

  test('canonicalTags reuses the vocabulary and merges near-duplicates', () => {
    assert.deepEqual(canonicalTags(['UI-Design', 'Posters', 'red', 'Red'], ['ui design', 'poster']), ['ui design', 'poster', 'red']);
    assert.deepEqual(canonicalTags(['poster', 'posters', 'swiss-style', 'swiss style'], []), ['poster', 'swiss-style']);
    assert.equal(canonicalTags(Array.from({ length: 30 }, (_, i) => `t${i}`), []).length, 15);
  });

  test('system prompt names the tag language and translation languages', () => {
    assert.match(systemPrompt(['en']), /written in English/);
    assert.doesNotMatch(systemPrompt(['en']), /translations/);
    assert.match(systemPrompt(['en', 'ko']), /translations of the main tags into Korean/);
    assert.match(systemPrompt(['ko']), /written in Korean/);
  });

  test('cost estimate', () => {
    assert.equal(estimateCost(0, 'claude-opus-5'), null);
    assert.ok(estimateCost(100, 'claude-opus-5') > estimateCost(100, 'claude-haiku-4-5'));
    assert.equal(estimateCost(10, 'some-unknown-model'), null);
  });
});

describe('tagging with Claude', () => {
  test('an image is sent as a downscaled JPEG with a structured-output schema', async () => {
    const t = await testApp();
    try {
      await fs.mkdir(t.config.libraryDir, { recursive: true });
      await fs.writeFile(path.join(t.config.libraryDir, 'IMG_0001.jpg'), await poster(2400, 3200));
      await t.library.scan();
      t.tagger.start();
      await t.idle();

      assert.equal(t.client.calls.length, 1);
      const req = t.client.calls[0];
      assert.equal(req.model, 'claude-opus-5');
      assert.deepEqual(req.output_config.format, { type: 'json_schema', schema: TAG_SCHEMA });
      assert.equal(req.output_config.effort, 'low');
      assert.equal(req.fallbacks, 'default');
      assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
      assert.equal(req.system[0].cache_control.type, 'ephemeral');
      const [img, text] = req.messages[0].content;
      assert.equal(img.type, 'image');
      assert.equal(img.source.media_type, 'image/jpeg');
      assert.ok(Buffer.from(img.source.data, 'base64').length < 400_000);
      assert.match(text.text, /File name: IMG_0001\.jpg/);

      const item = t.library.present(t.store.getByPath('IMG_0001.jpg'), { full: true });
      assert.equal(item.tagStatus, 'done');
      assert.deepEqual(item.tags, ['reference', 'poster', 'kind-image']);
      assert.equal(item.title, 'About IMG_0001.jpg'); // camera-roll names show Claude's title
      assert.equal(item.summary, 'A summary of IMG_0001.jpg.');
      // Hidden keywords are searchable.
      assert.equal(t.store.search({ q: '참고자료' }).total, 1);
    } finally {
      await t.close();
    }
  });

  test('documents send their text; other models skip opus-only options', async () => {
    const t = await testApp({ config: { model: 'claude-haiku-4-5' } });
    try {
      await fs.mkdir(t.config.libraryDir, { recursive: true });
      await fs.writeFile(path.join(t.config.libraryDir, 'note.md'), '# Brutalism\n\nConcrete, light and shadow.');
      await t.library.scan();
      t.tagger.start();
      await t.idle();
      const req = t.client.calls[0];
      assert.equal(req.fallbacks, undefined);
      assert.equal(req.betas, undefined);
      assert.equal(req.output_config.effort, undefined);
      assert.equal(req.messages[0].content.length, 1);
      assert.match(req.messages[0].content[0].text, /<content>\n# Brutalism\n\nConcrete, light and shadow\.\n\n?<\/content>/);
    } finally {
      await t.close();
    }
  });

  test('a big backlog waits for approval; things you add are tagged right away', async () => {
    const t = await testApp({ config: { confirmBacklog: 2 } });
    try {
      await fs.mkdir(t.config.libraryDir, { recursive: true });
      for (let i = 0; i < 4; i++) await fs.writeFile(path.join(t.config.libraryDir, `n${i}.txt`), `note ${i}`);
      await t.library.scan();
      t.tagger.start();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(t.client.calls.length, 0);
      assert.equal(t.tagger.status().needsApproval, true);
      assert.equal(t.tagger.status().queued, 4);

      const { item } = await t.library.createMemo('fresh idea');
      t.tagger.prioritize(item.id);
      await waitFor(() => t.client.calls.length === 1);
      assert.match(t.client.calls[0].messages[0].content.at(-1).text, /fresh idea/);

      t.tagger.approve();
      await t.idle();
      assert.equal(t.client.calls.length, 5);
      assert.equal(t.store.statusCounts().done, 5);
    } finally {
      await t.close();
    }
  });

  test('refusals and bad output become per-item errors; a bad API key pauses tagging', async () => {
    let mode = 'refuse';
    const client = fakeClaude(async () => {
      if (mode === 'refuse') return { model: 'claude-opus-5', stop_reason: 'refusal', content: [] };
      if (mode === 'garbage') return { model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] };
      if (mode === 'auth') throw new Anthropic.AuthenticationError(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
      return null;
    });
    const t = await testApp({ client });
    try {
      await fs.mkdir(t.config.libraryDir, { recursive: true });
      await fs.writeFile(path.join(t.config.libraryDir, 'a.txt'), 'a');
      await t.library.scan();
      t.tagger.start();
      await t.idle();
      const a = t.store.getByPath('a.txt');
      assert.equal(a.tag_status, 'error');
      assert.match(a.tag_error, /declined/);

      mode = 'garbage';
      t.tagger.retag(a.id);
      await t.idle();
      assert.equal(t.store.getItem(a.id).tag_error, 'Claude returned unreadable output');

      mode = 'auth';
      t.tagger.retag(a.id);
      await waitFor(() => t.tagger.status().paused);
      assert.equal(t.store.getItem(a.id).tag_status, 'pending');
      assert.match(t.tagger.status().lastError, /API key/);

      mode = 'ok';
      t.tagger.approve();
      await t.idle();
      assert.equal(t.store.getItem(a.id).tag_status, 'done');
    } finally {
      await t.close();
    }
  });
});
