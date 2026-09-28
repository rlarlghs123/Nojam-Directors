import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parseJson, ProviderError } from '../src/providers.js';
import { TAG_SCHEMA } from '../src/tagger.js';
import { poster } from './fixtures.js';
import { testApp, waitFor } from './helpers.js';

const answer = (name) => ({ title: `About ${name}`, tags: ['free', 'local model'], summary: 'Tagged without paying.', keywords: ['gratis'] });

/** A tiny fake API server. `handle(req, body)` returns [status, json, headers?]. */
async function fakeServer(handle) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ url: req.url, headers: req.headers, body });
    const [status, json, headers = {}] = await handle(req, body, requests.length);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(json));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

async function addFiles(t, files) {
  await fs.mkdir(t.config.libraryDir, { recursive: true });
  for (const [name, data] of Object.entries(files)) await fs.writeFile(path.join(t.config.libraryDir, name), data);
  await t.library.scan();
}

test('parseJson copes with code fences and chatter', () => {
  assert.deepEqual(parseJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJson('```json\n{"a": [1, 2]}\n```'), { a: [1, 2] });
  assert.deepEqual(parseJson('Sure! Here it is: {"a": "}"} Hope that helps.'), { a: '}' });
  assert.throws(() => parseJson('no json here'), (e) => e instanceof ProviderError && e.kind === 'item');
});

describe('Ollama (free, on this computer)', () => {
  let api;
  let mode = 'ok';
  before(async () => {
    api = await fakeServer((req, body) => {
      if (mode === 'missing') return [404, { error: `model "${body.model}" not found, try pulling it first` }];
      const name = body.messages[1].content.match(/File name: (.*)/)[1];
      return [200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(answer(name)) }, done: true }];
    });
  });
  after(() => api.close());

  test('sends the image and the schema, tags everything without asking (it is free)', async () => {
    mode = 'ok';
    const t = await testApp({ client: null, config: { tagger: 'ollama', tagUrl: api.url, confirmBacklog: 1 } });
    try {
      await addFiles(t, { 'a.jpg': await poster(), 'note.md': '# Brutalism\nconcrete', 'b.txt': 'b' });
      t.tagger.start();
      await t.idle();
      assert.equal(t.tagger.status().needsApproval, false);
      assert.equal(t.store.statusCounts().done, 3);

      const req = api.requests.find((r) => r.body.messages[1].content.includes('a.jpg'));
      assert.equal(req.url, '/api/chat');
      assert.equal(req.body.model, 'qwen3-vl:8b-instruct');
      assert.equal(req.body.stream, false);
      assert.deepEqual(req.body.format, TAG_SCHEMA);
      assert.equal(req.body.messages[0].role, 'system');
      assert.equal(req.body.messages[1].images.length, 1);
      assert.ok(Buffer.from(req.body.messages[1].images[0], 'base64').length > 1000);
      const memo = api.requests.find((r) => r.body.messages[1].content.includes('note.md'));
      assert.equal(memo.body.messages[1].images, undefined);
      assert.match(memo.body.messages[1].content, /# Brutalism/);

      const row = t.store.getByPath('a.jpg');
      assert.deepEqual(t.store.visibleTags(row.id), ['free', 'local model']);
      assert.equal(row.tag_model, 'qwen3-vl:8b-instruct');
      assert.equal(t.tagger.status().estimate, 0);
    } finally {
      await t.close();
    }
  });

  test('a model that is not downloaded pauses tagging with the command to fix it', async () => {
    mode = 'missing';
    const t = await testApp({ client: null, config: { tagger: 'ollama', tagUrl: api.url, tagModel: 'gemma4:e4b' } });
    try {
      await addFiles(t, { 'x.txt': 'x' });
      t.tagger.start();
      await waitFor(() => t.tagger.status().paused);
      assert.match(t.tagger.status().lastError, /ollama pull gemma4:e4b/);
      assert.equal(t.store.getByPath('x.txt').tag_status, 'pending');
    } finally {
      await t.close();
    }
  });

  test('Ollama not running: wait and retry instead of failing blocks', async () => {
    const t = await testApp({ client: null, config: { tagger: 'ollama', tagUrl: 'http://127.0.0.1:9' } });
    try {
      await addFiles(t, { 'x.txt': 'x' });
      t.tagger.start();
      await waitFor(() => t.tagger.status().lastError);
      const s = t.tagger.status();
      assert.match(s.lastError, /Can't reach Ollama/);
      assert.ok(s.retryAt > Date.now() + 30_000); // the page shows "Tagging is waiting"
      assert.match(s.setupHint, /ollama pull qwen3-vl:8b-instruct/);
      assert.equal(t.store.getByPath('x.txt').tag_status, 'pending');
    } finally {
      await t.close();
    }
  });

  test('"Try now" skips the wait', async () => {
    mode = 'ok';
    let down = true;
    const flaky = await fakeServer((req, body) => {
      if (down) return [503, { error: 'server busy, please try again' }];
      const name = body.messages[1].content.match(/File name: (.*)/)[1];
      return [200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(answer(name)) }, done: true }];
    });
    const t = await testApp({ client: null, config: { tagger: 'ollama', tagUrl: flaky.url } });
    try {
      await addFiles(t, { 'x.txt': 'x' });
      t.tagger.start();
      await waitFor(() => t.tagger.status().retryAt);
      assert.equal(flaky.requests.length, 1);
      down = false;
      t.tagger.approve(); // what the "Try now" button does
      await waitFor(() => t.store.getByPath('x.txt').tag_status === 'done');
      assert.equal(t.tagger.status().retryAt, null);
      assert.equal(flaky.requests.length, 2);
    } finally {
      await t.close();
      flaky.close();
    }
  });
});

