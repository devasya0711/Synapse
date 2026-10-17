# Chrome Web Store Listing & Compliance Asset — Synapse · ContextRelay

> This document contains all listing copy, metadata, and permission rationale ready for copy-pasting into the Chrome Developer Dashboard during extension submission.

---

## 1. Quick Metadata Overview

| Field | Content | Limit / Notes |
| :--- | :--- | :--- |
| **Extension Name** | `Synapse - ContextRelay` | Matches `manifest.json` (Max 75 chars) |
| **Version** | `1.0.0` | Matches `manifest.json` |
| **Primary Category** | `Productivity` | Secondary: `Developer Tools` |
| **Single-Line Summary** | `Securely extract, encrypt, and relay active webpage context to leading AI models with real-time streaming.` | 106 chars (Max 132 chars) |
| **Single Purpose Statement** | `Extracts webpage text on-demand and relays it directly to user-selected AI language model APIs using client-side encrypted credentials.` | Required for CWS Review Team |
| **Primary Language** | `English` | |
| **Privacy Policy URL** | `https://github.com/devasya0711/Synapse/blob/main/PRIVACY_POLICY.md` | Must be a public, live URL |
| **Support URL / Email** | `https://github.com/devasya0711/Synapse/issues` / `devasya.work@gmail.com` | |

---

## 2. Store Listing Description

*Copy and paste the plain-text section below into the Chrome Web Store "Detailed Description" field (Markdown formatting has been intentionally converted to clean plain-text typography with line breaks and unicode bullet points for native Web Store rendering).*

```text
Securely extract, encrypt, and relay active webpage context directly to leading AI models with real-time streaming.

Synapse · ContextRelay is a privacy-first browser bridge that extracts discussion context from web pages (such as ChatGPT, Claude, forum threads, articles, or documentation) and relays it to your preferred AI model—completely on-device with zero-knowledge encryption.

No subscription. No tracking. No middleman servers. Bring your own API keys and stream responses directly from official provider endpoints.


KEY FEATURES

• One-Click Context Extraction
Intelligently captures conversational structure and readable text from the active webpage on demand, suppressing unwanted ads, footers, and page clutter.

• Leading Multi-Provider Support
Switch effortlessly between OpenAI (GPT-4o, GPT-4o-mini, o1), Anthropic (Claude 3.7 Sonnet, Claude 3 Opus), Google (Gemini 2.0 Flash, Gemini 1.5 Pro), and Groq (Llama 3.3 70B, Llama 3.1 8B), or connect custom OpenAI-compatible models.

• Real-Time Incremental Streaming
Stream tokens directly into the popup container via Server-Sent Events (SSE). Pause, stop, or copy responses instantly.

• Intelligent Model Recommendations
Analyzes extracted context in real-time and recommends optimal model archetypes (e.g., suggests Claude for code-heavy context or Gemini for long-context documents).

• Automated PII Redaction
Built-in client-side privacy scrubber automatically redacts emails, IPv4/IPv6 addresses, bearer tokens, and API keys before prompt transmission.

• Smart Context Pruning
Monitors token consumption against model limits and automatically preserves the system instructions and the 3 most recent conversation turns while pruning bloated middle turns.

• Resilient Cascading Fallbacks
If your primary provider encounters HTTP 429 rate limits or server outages, Synapse automatically clears partial tokens and cascades to backup models without interrupting your workflow.

• Session Rehydration
Close and reopen the popup at any time—Synapse automatically reconnects to in-flight streams without dropping data or re-prompting for your PIN.


ZERO-KNOWLEDGE SECURITY ARCHITECTURE

Synapse is built on a 100% client-side, zero-knowledge architecture:

1. Master PIN Authentication: Your 4-digit Master PIN derives a 256-bit encryption key using PBKDF2 with 600,000 iterations of SHA-256 and a cryptographically secure 16-byte random salt.
2. AES-GCM 256-bit Vault: All API keys stored on your machine are encrypted with 256-bit AES-GCM authenticated encryption.
3. Ephemeral In-Memory Keys: Decrypted keys exist solely in temporary browser memory (chrome.storage.session). They are never written to disk, never logged to the console, and vanish when you close Chrome or click Lock.
4. Brute-Force Lockout: Protects against unauthorized local access by enforcing a strict 30-second lockout after 5 consecutive incorrect PIN attempts.


HOW TO USE

1. Click the Synapse icon in the Chrome toolbar.
2. Set your 4-digit Master PIN on first launch.
3. Open Settings and enter your personal API keys for your preferred providers (OpenAI, Anthropic, Gemini, or Groq).
4. Navigate to any webpage or web chat and click "Relay Context".
5. Watch responses stream in real-time, switch models on the fly, or export answers with one click.


BRING YOUR OWN KEY (BYOK) INSTRUCTIONS

Synapse operates entirely on your own API keys. You only pay provider wholesale rates for the tokens you actually use:
• OpenAI: https://platform.openai.com/api-keys
• Anthropic: https://console.anthropic.com/settings/keys
• Google Gemini: https://aistudio.google.com/app/apikey
• Groq: https://console.groq.com/keys


PERMISSIONS OVERVIEW

• "tabs": Used strictly to verify that the active tab is a valid webpage and prevent injection on restricted browser settings pages (chrome://, about:).
• "scripting": Injects the context extractor on-demand only when you click "Relay Context".
• "storage": Saves your encrypted vault locally and keeps unlocked keys in temporary browser memory.
• "activeTab": Restricts context extraction exclusively to the tab you are currently viewing.


SUPPORT & OPEN SOURCE

Synapse is open source under the MIT License.
• Source Code: https://github.com/devasya0711/Synapse
• Bug Reports & Feature Requests: https://github.com/devasya0711/Synapse/issues
• Contact: devasya.work@gmail.com
```

