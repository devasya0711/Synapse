/**
 * popup.js — Synapse · ContextRelay
 * ES Module. Handles: settings toggle, API key persistence, relay action.
 * All state is read from chrome.storage.local; nothing is stored in module scope.
 */

// ── Storage key constants ────────────────────────────────────────────────────
const STORAGE_KEYS = {
  GEMINI_KEY:          'apiKey_gemini',
  CLAUDE_KEY:          'apiKey_claude',
  OPENAI_KEY:          'apiKey_openai',
  GROQ_KEY:            'apiKey_groq',
  LAST_MODEL:          'lastSelectedModel',
  ENCRYPTED_VAULT:     'encrypted_vault',
  FAILED_PIN_ATTEMPTS: 'failedPinAttempts',
  LOCKOUT_UNTIL:       'lockoutUntil',
};

const SESSION_KEYS = {
  UNLOCKED:    'synapse_unlocked',
  SESSION_PIN: '_sessionPin',
  POPUP_STATE: 'POPUP_STATE',
};

// ── Ephemeral UI State (Synced to chrome.storage.session) ─────────────────────
let currentPopupState = {
  model: '',
  customModel: '',
  extractedContext: '',
  tokens: 0,
  recommendedModel: '—',
  modelBadge: '',
  modelBadgeVisible: false,
  responseText: '',
  isStreaming: false,
  statusMessage: '',
  statusType: '',
};

/**
 * Persist partial UI state to chrome.storage.session under POPUP_STATE.
 * @param {object} partial
 */
async function updatePopupState(partial) {
  Object.assign(currentPopupState, partial);
  try {
    await chrome.storage.session.set({ [SESSION_KEYS.POPUP_STATE]: currentPopupState });
  } catch (err) {
    console.warn('[Synapse] Failed to sync POPUP_STATE to session storage:', err);
  }
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const lockBtn             = document.getElementById('btn-lock');
const settingsToggleBtn   = document.getElementById('btn-settings-toggle');
const settingsView        = document.getElementById('view-settings');
const mainViews           = document.getElementById('main-views');

const lockScreen          = document.getElementById('lock-screen');
const lockTitle           = document.getElementById('lock-title');
const lockSubtitle        = document.getElementById('lock-subtitle');
const pinForm             = document.getElementById('pin-form');
const pinInputs           = document.querySelectorAll('.pin-digit');
const pinInputsContainer  = document.getElementById('pin-inputs');
const lockStatus          = document.getElementById('lock-status');
const lockSubmitBtn       = document.getElementById('btn-lock-submit');

const restrictedTabBanner = document.getElementById('restricted-tab-banner');

const modelSelect         = document.getElementById('model-select');
const customModelGroup    = document.getElementById('custom-model-group');
const customModelInput    = document.getElementById('custom-model-input');
const relayBtn            = document.getElementById('btn-relay');
const stopBtn             = document.getElementById('btn-stop');
const relayStatus         = document.getElementById('relay-status');
const responseContainer   = document.getElementById('response-container');
const modelBadge          = document.getElementById('model-badge');

let isCurrentTabRestricted = false;
let isRelaying             = false;
let lockoutTimerId         = null;

// ── Tab Safety & Restricted URL Guard ────────────────────────────────────────

/**
 * Detect whether a tab URL is restricted from extension script injection or DOM extraction.
 * @param {string} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (!url || typeof url !== 'string') return true;
  const lowercaseUrl = url.toLowerCase().trim();
  if (
    lowercaseUrl.startsWith('chrome://') ||
    lowercaseUrl.startsWith('chrome-extension://') ||
    lowercaseUrl.startsWith('about:') ||
    lowercaseUrl.startsWith('edge://')
  ) {
    return true;
  }
  if (
    lowercaseUrl.includes('chromewebstore.google.com') ||
    lowercaseUrl.includes('chrome.google.com/webstore')
  ) {
    return true;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

/**
 * Inspect active tab URL. Toggles restricted banner and manages relay button disabled state.
 * @returns {Promise<boolean>}
 */
async function checkActiveTabSafety() {
  try {
    const [tab] = (await chrome.tabs.query({ active: true, currentWindow: true })) || [];
    const isRestricted = isRestrictedUrl(tab?.url);
    isCurrentTabRestricted = isRestricted;

    if (restrictedTabBanner) {
      restrictedTabBanner.hidden = !isRestricted;
    }

    if (isRestricted) {
      relayBtn.disabled = true;
      relayBtn.title = 'Active page is a restricted browser tab. Open a standard webpage to extract context.';
    } else {
      relayBtn.title = '';
      if (!isRelaying && !currentPopupState.isStreaming) {
        relayBtn.disabled = false;
      }
    }
    return !isRestricted;
  } catch (err) {
    console.warn('[Synapse] Active tab check failed:', err);
    isCurrentTabRestricted = true;
    if (restrictedTabBanner) {
      restrictedTabBanner.hidden = false;
    }
    if (relayBtn) {
      relayBtn.disabled = true;
      relayBtn.title = 'Active page is a restricted browser tab. Open a standard webpage to extract context.';
    }
    return false;
  }
}

/**
 * Toggle the Relay button between ready and loading spinner states.
 * @param {boolean} loading
 */
function setRelayButtonLoading(loading) {
  if (loading) {
    relayBtn.disabled = true;
    relayBtn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Relaying…';
  } else {
    relayBtn.innerHTML = '<span class="btn-icon">⚡</span> Relay Context';
    if (!isCurrentTabRestricted && !currentPopupState.isStreaming && !isRelaying) {
      relayBtn.disabled = false;
    } else {
      relayBtn.disabled = true;
    }
  }
}

// ── Master PIN Brute-Force Throttling ────────────────────────────────────────

/**
 * Enable or disable all PIN input boxes and the unlock button.
 * @param {boolean} disabled
 */
function setPinInputsDisabled(disabled) {
  pinInputs.forEach((input) => {
    input.disabled = disabled;
  });
  lockSubmitBtn.disabled = disabled;
}

/**
 * Start or resume the lockout countdown timer.
 * @param {number} lockoutUntil Timestamp when lockout ends
 */
function startLockoutCountdown(lockoutUntil) {
  if (lockoutTimerId) {
    clearInterval(lockoutTimerId);
    lockoutTimerId = null;
  }

  setPinInputsDisabled(true);

  const tick = () => {
    const now = Date.now();
    const remainingMs = lockoutUntil - now;
    const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));

    if (remainingSec > 0) {
      lockStatus.textContent = `Too many failed attempts. Locked for ${remainingSec} seconds.`;
      lockStatus.className = 'lock-status error';
    } else {
      if (lockoutTimerId) {
        clearInterval(lockoutTimerId);
        lockoutTimerId = null;
      }
      setPinInputsDisabled(false);
      lockStatus.textContent = '';
      lockStatus.className = 'lock-status';
      chrome.storage.local.remove(STORAGE_KEYS.LOCKOUT_UNTIL);
      chrome.storage.local.set({ [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: 0 });
      pinInputs.forEach((input) => { input.value = ''; });
      setTimeout(() => {
        if (!pinInputs[0]?.disabled) {
          pinInputs[0]?.focus();
        }
      }, 50);
    }
  };

  tick();
  lockoutTimerId = setInterval(tick, 1000);
}

