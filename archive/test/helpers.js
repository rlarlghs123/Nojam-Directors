import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

export async function tempDir(prefix = 'archive-test-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Stand-in for the Anthropic client. Records every request and answers with tags
 * derived from the file name, or with whatever `respond(params)` returns.
 */
export function fakeClaude(respond) {
  const calls = [];
  const create = async (params) => {
    calls.push(params);
    if (respond) {
      const r = await respond(params);
      if (r) return r;
    }
    const text = params.messages[0].content.at(-1).text;
    const name = text.match(/File name: (.*)/)[1];
    return {
      model: params.model,
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            title: `About ${name}`,
            tags: ['Reference', 'posters', 'poster', `kind-${text.match(/Item type: (\w+)/)[1]}`],
            summary: `A summary of ${name}.`,
            keywords: ['참고자료', 'inspiration'],
          }),
        },
      ],
    };
  };
  const client = { calls, messages: { create }, beta: { messages: { create } } };
  return client;
}

export async function waitFor(fn, { timeout = 15_000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** A full app on temp folders with a fake Claude. Call `.close()` when done. */
export async function testApp({ client = fakeClaude(), config = {}, listen = false } = {}) {
  const root = await tempDir();
  const cfg = loadConfig({
    libraryDir: path.join(root, 'library'),
    dataDir: path.join(root, 'data'),
    watch: false,
    rescanMinutes: 0,
    confirmBacklog: 1000,
    password: '',
    tagger: 'claude', // most tests use the Claude stand-in; provider tests override this
    model: 'claude-opus-5',
    autoTag: true,
    languages: ['en'],
    ...config,
  });
  const ctx = await createApp(cfg, { client });
  let server;
  if (listen) {
    server = ctx.app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    ctx.base = `http://127.0.0.1:${server.address().port}`;
  }
  const idle = () => waitFor(() => !ctx.tagger.active && !ctx.tagger.queue.size && !ctx.tagger.priority.size);
  return {
    ...ctx,
    root,
    config: cfg,
    client,
    idle,
    async close() {
      server?.closeAllConnections?.();
      server?.close();
      await ctx.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
