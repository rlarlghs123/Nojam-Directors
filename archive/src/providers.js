import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

// Who writes the tags. Pick one with TAGGER= in archive/.env:
//   ollama      a vision model running on this computer (free, private, no limits) — the default
//   claude      Anthropic Claude (paid, best quality)
//   gemini      Google Gemini API free tier (free with daily limits)
//   openrouter  OpenRouter's free models (free with daily limits)
//   custom      any OpenAI-compatible endpoint (LM Studio, Groq, a paid API…)
// Every provider gets the same prompt and JSON schema and returns { json, model }.

/**
 * `kind` tells the tagger what to do next:
 *   auth, model, config → stop and show the message (the settings need fixing)
 *   busy                → wait and retry later (rate limit, overloaded, unreachable)
 *   item                → only this block failed
 */
export class ProviderError extends Error {
  constructor(kind, message, { retryAfter } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
}

/** The JSON object in a model's answer, tolerating ```json fences or a sentence around it. */
export function parseJson(text) {
  const s = String(text ?? '').trim();
  try {
    return JSON.parse(s);
  } catch {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {}
  }
  throw new ProviderError('item', 'The model returned unreadable output');
}

function retryAfterMs(headers) {
  const v = headers?.get?.('retry-after');
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// ---------- Claude (official SDK) ----------

function claudeProvider(config, client) {
  const env = process.env;
  const model = config.tagModel || config.model || 'claude-opus-5';
  const configured =
    Boolean(client) ||
    Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE || fs.existsSync(path.join(os.homedir(), '.config', 'anthropic')));
  const sdk = client || new Anthropic({ maxRetries: 4, timeout: 120_000 });
  // Effort needs a recent model; server-side refusal fallbacks exist for Opus 5 / Fable 5.
  const useEffort = /^claude-(opus|sonnet|fable|mythos)-(5|4-[5-9])/.test(model);
  const useFallbacks = /^claude-(opus-5|fable-5)/.test(model);

  const toProviderError = (err) => {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      return new ProviderError('auth', 'Claude rejected the API key. Check ANTHROPIC_API_KEY in archive/.env, then press Resume.');
    }
    if (err instanceof Anthropic.NotFoundError) return new ProviderError('model', `Model "${model}" was not found. Check TAG_MODEL in archive/.env.`);
    if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
      return new ProviderError('busy', `Claude is busy or unreachable (${err.status || err.message}).`, { retryAfter: retryAfterMs(err.headers) });
    }
    if (err instanceof Anthropic.APIError) return new ProviderError('item', err.message);
    return new ProviderError('config', err.message); // couldn't send at all, e.g. no credentials
  };

  return {
    name: 'claude',
    label: 'Claude',
    model,
    free: false,
    configured,
    concurrency: 2,
    setupHint: 'Add your Anthropic API key to archive/.env as ANTHROPIC_API_KEY=…, or tag for free on this computer with TAGGER=ollama (see the README).',
    async complete({ system, image, text, schema }) {
      const content = [];
      if (image) content.push({ type: 'image', source: image });
      content.push({ type: 'text', text });
      const params = {
        model,
        max_tokens: 4000,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
        output_config: { format: { type: 'json_schema', schema }, ...(useEffort ? { effort: 'low' } : {}) },
      };
      let res;
      try {
        res = useFallbacks
          ? await sdk.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await sdk.messages.create(params);
      } catch (err) {
        throw toProviderError(err);
      }
      if (res.stop_reason === 'refusal') throw new ProviderError('item', 'Claude declined to describe this item');
      if (res.stop_reason === 'max_tokens') throw new ProviderError('item', 'Claude’s answer was cut off');
      const out = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
      return { json: parseJson(out), model: res.model || model };
    },
  };
}

// ---------- Ollama (local, free) ----------