/**
 * Check if the PIN entry is currently in a lockout state.
 * @returns {Promise<boolean>}
 */
async function checkPinLockout() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.FAILED_PIN_ATTEMPTS,
    STORAGE_KEYS.LOCKOUT_UNTIL,
  ]);
  const lockoutUntil = stored[STORAGE_KEYS.LOCKOUT_UNTIL] || 0;
  const now = Date.now();

  if (lockoutUntil && lockoutUntil > now) {
    startLockoutCountdown(lockoutUntil);
    return true;
  } else if (lockoutUntil && lockoutUntil <= now) {
    await chrome.storage.local.remove(STORAGE_KEYS.LOCKOUT_UNTIL);
    await chrome.storage.local.set({ [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: 0 });
    setPinInputsDisabled(false);
    return false;
  }
  setPinInputsDisabled(false);
  return false;
}

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

// Preserve default placeholders
Object.values(keyInputs).forEach((inputEl) => {
  if (inputEl) {
    inputEl.dataset.defaultPlaceholder = inputEl.placeholder;
    inputEl.addEventListener('input', () => {
      if (inputEl.value === '' && inputEl.placeholder.includes('saved')) {
        inputEl.dataset.cleared = 'true';
      } else {
        inputEl.dataset.cleared = 'false';
      }
    });
  }
});

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

// ── Web Crypto API (PBKDF2 & AES-GCM) ────────────────────────────────────────

/**
 * Base64 encode an ArrayBuffer or Uint8Array.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {string}
 */
