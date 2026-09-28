import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/providers.js';

test('tags are written by Ollama unless TAGGER says otherwise', () => {
  const saved = process.env.TAGGER;
  try {
    delete process.env.TAGGER;
    const config = loadConfig();
    assert.equal(config.tagger, 'ollama');
    const provider = createProvider(config);
    assert.equal(provider.name, 'ollama');
    assert.equal(provider.model, 'qwen3-vl:8b-instruct');
    assert.equal(provider.free, true);

    process.env.TAGGER = ' Claude ';
    assert.equal(loadConfig().tagger, 'claude');
  } finally {
    if (saved === undefined) delete process.env.TAGGER;
    else process.env.TAGGER = saved;
  }
});

test('an unknown TAGGER is a clear error', () => {
  assert.throws(() => createProvider({ tagger: 'olama' }), /Unknown TAGGER "olama"/);
});
