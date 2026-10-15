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
  // Anthropic
  'claude-3-7-sonnet-20250219': anthropic,
  'claude-3-opus-20240229':     anthropic,

  // OpenAI
  'gpt-4o':                     openai,
  'gpt-4o-mini':                openai,
  'o1':                         openai,

  // Google Gemini
  'gemini-2.0-flash':           gemini,
  'gemini-1.5-pro':             gemini,

  // Groq (fast inference)
  'llama-3.3-70b-versatile':    groq,
  'llama-3.1-8b-instant':       groq,
};

// ── Fallback model constant ─────────────────────────────────────────────────
/** Model to use when the primary provider returns 429/5xx or network error. */
export const FALLBACK_MODEL = 'llama-3.3-70b-versatile';

// ── Custom provider sentinel → adapter resolver ─────────────────────────────
/**
 * Maps the __custom_*__ sentinel option values to their provider adapter.
 * The UI populates this when the user selects a "Custom…" option.
 */
export const CUSTOM_PROVIDER_MAP = {
  '__custom_anthropic__': anthropic,
  '__custom_gemini__':    gemini,
  '__custom_openai__':    openai,
};

// ── Context pruning ─────────────────────────────────────────────────────────
/**
 * If the estimated token count of `messages` exceeds 80 % of `maxTokens`,
 * preserve the system prompt and the 3 most recent turns, replacing the
 * truncated middle with a '[...Context Pruned...]' sentinel.
 *
 * Token estimation: character-length / 4.
 *
 * @param {{ role: string, text: string }[]} messages
 * @param {number} maxTokens  – model context limit
 * @returns {{ role: string, text: string }[]}
 */
export function pruneContext(messages, maxTokens) {
  const fullText   = messages.map((m) => m.text).join('\n');
  const tokenEst   = Math.ceil(fullText.length / 4);
  const threshold  = maxTokens * 0.8;

  if (tokenEst <= threshold) return messages;

  // Keep system message (if first message has role 'system') + last 3 turns
  const [first, ...rest] = messages;
  const isSystem = first?.role === 'system';
  const head     = isSystem ? [first] : [];
  const tail     = (isSystem ? rest : messages).slice(-3);

  const pruned = [
    ...head,
    { role: 'system', text: '[...Context Pruned...]' },
    ...tail,
  ];
  return pruned;
}