function bufferToBase64(buffer) {
  if (!buffer) return '';
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a Base64 string into a Uint8Array.
 * @param {string} base64
 * @returns {Uint8Array}
 */
function base64ToBuffer(base64) {
  if (!base64 || typeof base64 !== 'string') return new Uint8Array(0);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive a 256-bit AES-GCM key from a 4-digit PIN string and salt using PBKDF2 (SHA-256, 600,000 iterations).
 * @param {string} pin
 * @param {Uint8Array|ArrayBuffer} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(pin, salt) {
  const enc = new TextEncoder();
  const pinBytes = enc.encode(String(pin));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    pinBytes,
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const saltBuffer = salt instanceof Uint8Array ? salt : new Uint8Array(salt);

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 600000,
      hash: 'SHA-256',
    },
    baseKey,
    {
      name: 'AES-GCM',
      length: 256,
    },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a data payload (object or string) with a 4-digit PIN.
 * Generates a 16-byte random salt and 12-byte random IV, derives the key,
 * encrypts the payload, and saves the Base64-encoded ciphertext, salt, and iv to chrome.storage.local.
 * @param {object|string} data
 * @param {string} pin
 * @returns {Promise<{ ciphertext: string, salt: string, iv: string }>}
 */
export async function encryptData(data, pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pin, salt);

  const payloadStr = typeof data === 'string' ? data : JSON.stringify(data);
  const payloadBytes = new TextEncoder().encode(payloadStr);

  const ciphertextBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    payloadBytes
  );

  const encryptedObj = {
    ciphertext: bufferToBase64(ciphertextBuffer),
    salt: bufferToBase64(salt),
    iv: bufferToBase64(iv),
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.ENCRYPTED_VAULT]: encryptedObj });
  return encryptedObj;
}

/**
 * Decrypt an encrypted vault object using a 4-digit PIN.
 * Decodes Base64 values, derives the AES key using the stored salt, and decrypts the ciphertext with stored IV.
 * @param {{ ciphertext: string, salt: string, iv: string }} encryptedObj
 * @param {string} pin
 * @returns {Promise<any>}
 */
export async function decryptData(encryptedObj, pin) {
  if (!encryptedObj || !encryptedObj.ciphertext || !encryptedObj.salt || !encryptedObj.iv) {
    throw new Error('Invalid encrypted object payload.');
  }

  const salt = base64ToBuffer(encryptedObj.salt);
  const iv = base64ToBuffer(encryptedObj.iv);
  const ciphertext = base64ToBuffer(encryptedObj.ciphertext);

  const key = await deriveKey(pin, salt);

  const decryptedBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );

  const decryptedStr = new TextDecoder().decode(decryptedBuffer);
  try {
    return JSON.parse(decryptedStr);
  } catch {
    return decryptedStr;
  }
}

// ── Persist & restore API keys (Session-only unencrypted storage) ─────────────

/**
 * Load saved API keys from chrome.storage.session and populate the input fields.
 * Uses masking placeholders without exposing raw values.
 */
async function loadSavedKeys() {
  const storageKeyIds = [
    STORAGE_KEYS.GEMINI_KEY,
    STORAGE_KEYS.CLAUDE_KEY,
    STORAGE_KEYS.OPENAI_KEY,
    STORAGE_KEYS.GROQ_KEY,
  ];
  const stored = await chrome.storage.session.get(storageKeyIds);

  for (const [storageKey, inputEl] of Object.entries(keyInputs)) {
    if (stored[storageKey]) {
      inputEl.placeholder = '••••••••  (saved)';
    } else {
      inputEl.placeholder = inputEl.dataset.defaultPlaceholder || '';
    }
  }
}

/**
 * Save non-empty API key fields into chrome.storage.session,
 * then encrypt the full key set using the active session PIN and persist to chrome.storage.local.
 */
async function saveKeys() {
  saveKeysBtn.disabled = true;

  try {
    const storageKeyIds = [
      STORAGE_KEYS.GEMINI_KEY,
      STORAGE_KEYS.CLAUDE_KEY,
      STORAGE_KEYS.OPENAI_KEY,
      STORAGE_KEYS.GROQ_KEY,
    ];

    const sessionStored = await chrome.storage.session.get([...storageKeyIds, SESSION_KEYS.SESSION_PIN]);
    const pin = sessionStored[SESSION_KEYS.SESSION_PIN];

    if (!pin) {
      showStatus(saveStatus, '⚠ Vault locked. Enter PIN first.', 'warning');
      showLockScreen(false);
      return;
    }

    const currentKeys = {};
    for (const k of storageKeyIds) {
      if (sessionStored[k]) currentKeys[k] = sessionStored[k];
    }

    const toSessionSet    = {};
    const toSessionRemove = [];

    for (const [storageKey, inputEl] of Object.entries(keyInputs)) {
      const val = inputEl.value.trim();
      if (val) {
        currentKeys[storageKey] = val;
        toSessionSet[storageKey] = val;
        inputEl.value = '';
        inputEl.placeholder = '••••••••  (saved)';
      } else if (inputEl.dataset.cleared === 'true') {
        delete currentKeys[storageKey];
        toSessionRemove.push(storageKey);
        inputEl.dataset.cleared = 'false';
        inputEl.placeholder = inputEl.dataset.defaultPlaceholder || '';
      }
    }

    // Encrypt updated keys and save encrypted payload to chrome.storage.local
    await encryptData(currentKeys, pin);

    // Save active unencrypted keys into chrome.storage.session
    if (Object.keys(toSessionSet).length > 0) {
      await chrome.storage.session.set(toSessionSet);
    }
    if (toSessionRemove.length > 0) {
      await chrome.storage.session.remove(toSessionRemove);
    }

    // Purge any legacy plaintext keys from local storage
    await chrome.storage.local.remove(storageKeyIds);

    showStatus(saveStatus, '✓ Keys encrypted & saved', 'success');
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
  await updatePopupState({
    model: modelSelect.value,
    recommendedModel: recommendedBadge.textContent,
  });
});

