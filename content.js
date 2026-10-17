/**
 * content.js — Synapse · ContextRelay
 *
 * Injected into the active tab by the background service worker.
 * Establishes a long-lived Port so the SW stays alive while extraction runs.
 *
 * Message protocol (background → content):
 *   { type: 'EXTRACT_CONTEXT' }
 *
 * Response protocol (content → background):
 *   { type: 'CONTEXT_RESULT', messages: Array<{ role, text }> }
 *   { type: 'CONTEXT_ERROR',  error: string }
 */

'use strict';

// ── ChatGPT DOM selectors ─────────────────────────────────────────────────────
//
// ChatGPT renders each turn as an <article> with a data-testid attribute
// of the form "conversation-turn-N".  Within each article:
//   • User messages live in a [data-message-author-role="user"] element.
//   • Assistant messages live in [data-message-author-role="assistant"].
//
// Fallback: older / A-B-test layouts use <div role="presentation"> rows with
// class-based selectors.  We attempt the canonical selector first and fall back
// to the legacy one so the script survives minor UI redesigns.

const SELECTORS = {
  // Canonical (2024-25 layout)
  TURN_ARTICLE:  'article[data-testid^="conversation-turn"]',
  ROLE_ATTR:     'data-message-author-role',
  // Inner content wrapper — avoids picking up action buttons / metadata
  CONTENT_BLOCK: '[data-message-author-role] .markdown, [data-message-author-role] p',

  // Legacy fallback
  LEGACY_TURN:   'div[class*="group"][data-testid]',
};

// ── Extraction logic ──────────────────────────────────────────────────────────

/**
 * Walk the ChatGPT DOM and return a structured message array.
 * @returns {{ role: 'user' | 'assistant', text: string }[]}
 * @throws  {Error} if no recognisable conversation structure is found.
 */
function extractChatGPTHistory() {
  // ── Strategy 1: canonical article-based layout ────────────────────────────
  const articles = document.querySelectorAll(SELECTORS.TURN_ARTICLE);

  if (articles.length > 0) {
    const messages = [];

    for (const article of articles) {
      const roleEl = article.querySelector(`[${SELECTORS.ROLE_ATTR}]`);
      if (!roleEl) continue;

      const rawRole = roleEl.getAttribute(SELECTORS.ROLE_ATTR);
      const role    = rawRole === 'user' ? 'user' : 'assistant';

      // Prefer the markdown wrapper; fall back to the entire roleEl text
      const contentEl = article.querySelector('.markdown') ??
                        article.querySelector('[class*="prose"]') ??
                        roleEl;

      const text = (contentEl.innerText ?? contentEl.textContent ?? '').trim();
      if (text) {
        messages.push({ role, text });
      }
    }

    if (messages.length > 0) return messages;
  }

  // ── Strategy 2: legacy / redesign layout ─────────────────────────────────
  //
  // Some A/B variants render turns inside div rows rather than <article> tags.
  // We look for any element with [data-message-author-role] directly.
  const roleNodes = document.querySelectorAll(`[${SELECTORS.ROLE_ATTR}]`);

  if (roleNodes.length > 0) {
    const messages = [];

    for (const node of roleNodes) {
      const rawRole = node.getAttribute(SELECTORS.ROLE_ATTR);
      // Skip unexpected roles (e.g. "tool", "system") — keep only user/assistant
      if (rawRole !== 'user' && rawRole !== 'assistant') continue;

      const contentEl = node.querySelector('.markdown') ??
                        node.querySelector('[class*="prose"]') ??
                        node;

      const text = (contentEl.innerText ?? contentEl.textContent ?? '').trim();
      if (text) {
        messages.push({ role: rawRole, text });
      }
    }

    if (messages.length > 0) return messages;
  }

  // ── No structure recognised ───────────────────────────────────────────────
  throw new Error(
    'DOM structure not recognised. ' +
    'This page may not be a ChatGPT conversation, ' +
    'or the UI layout has changed. ' +
    `(url: ${location.href})`
  );
}

// ── Port listener (keeps SW alive during extraction) ─────────────────────────

/**
 * The background service worker connects via this named port before sending
 * the EXTRACT_CONTEXT command.  Holding an open port prevents Manifest V3
 * from terminating the SW while we do DOM work.
 */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'content-extractor') return;

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'EXTRACT_CONTEXT') return;

    try {
      const messages = extractChatGPTHistory();
      try {
        port.postMessage({ type: 'CONTEXT_RESULT', messages });
      } catch (postErr) {
        console.warn('[Synapse] Failed to send CONTEXT_RESULT on port:', postErr);
      }
    } catch (err) {
      console.error('[Synapse] Extraction failed:', err);
      try {
        port.postMessage({
          type:  'CONTEXT_ERROR',
          error: err.message ?? String(err),
        });
      } catch (postErr) {
        console.warn('[Synapse] Failed to send CONTEXT_ERROR on port:', postErr);
      }
    }
  });

  // Clean up gracefully if the SW side disconnects first
  port.onDisconnect.addListener(() => {
    const lastErr = chrome.runtime.lastError;
    if (lastErr) {
      console.warn('[Synapse] content-extractor port disconnected:', lastErr.message);
    }
  });
});
