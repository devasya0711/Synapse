/**
 * popup.js — Synapse · ContextRelay
 * ES Module. Handles: settings toggle, API key persistence, relay action.
 * All state is read from chrome.storage.local; nothing is stored in module scope.
 */

// ── Storage key constants ────────────────────────────────────────────────────
const STORAGE_KEYS = {
  GEMINI_KEY: 'apiKey_gemini',
  CLAUDE_KEY:  'apiKey_claude',
  OPENAI_KEY:  'apiKey_openai',
  GROQ_KEY:    'apiKey_groq',
  LAST_MODEL:  'lastSelectedModel',
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const settingsToggleBtn   = document.getElementById('btn-settings-toggle');
const settingsView        = document.getElementById('view-settings');
const mainViews           = document.getElementById('main-views');

const modelSelect         = document.getElementById('model-select');
const customModelGroup    = document.getElementById('custom-model-group');
const customModelInput    = document.getElementById('custom-model-input');
const relayBtn            = document.getElementById('btn-relay');
const stopBtn             = document.getElementById('btn-stop');
const relayStatus         = document.getElementById('relay-status');
const responseContainer   = document.getElementById('response-container');
const modelBadge          = document.getElementById('model-badge');

const saveKeysBtn         = document.getElementById('btn-save-keys');
const saveStatus          = document.getElementById('save-status');
const tokenCounter        = document.getElementById('token-counter');
const recommendedBadge    = document.getElementById('recommended-model-badge');

const keyInputs = {
  [STORAGE_KEYS.GEMINI_KEY]: document.getElementById('key-gemini'),
  [STORAGE_KEYS.CLAUDE_KEY]:  document.getElementById('key-claude'),
  [STORAGE_KEYS.OPENAI_KEY]:  document.getElementById('key-openai'),
  [STORAGE_KEYS.GROQ_KEY]:    document.getElementById('key-groq'),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Show a transient status message in a status-bar element.
 * @param {HTMLElement} el
 * @param {string} msg
 * @param {'success'|'error'|'warning'|''} type
 * @param {number} [durationMs=2800]
 */
function showStatus(el, msg, type = '', durationMs = 2800) {
  el.textContent = msg;
  el.className = `status-bar ${type}`.trim();
  setTimeout(() => {
    el.textContent = '';
    el.className = 'status-bar';
  }, durationMs);
}

/**
 * Briefly flash the token counter with an "updated" colour.
 */
function flashCounter() {
  tokenCounter.classList.add('updated');
  setTimeout(() => tokenCounter.classList.remove('updated'), 600);
}

// ── Settings toggle ──────────────────────────────────────────────────────────

function openSettings() {
  settingsView.hidden = false;
  settingsToggleBtn.classList.add('active');
  settingsToggleBtn.setAttribute('aria-pressed', 'true');
}

function closeSettings() {
  settingsView.hidden = true;
  settingsToggleBtn.classList.remove('active');
  settingsToggleBtn.setAttribute('aria-pressed', 'false');
}

settingsToggleBtn.addEventListener('click', () => {
  if (settingsView.hidden) {
    openSettings();
  } else {
    closeSettings();
  }
});

// ── Persist & restore API keys ───────────────────────────────────────────────

/**
 * Load saved API keys from chrome.storage.local and populate the input fields.
 * Uses the masking strategy: if a key exists, fill the field with a sentinel
 * placeholder so the user knows it's saved without exposing the value.
 */
async function loadSavedKeys() {
  const storageKeyIds = Object.keys(keyInputs);
  const stored = await chrome.storage.local.get(storageKeyIds);

  for (const [storageKey, inputEl] of Object.entries(keyInputs)) {
    if (stored[storageKey]) {
      // Show a placeholder indicating a key is already saved
      inputEl.placeholder = '••••••••  (saved)';
    }
  }
}

/**
 * Save all non-empty API key fields to chrome.storage.local.
 * Empty fields (where the user cleared the input) will delete the stored key.
 */
async function saveKeys() {
  saveKeysBtn.disabled = true;

  try {
    const toSet    = {};
    const toRemove = [];

    for (const [storageKey, inputEl] of Object.entries(keyInputs)) {
      const val = inputEl.value.trim();
      if (val) {
        toSet[storageKey] = val;
        inputEl.value = '';
        inputEl.placeholder = '••••••••  (saved)';
      } else if (inputEl.placeholder.includes('saved') && !val) {
        // Field was intentionally cleared — remove stored key
        toRemove.push(storageKey);
      }
    }

    if (Object.keys(toSet).length > 0) {
      await chrome.storage.local.set(toSet);
    }
    if (toRemove.length > 0) {
      await chrome.storage.local.remove(toRemove);
    }

    showStatus(saveStatus, '✓ Keys saved securely', 'success');
  } catch (err) {
    console.error('[Synapse] Failed to save keys:', err);
    showStatus(saveStatus, '✗ Save failed — see console', 'error');
  } finally {
    saveKeysBtn.disabled = false;
  }
}

saveKeysBtn.addEventListener('click', saveKeys);

// ── Reveal / hide password toggle ────────────────────────────────────────────

document.querySelectorAll('.reveal-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const input    = document.getElementById(targetId);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

// ── Model select — persist last choice ──────────────────────────────────────

async function restoreLastModel() {
  const { [STORAGE_KEYS.LAST_MODEL]: lastModel } = await chrome.storage.local.get(STORAGE_KEYS.LAST_MODEL);
  if (lastModel) {
    modelSelect.value = lastModel;
  }
  updateRecommendedBadge(modelSelect.value);
  toggleCustomModelInput(modelSelect.value);
}

/** Show/hide the custom model text input based on the selected option. */
function toggleCustomModelInput(value) {
  const isCustom = value.startsWith('__custom_');
  customModelGroup.hidden = !isCustom;
  if (!isCustom) customModelInput.value = '';
}

modelSelect.addEventListener('change', async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.LAST_MODEL]: modelSelect.value });
  updateRecommendedBadge(modelSelect.value);
  toggleCustomModelInput(modelSelect.value);
});