customModelInput.addEventListener('input', () => {
  updatePopupState({ customModel: customModelInput.value });
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
/**
 * Wire message and disconnect listeners to the relay port.
 * @param {chrome.runtime.Port} port
 */
function setupPortListeners(port) {
  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'STREAM_STATE':
        if (!msg.isStreaming) {
          responseContainer.classList.remove('streaming');
          isRelaying = false;
          stopBtn.disabled  = true;
          relayPort = null;
          updatePopupState({ isStreaming: false });
          setRelayButtonLoading(false);
        } else {
          isRelaying = true;
          stopBtn.disabled  = false;
          setRelayButtonLoading(true);
        }
        break;

      case 'CHUNK':
        appendChunk(msg.text);
        currentPopupState.responseText = (currentPopupState.responseText || '') + msg.text;
        currentPopupState.isStreaming = true;
        updatePopupState({
          responseText: currentPopupState.responseText,
          isStreaming: true,
        });
        break;

      case 'clear':
        clearResponseContainer();
        currentPopupState.responseText = '';
        updatePopupState({ responseText: '' });
        break;

      case 'status':
        showStatus(relayStatus, msg.message, 'warning', 6000);
        if (msg.badge) {
          modelBadge.textContent = `▶ ${msg.badge}`;
          modelBadge.hidden = false;
          updatePopupState({
            statusMessage: msg.message,
            statusType: 'warning',
            modelBadge: `▶ ${msg.badge}`,
            modelBadgeVisible: true,
          });
        } else {
          updatePopupState({
            statusMessage: msg.message,
            statusType: 'warning',
          });
        }
        break;

      case 'badge':
        modelBadge.textContent = `✓ Fulfilled by: ${msg.badge}`;
        modelBadge.hidden = false;
        updatePopupState({
          modelBadge: `✓ Fulfilled by: ${msg.badge}`,
          modelBadgeVisible: true,
        });
        break;

      case 'ping':
        break;

      case 'RESTRICTED_TAB':
        isCurrentTabRestricted = true;
        if (restrictedTabBanner) {
          restrictedTabBanner.hidden = false;
        }
        isRelaying = false;
        stopBtn.disabled = true;
        relayPort = null;
        setRelayButtonLoading(false);
        showStatus(relayStatus, 'Active page is a restricted browser tab. Open a standard webpage to extract context.', 'warning');
        updatePopupState({ isStreaming: false });
        break;

      case 'DONE':
        responseContainer.classList.remove('streaming');
        showStatus(relayStatus, '✓ Stream complete', 'success');
        flashCounter();
        isRelaying = false;
        stopBtn.disabled  = true;
        relayPort = null;
        updatePopupState({
          isStreaming: false,
          statusMessage: '✓ Stream complete',
          statusType: 'success',
        });
        setRelayButtonLoading(false);
        break;

      case 'ERROR':
        responseContainer.classList.remove('streaming');
        showStatus(relayStatus, `✗ ${msg.message}`, 'error');
        isRelaying = false;
        stopBtn.disabled  = true;
        relayPort = null;
        updatePopupState({
          isStreaming: false,
          statusMessage: `✗ ${msg.message}`,
          statusType: 'error',
        });
        setRelayButtonLoading(false);
        break;

      case 'CONTEXT_EXTRACTED':
        if (recommendedBadge && msg.recommendation) {
          recommendedBadge.textContent = msg.recommendation;
        }
        if (tokenCounter && msg.tokens != null) {
          tokenCounter.textContent = msg.tokens.toLocaleString();
          flashCounter();
        }
        if (msg.text) {
          tokenCounter.title = msg.text.slice(0, 500);
        }
        updatePopupState({
          extractedContext: msg.text || currentPopupState.extractedContext,
          tokens: msg.tokens ?? currentPopupState.tokens,
          recommendedModel: msg.recommendation || currentPopupState.recommendedModel,
        });
        break;

      case 'RECOMMENDATION':
        if (recommendedBadge && msg.recommendation) {
          recommendedBadge.textContent = msg.recommendation;
        }
        if (tokenCounter && msg.tokens != null) {
          tokenCounter.textContent = msg.tokens.toLocaleString();
          flashCounter();
        }
        updatePopupState({
          tokens: msg.tokens ?? currentPopupState.tokens,
          recommendedModel: msg.recommendation || currentPopupState.recommendedModel,
        });
        break;

      default:
        console.warn('[Synapse] Unknown port message type:', msg.type);
    }
  });

  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      console.warn('[Synapse] Port disconnected with error:', err.message);
    }
    relayPort = null;
    isRelaying = false;
    stopBtn.disabled = true;
    setRelayButtonLoading(false);
  });
}

