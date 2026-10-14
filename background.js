/**
 * background.js — Synapse · ContextRelay (Service Worker, ES Module)
 *
 * Responsibilities:
 *   1. Accept a long-lived Port from the popup ("relay-port").
 *   2. Inject content.js, extract ChatGPT context from the active tab.
 *   3. Route the extracted messages through the selected provider adapter.
 *   4. Stream SSE chunks back to the popup via port.postMessage.
 *   5. On 429 / 503, automatically retry with the Groq fallback adapter.
 */

import { ModelAdapters, FALLBACK_MODEL } from './adapters.js';

// ── Port listener (popup → background) ──────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'relay-port') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type !== 'RELAY_CONTEXT') return;

    const { model, tabId } = msg;

    try {
      // 1. Extract context from the active tab via the content script
      const messages = await extractContext(tabId);

      // 2. Relay through the selected model adapter (with fallback logic)
      await relayContext(port, messages, model);

      // 3. Signal completion
      port.postMessage({ type: 'DONE' });
    } catch (err) {
      console.error('[Synapse] Relay pipeline failed:', err);
      port.postMessage({ type: 'ERROR', message: err.message ?? String(err) });
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

// ── Relay context to an LLM provider ────────────────────────────────────────

/**
 * Fetch a streaming response from the chosen provider and relay SSE chunks
 * to the popup through `port.postMessage({ type: 'CHUNK', text })`.
 *
 * On HTTP 429 (Rate Limit) or 503 (Overload), the function logs a warning
 * and recursively retries with the Groq Llama 3 fallback adapter.
 *
 * @param {chrome.runtime.Port} port       – long-lived port to the popup
 * @param {{ role: string, text: string }[]} messages – generic conversation
 * @param {string} modelName               – model key from ModelAdapters
 * @param {boolean} [isFallback=false]      – true when this is the retry call
 */
async function relayContext(port, messages, modelName, isFallback = false) {
  const adapter = ModelAdapters[modelName];
  if (!adapter) {
    throw new Error(`Unknown model "${modelName}". No adapter found.`);
  }

  // ── Retrieve the API key from storage ──────────────────────────────────
  const { [adapter.storageKey]: apiKey } =
    await chrome.storage.local.get(adapter.storageKey);

  if (!apiKey) {
    throw new Error(
      `No API key found for ${adapter.storageKey}. ` +
      'Please save your key in Settings.'
    );
  }

  // ── Build the request ──────────────────────────────────────────────────
  const payload = adapter.formatPayload(messages, modelName);

  // Gemini puts the key in the URL; everyone else uses an Authorization header.
  const url = adapter.buildURL
    ? adapter.buildURL(modelName, apiKey)
    : adapter.endpoint;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (!adapter.buildURL) {
    // Standard Bearer auth (OpenAI, Groq) or Anthropic's x-api-key
    if (adapter.storageKey === 'apiKey_claude') {
      headers['x-api-key']         = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  }

  // ── Fetch with SSE streaming ───────────────────────────────────────────
  try {
    const response = await fetch(url, {
      method:  'POST',
      headers,
      body:    JSON.stringify(payload),
    });

    // ── Handle rate-limit / overload with fallback ─────────────────────
    if (response.status === 429 || response.status === 503) {
      const statusText = response.status === 429 ? 'Rate Limited' : 'Overloaded';
      console.warn(
        `[Synapse] ${statusText} (${response.status}) from ${modelName}.`
      );
      port.postMessage({
        type: 'CHUNK',
        text: `\n⚠ ${statusText} on ${modelName}. Switching to fallback…\n\n`,
      });

      if (isFallback) {
        throw new Error(
          `Fallback model "${modelName}" also returned ${response.status}. Giving up.`
        );
      }

      // Recursive retry with the Groq fallback
      return relayContext(port, messages, FALLBACK_MODEL, true);
    }

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '(unreadable body)');
      throw new Error(
        `API error ${response.status}: ${errorBody.slice(0, 300)}`
      );
    }

    // ── Stream SSE from the ReadableStream ────────────────────────────
    await processSSEStream(response.body, port, adapter);

  } catch (err) {
    // Network errors, JSON parse failures, etc.
    if (err.message?.includes('Fallback model') || err.message?.includes('API error')) {
      throw err; // Already handled — propagate
    }

    console.error(`[Synapse] Fetch error for ${modelName}:`, err);

    // If the primary call fails with a non-HTTP error, try the fallback
    if (!isFallback) {
      console.warn('[Synapse] Network error — switching to fallback…');
      port.postMessage({
        type: 'CHUNK',
        text: `\n⚠ Network error on ${modelName}. Switching to fallback…\n\n`,
      });
      return relayContext(port, messages, FALLBACK_MODEL, true);
    }

    throw err;
  }
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