/**
 * Map a model value to its display name for the badge.
 * @param {string} modelValue
 */
function updateRecommendedBadge(modelValue) {
  const labels = {
    'claude-3-7-sonnet-20250219': 'Claude 3.7 Sonnet',
    'claude-3-opus-20240229':     'Claude 3 Opus',
    'gemini-2.0-flash':           'Gemini 2.0 Flash',
    'gemini-1.5-pro':             'Gemini 1.5 Pro',
    'gpt-4o':                     'GPT-4o',
    'gpt-4o-mini':                'GPT-4o Mini',
    'o1':                         'o1',
    'llama-3.3-70b-versatile':    'Llama 3.3 70B',
    'llama-3.1-8b-instant':       'Llama 3.1 8B Instant',
    '__custom_anthropic__':       'Custom Anthropic',
    '__custom_gemini__':          'Custom Gemini',
    '__custom_openai__':          'Custom OpenAI',
  };
  recommendedBadge.textContent = labels[modelValue] ?? '—';
}

// ── Relay Context action ─────────────────────────────────────────────────────

/** Active long-lived port to the service worker (null when idle). */
let relayPort = null;

/**
 * Reset the response container to empty and hide it, and clear the model badge.
 */
function clearResponseContainer() {
  responseContainer.textContent = '';
  responseContainer.hidden = true;
  responseContainer.classList.remove('streaming');
  modelBadge.hidden = true;
  modelBadge.textContent = '';
}

/**
 * Append a text chunk to the response container.
 * Reveals the container on the first chunk and auto-scrolls to the bottom.
 * @param {string} chunk
 */
function appendChunk(chunk) {
  if (responseContainer.hidden) {
    responseContainer.hidden = false;
    responseContainer.classList.add('streaming');
  }
  responseContainer.textContent += chunk;
  // Keep the latest text in view
  responseContainer.scrollTop = responseContainer.scrollHeight;
}

/**
 * Opens a chrome.runtime.Port named 'relay-port', sends the relay trigger,
 * and wires onMessage / onDisconnect to stream chunks into the UI.
 */
