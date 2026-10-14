/**
 * adapters.js — Synapse · ContextRelay
 *
 * Maps every supported provider to its:
 *   • API endpoint URL
 *   • formatPayload(messages, modelName)  – translates [{role, text}] → provider JSON
 *   • storageKey                          – chrome.storage.local key for the API key
 *
 * Exported as `ModelAdapters`, keyed by the model-select <option> values
 * defined in popup.html.
 */

// ── Helper: generic [{role, text}] → OpenAI-style messages array ────────────
function toOpenAIMessages(messages) {
  return messages.map(({ role, text }) => ({
    role:    role === 'assistant' ? 'assistant' : 'user',
    content: text,
  }));
}

// ── Adapter definitions ──────────────────────────────────────────────────────

const openai = {
  endpoint:   'https://api.openai.com/v1/chat/completions',
  storageKey: 'apiKey_openai',

  /**
   * @param {{ role: string, text: string }[]} messages
   * @param {string} modelName  – e.g. 'gpt-4o', 'gpt-4o-mini'
   * @returns {object} JSON body for the OpenAI Chat Completions API
   */
  formatPayload(messages, modelName) {
    return {
      model:    modelName,
      stream:   true,
      messages: toOpenAIMessages(messages),
    };
  },
};

const anthropic = {
  endpoint:   'https://api.anthropic.com/v1/messages',
  storageKey: 'apiKey_claude',

  /**
   * Anthropic requires a top-level `system` string and alternating
   * user / assistant turns in `messages`.  Since our context is scraped
   * conversation history, we pass the first user message as the system
   * prompt only when it makes semantic sense; otherwise everything goes
   * into `messages`.
   */
  formatPayload(messages, modelName) {
    const anthropicMessages = messages.map(({ role, text }) => ({
      role:    role === 'assistant' ? 'assistant' : 'user',
      content: text,
    }));

    return {
      model:      modelName,
      max_tokens: 4096,
      stream:     true,
      messages:   anthropicMessages,
    };
  },
};

const gemini = {
  // The API key is appended as a query param at call time.
  endpoint:   'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:streamGenerateContent?alt=sse',
  storageKey: 'apiKey_gemini',

  /**
   * Gemini uses `contents[]` with `parts[].text` and a role of
   * "user" or "model".
   */
  formatPayload(messages, _modelName) {
    return {
      contents: messages.map(({ role, text }) => ({
        role:  role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      })),
    };
  },

  /**
   * Build the full URL (with model name + API key inserted).
   * @param {string} modelName
   * @param {string} apiKey
   * @returns {string}
   */
  buildURL(modelName, apiKey) {
    return this.endpoint
      .replace('{MODEL}', modelName)
      + `&key=${apiKey}`;
  },
};

const groq = {
  endpoint:   'https://api.groq.com/openai/v1/chat/completions',
  storageKey: 'apiKey_groq',

  /**
   * Groq exposes an OpenAI-compatible API.
   */
  formatPayload(messages, modelName) {
    return {
      model:    modelName,
      stream:   true,
      messages: toOpenAIMessages(messages),
    };
  },
};

// ── Public map: model-select value → adapter ─────────────────────────────────

export const ModelAdapters = {
  // OpenAI
  'gpt-4o':            openai,
  'gpt-4o-mini':       openai,

  // Anthropic
  'claude-sonnet-4-5': anthropic,
  'claude-opus-4':     anthropic,

  // Google Gemini
  'gemini-2.0-flash':  gemini,
  'gemini-1.5-pro':    gemini,

  // Groq (fast inference)
  'llama-3.3-70b':     groq,
  'mixtral-8x7b':      groq,
};

// ── Fallback model constant ─────────────────────────────────────────────────
/** Model to use when the primary provider returns 429/503. */
export const FALLBACK_MODEL = 'llama-3.3-70b';