/**
 * Opens a chrome.runtime.Port named 'relay-port', sends the relay trigger,
 * and wires onMessage / onDisconnect to stream chunks into the UI.
 */
async function handleRelay() {
  // Double-Click Guard: Prevent duplicate triggers if already initiating or streaming
  if (isRelaying || relayBtn.disabled || currentPopupState.isStreaming || Boolean(relayPort)) {
    return;
  }
  isRelaying = true;
  setRelayButtonLoading(true);

  // Restricted URL & Tab Guard: Check active tab before proceeding
  const isSafe = await checkActiveTabSafety();
  if (!isSafe) {
    isRelaying = false;
    setRelayButtonLoading(false);
    showStatus(relayStatus, 'Active page is a restricted browser tab. Open a standard webpage to extract context.', 'warning');
    return;
  }

  // Defensive check: Ensure vault is unlocked
  const session = await chrome.storage.session.get([SESSION_KEYS.UNLOCKED, SESSION_KEYS.SESSION_PIN]);
  if (!session[SESSION_KEYS.UNLOCKED] && !session[SESSION_KEYS.SESSION_PIN]) {
    isRelaying = false;
    setRelayButtonLoading(false);
    showStatus(relayStatus, '⚠ Please unlock Synapse first', 'warning');
    showLockScreen(false);
    return;
  }

  const model = modelSelect.value;
  if (!model) {
    isRelaying = false;
    setRelayButtonLoading(false);
    showStatus(relayStatus, '⚠ Please select a model first', 'warning');
    return;
  }

  // If custom provider, require a model string
  const isCustom    = model.startsWith('__custom_');
  const customModel = customModelInput.value.trim();
  if (isCustom && !customModel) {
    isRelaying = false;
    setRelayButtonLoading(false);
    showStatus(relayStatus, '⚠ Please enter a custom model ID', 'warning');
    customModelInput.focus();
    return;
  }

  stopBtn.disabled  = false;
  clearResponseContainer();
  showStatus(relayStatus, 'Connecting…', '');

  currentPopupState.responseText = '';
  currentPopupState.isStreaming = true;
  await updatePopupState({
    responseText: '',
    isStreaming: true,
    model,
    customModel: customModel || '',
    statusMessage: 'Connecting…',
    statusType: '',
  });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found.');

    if (isRestrictedUrl(tab.url)) {
      throw new Error('Active page is a restricted browser tab. Open a standard webpage to extract context.');
    }

    // Open a long-lived connection to the background service worker
    relayPort = chrome.runtime.connect({ name: 'relay-port' });
    setupPortListeners(relayPort);

    // Send the relay trigger through the port
    try {
      relayPort.postMessage({ type: 'RELAY_CONTEXT', model, customModel: customModel || undefined, tabId: tab.id });
    } catch (postErr) {
      console.warn('[Synapse] Failed to send RELAY_CONTEXT on port:', postErr);
      throw postErr;
    }
    showStatus(relayStatus, 'Streaming…', '');
    updatePopupState({ statusMessage: 'Streaming…', statusType: '' });

  } catch (err) {
    console.error('[Synapse] Relay error:', err);
    showStatus(relayStatus, `✗ ${err.message}`, 'error');
    isRelaying = false;
    setRelayButtonLoading(false);
    stopBtn.disabled  = true;
    relayPort = null;
    updatePopupState({ isStreaming: false, statusMessage: `✗ ${err.message}`, statusType: 'error' });
  }
}

relayBtn.addEventListener('click', handleRelay);

/** Send ABORT_STREAM through the active port when Stop is clicked. */
stopBtn.addEventListener('click', () => {
  if (relayPort) {
    try { relayPort.postMessage({ type: 'ABORT_STREAM' }); } catch { /* port closed */ }
  }
  isRelaying = false;
  setRelayButtonLoading(false);
  stopBtn.disabled  = true;
  responseContainer.classList.remove('streaming');
  showStatus(relayStatus, '⏹ Stream stopped', 'warning');
  relayPort = null;
  updatePopupState({
    isStreaming: false,
    statusMessage: '⏹ Stream stopped',
    statusType: 'warning',
  });
});