---

## 3. Chrome Developer Dashboard Permission Justifications

*Copy-paste these tailored rationales directly into the "Permissions Justification" text areas in the Chrome Developer Dashboard.*

### Permission: `"tabs"`
> **Justification:**  
> The `"tabs"` permission is strictly used to inspect the active tab's URL (`tab.url`) when the user opens the popup or clicks the "Relay Context" button. This is required to enforce essential browser safety boundaries: Synapse immediately detects if the user is on an internal, privileged, or restricted URL (e.g., `chrome://`, `chrome-extension://`, `about:`, or the Chrome Web Store) and gracefully suppresses DOM extraction without throwing runtime errors. It then displays an inline warning banner instructing the user to switch to a standard webpage. Without `"tabs"`, `tab.url` returns undefined under Manifest V3, making safety boundary enforcement impossible.

---

### Permission: `"scripting"`
> **Justification:**  
> The `"scripting"` permission is used via `chrome.scripting.executeScript` to programmatically inject the context extraction content script into the active tab on-demand when the user clicks the "Relay Context" button. In accordance with the Chrome Web Store Minimum Permissions Policy, Synapse does not register persistent background content scripts on all URLs. Instead, the script is injected only when explicitly requested by the user, minimizing resource usage and ensuring the extension interacts with page content strictly upon user intent.

---

### Permission: `"activeTab"`
> **Justification:**  
> The `"activeTab"` permission grants temporary, elevated execution rights to the currently active tab following an explicit user gesture (clicking the extension action or triggering the context relay). This ensures that on-demand extraction is strictly scoped to the tab the user is actively viewing and interacting with.

---

### Permission: `"storage"`
> **Justification:**  
> The `"storage"` permission is required to access `chrome.storage.local` and `chrome.storage.session`.  
> 1. `chrome.storage.local` stores the user's encrypted API key vault (ciphertext, PBKDF2 salt, and AES-GCM IV) along with the brute-force lockout counter (`lockoutUntil`) and UI preferences (such as the last selected model).  
> 2. `chrome.storage.session` is used for security-critical zero-knowledge handling: decrypted API keys and in-flight stream rehydration buffers exist only in ephemeral browser memory and are wiped automatically when the browser closes.

