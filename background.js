/**
 * background.js — Synapse · ContextRelay (Service Worker, ES Module)
 *
 * Responsibilities:
 *   1. Accept a long-lived Port from the popup ("relay-port").
 *   2. Inject content.js, extract ChatGPT context from the active tab.
 *   3. Route the extracted messages through the selected provider adapter.
 *   4. Stream SSE chunks back to the popup via port.postMessage.
 *   5. Cascade fallback: primary → Groq (GROQ_FREE_KEY) → Gemini Flash (GEMINI_FREE_KEY).
 *   6. Keep-alive ping every 20s to prevent MV3 service-worker termination.
 */

import { ModelAdapters, CUSTOM_PROVIDER_MAP, FALLBACK_MODEL, pruneContext } from './adapters.js';

// ── Fallback config (hardcoded free-tier keys) ────────────────────────────────

const FALLBACK_CONFIG = {
  GROQ_FREE_KEY:   'ENTER_KEY_HERE',
  GEMINI_FREE_KEY: 'ENTER_KEY_HERE',
};

// ── Port listener (popup → background) ──────────────────────────────────────

/** Tracks the active AbortController so ABORT_STREAM can cancel it. */
let activeAbortController = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'relay-port') return;

  port.onMessage.addListener(async (msg) => {
    // ── Abort signal ───────────────────────────────────────────────────────
    if (msg.type === 'ABORT_STREAM') {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      return;
    }

    if (msg.type !== 'RELAY_CONTEXT') return;

    const { model, customModel, tabId } = msg;

    // ── MV3 Keep-alive: ping every 20 s while streaming ───────────────────
    const keepAliveInterval = setInterval(() => {
      try { port.postMessage({ type: 'ping' }); } catch { /* port closed */ }
    }, 20_000);

    try {
      // 1. Extract context from the active tab via the content script
      const messages = await extractContext(tabId);

      // 2. Relay through the selected model adapter (with fallback cascade)
      await relayContext(port, messages, model, customModel);

      // 3. Signal completion
      port.postMessage({ type: 'DONE' });
    } catch (err) {
      console.error('[Synapse] Relay pipeline failed:', err);
      port.postMessage({ type: 'ERROR', message: err.message ?? String(err) });
    } finally {
      clearInterval(keepAliveInterval);
      activeAbortController = null;
    }
  });
});

// ── Context extraction via content script port ──────────────────────────────

/**
 * Open a port to the content script running in `tabId`, ask it to
 * extract the ChatGPT conversation, and return the messages array.
 *
 * @param {number} tabId
 * @returns {Promise<{ role: string, text: string }[]>}
 */
function extractContext(tabId) {
  return new Promise((resolve, reject) => {
    // Ensure the content script is injected first
    chrome.scripting.executeScript(
      { target: { tabId }, files: ['content.js'] },
      () => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }

        const contentPort = chrome.tabs.connect(tabId, { name: 'content-extractor' });

        contentPort.onMessage.addListener((response) => {
          if (response.type === 'CONTEXT_RESULT') {
            contentPort.disconnect();
            resolve(response.messages);
          } else if (response.type === 'CONTEXT_ERROR') {
            contentPort.disconnect();
            reject(new Error(response.error));
          }
        });

        contentPort.onDisconnect.addListener(() => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
        });

        contentPort.postMessage({ type: 'EXTRACT_CONTEXT' });
      }
    );
  });
}

// ── Context Utilities (PII Scrubbing, Token Estimation, Model Recommender) ──

/**
 * Redact email addresses, IP addresses, and standard API keys from text.
 * Replaces matched sensitive patterns with '[REDACTED]'.
 *
 * @param {string} text
 * @returns {string}
 */