// Block duplicate keyboard shortcut triggers (Enter) while generation is active
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const isGenerating = isRelaying || currentPopupState.isStreaming || Boolean(relayPort) || relayBtn.disabled;
    if (isGenerating) {
      e.preventDefault();
      e.stopPropagation();
    }
  }
}, true);

// ── Lock Screen UI & Event Wiring ──────────────────────────────────────────

/**
 * Display the Master PIN lock screen overlay.
 * @param {boolean} [setupMode=false]
 */
function showLockScreen(setupMode = false) {
  document.body.classList.add('is-locked');
  lockScreen.hidden = false;
  pinInputs.forEach((input) => { input.value = ''; });
  if (!lockoutTimerId) {
    lockStatus.textContent = '';
    lockStatus.className = 'lock-status';
  }

  if (setupMode) {
    lockTitle.textContent = 'Set Master PIN';
    lockSubtitle.textContent = 'Create a 4-digit PIN to encrypt your API keys';
    lockSubmitBtn.textContent = 'Set PIN';
    lockScreen.dataset.mode = 'setup';
    if (lockoutTimerId) {
      clearInterval(lockoutTimerId);
      lockoutTimerId = null;
    }
    setPinInputsDisabled(false);
  } else {
    lockTitle.textContent = 'Unlock Synapse';
    lockSubtitle.textContent = 'Enter your 4-digit Master PIN';
    lockSubmitBtn.textContent = 'Unlock';
    lockScreen.dataset.mode = 'unlock';
    checkPinLockout();
  }

  setTimeout(() => {
    if (!pinInputs[0]?.disabled) {
      pinInputs[0]?.focus();
    }
  }, 50);
}

/**
 * Hide the Master PIN lock screen overlay.
 */
function hideLockScreen() {
  document.body.classList.remove('is-locked');
  lockScreen.hidden = true;
  pinInputs.forEach((input) => { input.value = ''; });
  lockStatus.textContent = '';
}

/**
 * Handle PIN submission for setup or unlocking.
 */