---

### Host Permissions: `https://*/*` and `http://*/*`
> **Justification:**  
> The broad host permissions are required for two fundamental technical capabilities:  
> 1. **Content Extraction Across Webpages:** Users rely on Synapse to extract discussion and research context from any standard HTTP or HTTPS website they are viewing (articles, documentation, community forums, web chat platforms). Restricting host permissions to a static domain list would break the core functionality of relaying context from user-directed research sites.  
> 2. **Direct Client-to-Cloud API Requests:** Synapse operates without an intermediary backend server. To deliver real-time streaming responses, the extension service worker must make direct HTTPS fetch requests to third-party AI provider endpoints chosen by the user (including `https://api.openai.com/*`, `https://api.anthropic.com/*`, `https://generativelanguage.googleapis.com/*`, `https://api.groq.com/*`, and custom OpenAI-compatible endpoints configured by developers).

---

## 4. Chrome Web Store Data Use Disclosures

*Reviewer questionnaire answers for the "Privacy Practices" tab in the Developer Dashboard:*

### Single Purpose Certification
- [x] **Yes**, I certify that this extension has a single, narrow, and clear purpose:  
  *“Extracts webpage text on-demand and relays it directly to user-selected AI language model APIs using client-side encrypted credentials.”*

### Data Collection Declarations

| Data Category | Declared | Explanation / Detail |
| :--- | :--- | :--- |
| **Personally Identifiable Info (PII)** | **No** | No names, email addresses, or personal identifiers are collected by the developer. All extracted text is processed on-device; automated regex redacts PII before prompt relay. |
| **Health Info** | **No** | Not collected. |
| **Financial / Payment Info** | **No** | Not collected. Users bring their own API keys; no payments are processed through the extension. |
| **Authentication Info** | **No** | Master PIN and provider API keys are encrypted client-side and never transmitted to developer servers. |
| **Personal Communications** | **No** | Prompts and responses are relayed directly between the user's browser client and their chosen AI provider. |
| **Location** | **No** | Not collected. |
| **Web History** | **No** | Browsing history is never tracked, recorded, or sent to developer servers. |
| **User Activity** | **No** | No analytics, telemetry, or clickstream tracking exists. |
| **Website Content** | **Yes** *(Disclose under Website Content)* | **Scope:** Webpage text is extracted temporarily from the active tab upon explicit user click of "Relay Context".<br>**Transmission:** Transmitted directly to the user's chosen third-party AI provider (OpenAI, Anthropic, Google, Groq) via official APIs.<br>**Developer Access:** 0% developer access; no data is ever routed through or stored on developer infrastructure. |

### Chrome Web Store Certifications
- [x] **I certify that data is not sold to third parties.**
- [x] **I certify that data is not used or transferred for purposes that are unrelated to the item's core functionality.**
- [x] **I certify that data is not used or transferred to determine creditworthiness or for lending purposes.**

---

## 5. Pre-Submission Package Checklist

Before uploading the extension `.zip` to the Chrome Developer Dashboard:

- [x] `manifest.json` uses Manifest V3 (`manifest_version: 3`).
- [x] `version` set to `1.0.0` and `name` matches listing (`Synapse - ContextRelay`).
- [x] Standard icon suite created and verified in `icons/` (`16x16`, `32x32`, `48x48`, `128x128`).
- [x] `icons` and `action.default_icon` registered in `manifest.json`.
- [x] Automated test suites pass with 100% pass rate (`test_suite_1_crypto`, `test_suite_2_tab_safety_scraping`, `test_suite_3_streaming_cascading`, `test_suite_5_rehydration`).
- [x] `PRIVACY_POLICY.md` committed and pushed to public repository.
- [x] Build zip excludes `.git/`, `scripts/`, test files, and local logs.