async function handleRelay() {
  const model = modelSelect.value;
  if (!model) {
    showStatus(relayStatus, '⚠ Please select a model first', 'warning');
    return;
  }

  // If custom provider, require a model string
  const isCustom    = model.startsWith('__custom_');
  const customModel = customModelInput.value.trim();
  if (isCustom && !customModel) {
    showStatus(relayStatus, '⚠ Please enter a custom model ID', 'warning');
    customModelInput.focus();
    return;
  }

  // Prevent concurrent relay sessions
  if (relayPort) {
    showStatus(relayStatus, '⚠ A relay is already in progress', 'warning');
    return;
  }

  relayBtn.disabled = true;
  stopBtn.disabled  = false;
  clearResponseContainer();
  showStatus(relayStatus, 'Connecting…', '');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    // Open a long-lived connection to the background service worker
    relayPort = chrome.runtime.connect({ name: 'relay-port' });

    // ── Incoming message handler ────────────────────────────────
    relayPort.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'CHUNK':
          appendChunk(msg.text);
          break;

        case 'clear':
          // Background signalling a cascade reset — wipe partially rendered tokens
          responseContainer.textContent = '';
          responseContainer.hidden = true;
          responseContainer.classList.remove('streaming');
          break;

        case 'status':
          // Cascade status update + optional badge
          showStatus(relayStatus, msg.message, 'warning', 6000);
          if (msg.badge) {
            modelBadge.textContent = `▶ ${msg.badge}`;
            modelBadge.hidden = false;
          }
          break;

        case 'badge':
          // Model that actually fulfilled the request
          modelBadge.textContent = `✓ Fulfilled by: ${msg.badge}`;
          modelBadge.hidden = false;
          break;

        case 'ping':
          // Keep-alive from background — no UI action needed
          break;

        case 'DONE':
          responseContainer.classList.remove('streaming');
          showStatus(relayStatus, '✓ Stream complete', 'success');
          flashCounter();
          relayBtn.disabled = false;
          stopBtn.disabled  = true;
          relayPort = null;
          break;

        case 'ERROR':
          responseContainer.classList.remove('streaming');
          showStatus(relayStatus, `✗ ${msg.message}`, 'error');
          relayBtn.disabled = false;
          stopBtn.disabled  = true;
          relayPort = null;
          break;

        case 'RECOMMENDATION':
          if (recommendedBadge && msg.recommendation) {
            recommendedBadge.textContent = msg.recommendation;
          }
          if (tokenCounter && msg.tokens != null) {
            tokenCounter.textContent = msg.tokens.toLocaleString();
            flashCounter();
          }
          break;

        default:
          console.warn('[Synapse] Unknown port message type:', msg.type);
      }
    });

    // ── Port closed unexpectedly (SW terminated, etc.) ──────────
    relayPort.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('[Synapse] Port disconnected with error:', err.message);
        showStatus(relayStatus, `✗ Disconnected: ${err.message}`, 'error');
      } else if (responseContainer.classList.contains('streaming')) {
        // Stream was cut short without a DONE message
        responseContainer.classList.remove('streaming');
        showStatus(relayStatus, '⚠ Connection closed before stream finished', 'warning');
      }
      relayBtn.disabled = false;
      stopBtn.disabled  = true;
      relayPort = null;
    });

    // ── Send the relay trigger through the port ─────────────────
    relayPort.postMessage({ type: 'RELAY_CONTEXT', model, customModel: customModel || undefined, tabId: tab.id });
    showStatus(relayStatus, 'Streaming…', '');

  } catch (err) {
    console.error('[Synapse] Relay error:', err);
    showStatus(relayStatus, `✗ ${err.message}`, 'error');
    relayBtn.disabled = false;
    stopBtn.disabled  = true;
    relayPort = null;
  }
}

relayBtn.addEventListener('click', handleRelay);

/** Send ABORT_STREAM through the active port when Stop is clicked. */
stopBtn.addEventListener('click', () => {
  if (relayPort) {
    try { relayPort.postMessage({ type: 'ABORT_STREAM' }); } catch { /* port closed */ }
  }
  relayBtn.disabled = false;
  stopBtn.disabled  = true;
  responseContainer.classList.remove('streaming');
  showStatus(relayStatus, '⏹ Stream stopped', 'warning');
  relayPort = null;
});

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([
    loadSavedKeys(),
    restoreLastModel(),
  ]);
}

init();