async function handlePinSubmit(e) {
  if (e) e.preventDefault();

  const isSetup = lockScreen.dataset.mode === 'setup';

  // Master PIN Brute-Force Check: Block entry if locked out
  if (!isSetup) {
    const storedLockout = await chrome.storage.local.get([
      STORAGE_KEYS.FAILED_PIN_ATTEMPTS,
      STORAGE_KEYS.LOCKOUT_UNTIL,
    ]);
    const lockoutUntil = storedLockout[STORAGE_KEYS.LOCKOUT_UNTIL] || 0;
    if (lockoutUntil && lockoutUntil > Date.now()) {
      startLockoutCountdown(lockoutUntil);
      return;
    }
  }

  const pin = Array.from(pinInputs).map((input) => input.value).join('');
  if (pin.length !== 4) {
    lockStatus.textContent = 'Please enter all 4 digits.';
    lockStatus.className = 'lock-status error';
    pinInputsContainer.classList.add('shake');
    setTimeout(() => pinInputsContainer.classList.remove('shake'), 400);
    return;
  }

  lockSubmitBtn.disabled = true;
  lockStatus.textContent = isSetup ? 'Deriving key & setting PIN…' : 'Deriving key & verifying PIN…';
  lockStatus.className = 'lock-status';

  try {
    if (isSetup) {
      // Collect any legacy plaintext keys from chrome.storage.local
      const legacyStored = await chrome.storage.local.get([
        STORAGE_KEYS.GEMINI_KEY,
        STORAGE_KEYS.CLAUDE_KEY,
        STORAGE_KEYS.OPENAI_KEY,
        STORAGE_KEYS.GROQ_KEY,
      ]);

      const initialKeys = {};
      for (const [k, v] of Object.entries(legacyStored)) {
        if (v) initialKeys[k] = v;
      }

      // Encrypt with new PIN and persist to chrome.storage.local
      await encryptData(initialKeys, pin);

      // Store in session storage
      await chrome.storage.session.set({
        ...initialKeys,
        [SESSION_KEYS.UNLOCKED]: true,
        [SESSION_KEYS.SESSION_PIN]: pin,
      });

      // Purge plaintext keys from local storage
      await chrome.storage.local.remove([
        STORAGE_KEYS.GEMINI_KEY,
        STORAGE_KEYS.CLAUDE_KEY,
        STORAGE_KEYS.OPENAI_KEY,
        STORAGE_KEYS.GROQ_KEY,
      ]);

      // Reset failedPinAttempts to 0 upon successful PIN entry
      await chrome.storage.local.set({ [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: 0 });
      await chrome.storage.local.remove(STORAGE_KEYS.LOCKOUT_UNTIL);
      if (lockoutTimerId) {
        clearInterval(lockoutTimerId);
        lockoutTimerId = null;
      }
      setPinInputsDisabled(false);

      hideLockScreen();
      await loadSavedKeys();
      showStatus(relayStatus, '✓ Master PIN set & vault unlocked', 'success');
    } else {
      // Unlock mode: read encrypted vault from chrome.storage.local
      const { [STORAGE_KEYS.ENCRYPTED_VAULT]: encryptedVault } = await chrome.storage.local.get(STORAGE_KEYS.ENCRYPTED_VAULT);
      if (!encryptedVault) {
        showLockScreen(true);
        return;
      }

      const decryptedKeys = await decryptData(encryptedVault, pin);

      // Decryption succeeded — store keys only in session storage
      const sessionPayload = {
        [SESSION_KEYS.UNLOCKED]: true,
        [SESSION_KEYS.SESSION_PIN]: pin,
      };
      if (decryptedKeys && typeof decryptedKeys === 'object') {
        Object.assign(sessionPayload, decryptedKeys);
      }

      await chrome.storage.session.set(sessionPayload);

      // Reset failedPinAttempts to 0 upon a successful PIN entry
      await chrome.storage.local.set({ [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: 0 });
      await chrome.storage.local.remove(STORAGE_KEYS.LOCKOUT_UNTIL);
      if (lockoutTimerId) {
        clearInterval(lockoutTimerId);
        lockoutTimerId = null;
      }
      setPinInputsDisabled(false);

      hideLockScreen();
      await loadSavedKeys();
      showStatus(relayStatus, '✓ Synapse unlocked', 'success');
    }
  } catch (err) {
    console.warn('[Synapse] PIN verification failed:', err);

    if (!isSetup) {
      const stored = await chrome.storage.local.get([
        STORAGE_KEYS.FAILED_PIN_ATTEMPTS,
        STORAGE_KEYS.LOCKOUT_UNTIL,
      ]);
      const attempts = (Number(stored[STORAGE_KEYS.FAILED_PIN_ATTEMPTS]) || 0) + 1;

      if (attempts >= 5) {
        const lockoutDurationMs = 30_000;
        const newLockoutUntil = Date.now() + lockoutDurationMs;
        await chrome.storage.local.set({
          [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: attempts,
          [STORAGE_KEYS.LOCKOUT_UNTIL]: newLockoutUntil,
        });
        startLockoutCountdown(newLockoutUntil);
        return;
      } else {
        await chrome.storage.local.set({ [STORAGE_KEYS.FAILED_PIN_ATTEMPTS]: attempts });
        lockStatus.textContent = 'Incorrect PIN. Please try again.';
        lockStatus.className = 'lock-status error';
      }
    } else {
      lockStatus.textContent = 'Failed to set PIN.';
      lockStatus.className = 'lock-status error';
    }

    pinInputsContainer.classList.add('shake');
    setTimeout(() => pinInputsContainer.classList.remove('shake'), 400);
    pinInputs.forEach((input) => { input.value = ''; });
    pinInputs[0]?.focus();
  } finally {
    if (!lockoutTimerId) {
      lockSubmitBtn.disabled = false;
    }
  }
}

// PIN inputs navigation (auto-advance, backspace, paste)
pinInputs.forEach((input, index) => {
  input.addEventListener('input', (e) => {
    if (input.disabled) return;
    const val = e.target.value.replace(/[^0-9]/g, '');
    e.target.value = val ? val[val.length - 1] : '';

    if (e.target.value) {
      if (index < pinInputs.length - 1) {
        pinInputs[index + 1].focus();
      } else {
        handlePinSubmit();
      }
    }
  });

  input.addEventListener('keydown', (e) => {
    if (input.disabled) return;
    if (e.key === 'Backspace' && !input.value && index > 0) {
      pinInputs[index - 1].focus();
    }
  });

  input.addEventListener('paste', (e) => {
    if (input.disabled) return;
    e.preventDefault();
    const pasteData = (e.clipboardData || window.clipboardData).getData('text').trim();
    const digits = pasteData.replace(/[^0-9]/g, '').slice(0, 4);
    if (!digits) return;

    digits.split('').forEach((d, i) => {
      if (pinInputs[i]) pinInputs[i].value = d;
    });

    if (digits.length === 4) {
      pinInputs[3].focus();
      handlePinSubmit();
    } else if (pinInputs[digits.length]) {
      pinInputs[digits.length].focus();
    }
  });
});

pinForm.addEventListener('submit', handlePinSubmit);

// Lock button: wipe session and show lock screen
if (lockBtn) {
  lockBtn.addEventListener('click', async () => {
    if (relayPort) {
      try { relayPort.postMessage({ type: 'ABORT_STREAM' }); } catch {}
      relayPort = null;
    }
    await chrome.storage.session.clear();
    currentPopupState = {
      model: '',
      customModel: '',
      extractedContext: '',
      tokens: 0,
      recommendedModel: '—',
      modelBadge: '',
      modelBadgeVisible: false,
      responseText: '',
      isStreaming: false,
      statusMessage: '',
      statusType: '',
    };
    clearResponseContainer();
    for (const inputEl of Object.values(keyInputs)) {
      inputEl.value = '';
      inputEl.placeholder = inputEl.dataset.defaultPlaceholder || '';
    }
    closeSettings();
    showLockScreen(false);
  });
}

// ── Init & Session Hydration ─────────────────────────────────────────────────

async function init() {
  // Master PIN brute-force lockout check
  await checkPinLockout();

  // Active tab safety check and event wiring
  await checkActiveTabSafety();

  if (chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(() => {
      checkActiveTabSafety();
    });
  }

  if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (tab?.active) {
        checkActiveTabSafety();
      }
    });
  }

  // 1. Inspect session storage for active credentials & cached state
  const session = await chrome.storage.session.get([
    SESSION_KEYS.UNLOCKED,
    SESSION_KEYS.SESSION_PIN,
    SESSION_KEYS.POPUP_STATE,
  ]);

  const hasActiveSession = Boolean(session[SESSION_KEYS.UNLOCKED] || session[SESSION_KEYS.SESSION_PIN]);
  if (hasActiveSession) {
    // Session credentials exist — immediately bypass PIN lock
    hideLockScreen();
    await loadSavedKeys();
  } else {
    // Check if encrypted vault exists in local storage
    const local = await chrome.storage.local.get([STORAGE_KEYS.ENCRYPTED_VAULT]);
    if (local[STORAGE_KEYS.ENCRYPTED_VAULT]) {
      showLockScreen(false); // Unlock mode
    } else {
      showLockScreen(true);  // Initial setup mode
    }
  }

  // 2. Hydrate cached UI state
  const cached = session[SESSION_KEYS.POPUP_STATE];
  if (cached && typeof cached === 'object') {
    Object.assign(currentPopupState, cached);
  }

  // Restore model dropdown & custom model input
  if (currentPopupState.model) {
    modelSelect.value = currentPopupState.model;
  } else {
    await restoreLastModel();
  }
  updateRecommendedBadge(modelSelect.value);
  toggleCustomModelInput(modelSelect.value);

  if (currentPopupState.customModel) {
    customModelInput.value = currentPopupState.customModel;
  }

  // Restore token count, recommendation, and context preview
  if (currentPopupState.tokens != null && currentPopupState.tokens > 0) {
    tokenCounter.textContent = currentPopupState.tokens.toLocaleString();
  }
  if (currentPopupState.recommendedModel && currentPopupState.recommendedModel !== '—') {
    recommendedBadge.textContent = currentPopupState.recommendedModel;
  }
  if (currentPopupState.extractedContext) {
    tokenCounter.title = currentPopupState.extractedContext.slice(0, 500);
  }

  // Restore model fulfillment badge
  if (currentPopupState.modelBadge) {
    modelBadge.textContent = currentPopupState.modelBadge;
    modelBadge.hidden = !currentPopupState.modelBadgeVisible;
  } else {
    modelBadge.hidden = true;
  }

  // Restore response & streaming state
  if (currentPopupState.isStreaming) {
    responseContainer.textContent = currentPopupState.responseText || '';
    responseContainer.hidden = false;
    responseContainer.classList.add('streaming');
    relayBtn.disabled = true;
    stopBtn.disabled  = false;
    if (currentPopupState.statusMessage) {
      showStatus(relayStatus, currentPopupState.statusMessage, currentPopupState.statusType || '');
    }

    // Re-attach to background stream port
    try {
      relayPort = chrome.runtime.connect({ name: 'relay-port' });
      setupPortListeners(relayPort);
      try {
        relayPort.postMessage({ type: 'RECONNECT' });
      } catch (postErr) {
        console.warn('[Synapse] Failed to send RECONNECT on port:', postErr);
      }
    } catch (err) {
      console.warn('[Synapse] Failed to re-attach to stream port:', err);
      relayBtn.disabled = isCurrentTabRestricted;
      stopBtn.disabled  = true;
      updatePopupState({ isStreaming: false });
    }
  } else if (currentPopupState.responseText) {
    responseContainer.textContent = currentPopupState.responseText;
    responseContainer.hidden = false;
    responseContainer.classList.remove('streaming');
    relayBtn.disabled = isCurrentTabRestricted;
    stopBtn.disabled  = true;
    if (currentPopupState.statusMessage) {
      showStatus(relayStatus, currentPopupState.statusMessage, currentPopupState.statusType || '');
    }
  }
}

init();