describe('OpenAI-compatible services (Gemini free tier, OpenRouter, custom)', () => {
  test('without a key it stays off and says where to get one', async () => {
    const t = await testApp({ client: null, config: { tagger: 'gemini', tagKey: '' } });
    try {
      const s = t.tagger.status();
      assert.equal(s.enabled, false);
      assert.equal(s.model, 'gemini-3.5-flash-lite');
      assert.match(s.setupHint, /aistudio\.google\.com/);
    } finally {
      await t.close();
    }
  });

  test('steps down from JSON schema to JSON mode when a service rejects it, and reads fenced JSON', async () => {
    const api = await fakeServer((req, body) => {
      if (body.response_format?.type === 'json_schema') return [400, [{ error: { code: 400, message: 'Invalid JSON payload: response_format.json_schema is not supported' } }]];
      const text = body.messages[1].content.at(-1).text;
      const name = text.match(/File name: (.*)/)[1];
      return [200, { model: 'gemini-3.5-flash-lite', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '```json\n' + JSON.stringify(answer(name)) + '\n```' } }] }];
    });
    const t = await testApp({ client: null, config: { tagger: 'gemini', tagUrl: api.url, tagKey: 'free-key' } });
    try {
      await addFiles(t, { 'a.jpg': await poster(), 'b.txt': 'second' });
      t.tagger.start();
      await t.idle();
      assert.equal(t.store.statusCounts().done, 2);
      const [first, second, third] = api.requests;
      assert.equal(first.url, '/chat/completions');
      assert.equal(first.headers.authorization, 'Bearer free-key');
      assert.equal(first.body.response_format.type, 'json_schema');
      assert.equal(second.body.response_format.type, 'json_object');
      assert.equal(third.body.response_format.type, 'json_object'); // remembered
      assert.equal(api.requests.length, 3);
      const withImage = api.requests.find((r) => r.body.messages[1].content[0].type === 'image_url');
      assert.match(withImage.body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/);
    } finally {
      await t.close();
      api.close();
    }
  });

  test('free-limit responses wait as long as the service asks; a bad key pauses', async () => {
    let status = 429;
    const api = await fakeServer(() =>
      status === 429 ? [429, { error: { message: 'Resource has been exhausted (e.g. check quota).' } }, { 'Retry-After': '120' }] : [401, { error: { message: 'API key not valid' } }],
    );
    const t = await testApp({ client: null, config: { tagger: 'openrouter', tagUrl: api.url, tagKey: 'k' } });
    try {
      await addFiles(t, { 'a.txt': 'a' });
      t.tagger.start();
      await waitFor(() => t.tagger.status().lastError);
      assert.ok(t.tagger.blockedUntil > Date.now() + 100_000 && t.tagger.blockedUntil < Date.now() + 130_000);
      assert.match(t.tagger.status().lastError, /free limit/);
      assert.equal(t.store.getByPath('a.txt').tag_status, 'pending');

      status = 401;
      t.tagger.retag(t.store.getByPath('a.txt').id);
      await waitFor(() => t.tagger.status().paused);
      assert.match(t.tagger.status().lastError, /rejected the API key/);
    } finally {
      await t.close();
      api.close();
    }
  });
});