export function scrubPII(text) {
  if (!text || typeof text !== 'string') return text;

  // 1. Email addresses
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

  // 2. IP addresses (IPv4 & standard IPv6)
  const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b/g;

  // 3. Standard API keys (OpenAI sk-, Anthropic sk-ant-, Groq gsk_, Google AIza, AWS AKIA, GitHub ghp_, Stripe, etc.)
  const apiKeyRegex = /\b(?:sk-[a-zA-Z0-9_\-]{20,}|sk-ant-[a-zA-Z0-9_\-]{20,}|gsk_[a-zA-Z0-9_\-]{20,}|AIza[0-9A-Za-z_\-]{20,}|AKIA[0-9A-Z]{16}|ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{22,}|sk_(?:live|test)_[a-zA-Z0-9]{24,})\b/g;

  // 4. Key assignment patterns (e.g. api_key: "...", secret = "...")
  const keyAssignmentRegex = /((?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?)[a-zA-Z0-9_\-]{16,}(['"]?)/gi;

  return text
    .replace(emailRegex, '[REDACTED]')
    .replace(ipRegex, '[REDACTED]')
    .replace(apiKeyRegex, '[REDACTED]')
    .replace(keyAssignmentRegex, '$1[REDACTED]$2');
}

/**
 * Fast heuristic function dividing character length by 4 to estimate token count.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text || typeof text !== 'string') return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Analyze messages to recommend the best model based on coding indicators and token size:
 *   - 'Claude Opus' if backticks (```) or coding keywords appear frequently
 *   - 'Gemini Flash' if estimated token count > 30,000
 *   - 'Groq Llama' otherwise
 *
 * Sends the recommendation through the active port if provided.
 *
 * @param {Array<{ text: string }|string>|string} messages
 * @param {chrome.runtime.Port} [port=null]
 * @returns {string} Recommended model name ('Claude Opus' | 'Gemini Flash' | 'Groq Llama')
 */
export function recommendModel(messages, port = null) {
  let text = '';
  if (Array.isArray(messages)) {
    text = messages
      .map((item) => (typeof item === 'string' ? item : item?.text ?? ''))
      .join('\n');
  } else if (typeof messages === 'string') {
    text = messages;
  }

  const backtickMatches = (text.match(/```/g) || []).length;
  const codingKeywordsRegex = /\b(function|const|let|var|class|def|import|export|return|async|await|console\.|public|private|interface|struct)\b/gi;
  const keywordMatches = (text.match(codingKeywordsRegex) || []).length;
  const isCodingFrequent = backtickMatches >= 1 || keywordMatches >= 3;

  const tokenCount = estimateTokens(text);

  let recommendation = 'Groq Llama';
  if (isCodingFrequent) {
    recommendation = 'Claude Opus';
  } else if (tokenCount > 30000) {
    recommendation = 'Gemini Flash';
  }

  if (port && typeof port.postMessage === 'function') {
    try {
      port.postMessage({
        type: 'RECOMMENDATION',
        recommendation,
        model: recommendation,
        tokens: tokenCount,
      });
    } catch (err) {
      console.warn('[Synapse] Failed to send recommendation over port:', err);
    }
  }

  return recommendation;
}

// ── Relay context to an LLM provider ────────────────────────────────────────

/** Model context-window limits used for pruneContext (tokens). */
const MODEL_TOKEN_LIMITS = {
  default:                      128_000,
  'claude-3-7-sonnet-20250219': 200_000,
  'claude-3-opus-20240229':     200_000,
  'gemini-2.0-flash':         1_000_000,
  'gemini-1.5-pro':           2_000_000,
  'gpt-4o':                     128_000,
  'gpt-4o-mini':                128_000,
  'o1':                         128_000,
  'llama-3.3-70b-versatile':    128_000,
  'llama-3.1-8b-instant':         8_000,
};

/**
 * Resolve adapter + effective model string for a given model value.
 * Handles both normal model IDs and __custom_*__ sentinels.
 * @param {string} modelValue
 * @param {string} [customStr]
 * @returns {{ adapter: object, modelName: string }}
 */
function resolveAdapter(modelValue, customStr) {
  if (ModelAdapters[modelValue]) {
    return { adapter: ModelAdapters[modelValue], modelName: modelValue };
  }
  const customAdapter = CUSTOM_PROVIDER_MAP?.[modelValue];
  if (customAdapter) {
    const modelName = (customStr ?? '').trim();
    if (!modelName) throw new Error('Custom model selected but no model ID was provided.');
    return { adapter: customAdapter, modelName };
  }
  throw new Error(`Unknown model "${modelValue}". No adapter found.`);
}

/**
 * Execute a single SSE fetch, attach the AbortController, and return the Response.
 * @param {object} adapter
 * @param {string} modelName
 * @param {{ role: string, text: string }[]} messages
 * @param {string|null} [overrideKey]  – bypass storage lookup (used for fallback keys)
 * @returns {Promise<Response>}
 */
async function attemptFetch(adapter, modelName, messages, overrideKey = null) {
  // ── Retrieve the API key ───────────────────────────────────────────────
  let apiKey = overrideKey;
  if (!apiKey) {
    const stored = await chrome.storage.session.get(adapter.storageKey)
      .catch(() => chrome.storage.local.get(adapter.storageKey));
    apiKey = stored[adapter.storageKey];
  }

  if (!apiKey || apiKey === 'ENTER_KEY_HERE') {
    throw new Error(
      `No API key found for ${adapter.storageKey}. Please save your key in Settings.`
    );
  }

  // ── Build request ──────────────────────────────────────────────────────
  const payload = adapter.formatPayload(messages, modelName);
  const url     = adapter.buildURL
    ? adapter.buildURL(modelName, apiKey)
    : adapter.endpoint;

  const headers = { 'Content-Type': 'application/json' };
  if (!adapter.buildURL) {
    if (adapter.storageKey === 'apiKey_claude') {
      headers['x-api-key']         = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  // ── AbortController ────────────────────────────────────────────────────
  const controller = new AbortController();
  activeAbortController = controller;

  return fetch(url, {
    method:  'POST',
    headers,
    body:    JSON.stringify(payload),
    signal:  controller.signal,
  });
}

/**
 * Fetch a streaming response from the chosen provider and relay SSE chunks
 * to the popup through `port.postMessage({ type: 'CHUNK', text })`.
 *
 * Cascading fallback order on 429 / 5xx / network error:
 *   primary  →  Groq (GROQ_FREE_KEY)  →  Gemini Flash (GEMINI_FREE_KEY)
 *
 * @param {chrome.runtime.Port} port
 * @param {{ role: string, text: string }[]} messages
 * @param {string} modelValue   – value from the model select
 * @param {string} [customStr]  – user-typed custom model ID (if sentinel)
 */
async function relayContext(port, messages, modelValue, customStr) {
  const { adapter, modelName } = resolveAdapter(modelValue, customStr);

  // ── Pre-fetch: scrub PII, prune context ───────────────────────────────
  let scrubbedMessages = messages.map((m) => ({ ...m, text: scrubPII(m.text) }));

  const tokenLimit = MODEL_TOKEN_LIMITS[modelName] ?? MODEL_TOKEN_LIMITS.default;
  scrubbedMessages  = pruneContext(scrubbedMessages, tokenLimit);

  const tokenCount = estimateTokens(scrubbedMessages.map((m) => m.text).join('\n'));
  recommendModel(scrubbedMessages, port);

  console.log(`[Synapse] relayContext — model: ${modelName}, est. tokens: ${tokenCount}`);

  // ── Helper: send clear + cascade status through port ──────────────────
  const sendCascadeStatus = (message, badge) => {
    try {
      port.postMessage({ type: 'clear' });
      port.postMessage({ type: 'status', message, badge });
    } catch { /* port may have closed */ }
  };

  // ── Attempt 1: primary ────────────────────────────────────────────────
  try {
    const response = await attemptFetch(adapter, modelName, scrubbedMessages);
    if (response.ok) {
      port.postMessage({ type: 'badge', badge: modelName });
      await processSSEStream(response.body, port, adapter);
      return;
    }
    if (!(response.status === 429 || response.status >= 500)) {
      const body = await response.text().catch(() => '(unreadable)');
      throw new Error(`API error ${response.status}: ${body.slice(0, 300)}`);
    }
    console.warn(`[Synapse] Primary failed (${response.status}). Cascading to Groq…`);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Stream aborted by user.');
    if (err.message?.startsWith('API error') || err.message?.includes('model ID')) throw err;
    console.warn(`[Synapse] Primary network error (${modelName}):`, err);
  }

  // ── Attempt 2: Groq fallback ──────────────────────────────────────────
  sendCascadeStatus('Primary failed. Cascading to Groq…', 'Groq Llama 3 (Fallback)');

  const groqAdapter = ModelAdapters[FALLBACK_MODEL];
  let groqOk = false;
  try {
    const groqResponse = await attemptFetch(
      groqAdapter, FALLBACK_MODEL, scrubbedMessages, FALLBACK_CONFIG.GROQ_FREE_KEY
    );
    if (groqResponse.ok) {
      port.postMessage({ type: 'badge', badge: `Groq ${FALLBACK_MODEL} (Fallback)` });
      await processSSEStream(groqResponse.body, port, groqAdapter);
      groqOk = true;
    } else {
      console.warn(`[Synapse] Groq fallback failed (${groqResponse.status}). Cascading to Gemini…`);
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Stream aborted by user.');
    console.warn('[Synapse] Groq fallback network error:', err);
  }

  if (groqOk) return;

  // ── Attempt 3: Gemini Flash last resort ───────────────────────────────
  sendCascadeStatus('Groq failed. Cascading to Gemini Flash…', 'Gemini Flash (Fallback)');

  const geminiAdapter  = ModelAdapters['gemini-2.0-flash'];
  const geminiModel    = 'gemini-2.0-flash';
  const geminiResponse = await attemptFetch(
    geminiAdapter, geminiModel, scrubbedMessages, FALLBACK_CONFIG.GEMINI_FREE_KEY
  );

  if (geminiResponse.ok) {
    port.postMessage({ type: 'badge', badge: 'Gemini 2.0 Flash (Fallback)' });
    await processSSEStream(geminiResponse.body, port, geminiAdapter);
    return;
  }

  const errBody = await geminiResponse.text().catch(() => '(unreadable)');
  throw new Error(
    `All providers failed. Last error — Gemini ${geminiResponse.status}: ${errBody.slice(0, 200)}`
  );
}

// ── SSE stream processor ────────────────────────────────────────────────────

/**
 * Read a `ReadableStream<Uint8Array>` as SSE lines, parse each `data:` field,
 * and relay content tokens to the popup.
 *
 * Handles all four provider response shapes:
 *   • OpenAI / Groq: choices[0].delta.content
 *   • Anthropic:     delta.text  (type "content_block_delta")
 *   • Gemini:        candidates[0].content.parts[0].text
 *
 * @param {ReadableStream<Uint8Array>} body
 * @param {chrome.runtime.Port} port
 * @param {object} adapter
 */
async function processSSEStream(body, port, adapter) {
  const reader  = body.getReader();
  const decoder = new TextDecoder();
  let buffer    = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double-newline (SSE event boundary) or single newline for
      // line-by-line data: fields.
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();

        // Skip empty lines, comments, and SSE stream terminators
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') return;

        if (trimmed.startsWith('data: ')) {
          const jsonStr = trimmed.slice(6);

          try {
            const parsed = JSON.parse(jsonStr);
            const text   = extractTextFromChunk(parsed, adapter);
            if (text) {
              port.postMessage({ type: 'CHUNK', text });
            }
          } catch {
            // Non-JSON data line — skip silently (e.g. SSE comments)
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Pull the textual content from a parsed SSE JSON chunk,
 * depending on the provider's response schema.
 *
 * @param {object} chunk
 * @param {object} adapter
 * @returns {string|null}
 */
function extractTextFromChunk(chunk, adapter) {
  // OpenAI / Groq format
  if (chunk.choices?.[0]?.delta?.content != null) {
    return chunk.choices[0].delta.content;
  }

  // Anthropic format (content_block_delta)
  if (chunk.type === 'content_block_delta' && chunk.delta?.text != null) {
    return chunk.delta.text;
  }

  // Gemini format
  if (chunk.candidates?.[0]?.content?.parts?.[0]?.text != null) {
    return chunk.candidates[0].content.parts[0].text;
  }

  return null;
}