function ollamaProvider(config) {
  let base = (config.tagUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = `http://${base}`;
  const model = config.tagModel || 'qwen3-vl:8b-instruct';
  return {
    name: 'ollama',
    label: 'Ollama',
    model,
    free: true,
    configured: true,
    concurrency: 1,
    setupHint: `To tag for free, install Ollama from ollama.com, keep it running, and run: ollama pull ${model}`,
    async complete({ system, image, text, schema }) {
      let res;
      try {
        res = await fetch(`${base}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: schema, // structured output: the answer must match the schema
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: text, ...(image ? { images: [image.data] } : {}) },
            ],
          }),
          // The first request loads the model into memory, which can take a while.
          signal: AbortSignal.timeout(600_000),
        });
      } catch (err) {
        if (err.name === 'TimeoutError') throw new ProviderError('item', 'Ollama took too long to answer');
        throw new ProviderError('busy', `Can't reach Ollama at ${base}. Is the Ollama app running?`);
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) throw new ProviderError('model', `Ollama doesn't have "${model}" yet. In a terminal, run: ollama pull ${model}`);
      if (res.status === 429 || res.status === 503) throw new ProviderError('busy', `Ollama is busy (${data.error || res.status}).`);
      if (!res.ok) throw new ProviderError('item', `Ollama: ${data.error || `HTTP ${res.status}`}`);
      return { json: parseJson(data.message?.content), model: data.model || model };
    },
  };
}

// ---------- OpenAI-compatible services (Gemini, OpenRouter, LM Studio, …) ----------

const PRESETS = {
  gemini: {
    label: 'Gemini',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash-lite',
    keyEnv: 'GEMINI_API_KEY',
    free: true,
    keyHint: 'Get a free API key at aistudio.google.com and add it to archive/.env as TAG_API_KEY=…, then restart.',
  },
  openrouter: {
    label: 'OpenRouter',
    url: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free', // routes to whichever free model can read images today
    keyEnv: 'OPENROUTER_API_KEY',
    free: true,
    keyHint: 'Get an API key at openrouter.ai/keys and add it to archive/.env as TAG_API_KEY=…, then restart.',
  },
  custom: {
    label: 'AI service',
    url: '',
    model: '',
    keyEnv: null,
    free: false,
    keyHint: 'Set TAG_API_URL and TAG_MODEL (and TAG_API_KEY if the service needs one) in archive/.env, then restart.',
  },
};

const RESPONSE_FORMATS = ['json_schema', 'json_object', 'none'];

function openAIProvider(config, preset) {
  const p = PRESETS[preset];
  const base = (config.tagUrl || p.url).replace(/\/+$/, '');
  const model = config.tagModel || p.model;
  const key = config.tagKey || (p.keyEnv && process.env[p.keyEnv]) || '';
  const configured = Boolean(base && model && (key || preset === 'custom'));
  // Not every service accepts a JSON schema; step down to plain JSON mode, then to prompt-only.
  let format = 0;

  return {
    name: preset,
    label: p.label,
    model,
    free: p.free,
    configured,
    concurrency: 1,
    setupHint: p.keyHint,
    async complete({ system, image, text, schema }) {
      const user = [];
      if (image) user.push({ type: 'image_url', image_url: { url: `data:${image.media_type};base64,${image.data}` } });
      user.push({ type: 'text', text });
      for (;;) {
        const mode = RESPONSE_FORMATS[format];
        const body = {
          model,
          temperature: 0,
          messages: [
            { role: 'system', content: `${system}\n\nAnswer with the JSON object only.` },
            { role: 'user', content: user },
          ],
        };
        if (mode === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'block_tags', schema } };
        if (mode === 'json_object') body.response_format = { type: 'json_object' };
        let res;
        try {
          res = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(300_000),
          });
        } catch (err) {
          if (err.name === 'TimeoutError') throw new ProviderError('item', `${p.label} took too long to answer`);
          throw new ProviderError('busy', `Can't reach ${base}.`);
        }
        const data = await res.json().catch(() => ({}));
        const error = Array.isArray(data) ? data[0]?.error : data.error;
        const message = String(error?.message || error || `HTTP ${res.status}`).slice(0, 300);
        if (res.status === 400 && mode !== 'none' && /response_format|json|schema|format|additional/i.test(message)) {
          format++;
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          throw new ProviderError('auth', `${p.label} rejected the API key (${message}). Check TAG_API_KEY in archive/.env, then press Resume.`);
        }
        if (res.status === 404) throw new ProviderError('model', `${p.label} doesn't know the model "${model}" (${message}). Check TAG_MODEL in archive/.env.`);
        if (res.status === 429 || res.status >= 500) {
          throw new ProviderError('busy', `${p.label} is busy or its free limit is used up (${message}).`, { retryAfter: retryAfterMs(res.headers) });
        }
        if (!res.ok) throw new ProviderError('item', `${p.label}: ${message}`);
        const choice = data.choices?.[0];
        if (choice?.finish_reason === 'content_filter') throw new ProviderError('item', `${p.label} declined to describe this item`);
        const content = choice?.message?.content;
        const out = Array.isArray(content) ? content.map((c) => c.text || '').join('') : content;
        return { json: parseJson(out), model: data.model || model };
      }
    },
  };
}

/** `client` lets tests pass a stand-in for the Anthropic SDK. */
export function createProvider(config, { client } = {}) {
  const name = (config.tagger || 'ollama').toLowerCase();
  if (name === 'claude' || name === 'anthropic') return claudeProvider(config, client);
  if (name === 'ollama') return ollamaProvider(config);
  if (PRESETS[name]) return openAIProvider(config, name);
  throw new Error(`Unknown TAGGER "${config.tagger}". Use claude, ollama, gemini, openrouter or custom.`);
}
