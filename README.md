[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
# PrivAgent
<img width="250" height="376" alt="b3cd12a67926ac6111c291160d395300" src="https://github.com/user-attachments/assets/bdba4197-3a21-4000-8d89-e6a63fcd569b" />

PrivAgent is a Chrome extension that overlays Gmail with instant, privacy-preserving AI summaries. Incoming mail is anonymized locally before it ever leaves the browser, then sent to your preferred OpenAI-compatible endpoint to create concise recaps, action flags, and suggested labels—without exposing sensitive data.

## Demo Video
[![Watch the demo](https://img.youtube.com/vi/Sfu7we0LLXE/0.jpg)](https://youtu.be/Sfu7we0LLXE)

## Highlights
- **Secure by design**: Names, addresses, IDs, and other identifiers are masked via the built-in `lib/anonymizer.js` engine before any model call.
- **Bring your own LLM**: Point the popup settings to any Chat Completions–compatible endpoint (OpenAI, Azure OpenAI, self-hosted) and model.
- **Gmail-native UX**: Hover over a thread row in Gmail for summaries, auto-labeled types, and one-click label application.
- **OAuth with principle of least privilege**: Uses `chrome.identity` with Gmail `readonly`/`modify` scopes; tokens live in Chrome and can be revoked at any time.
- **Cache awareness**: Local caches store anonymization mappings per thread to keep summaries consistent while protecting raw content.

## How It Works
1. **Authenticate**: The popup triggers Google OAuth and stores access tokens using Chrome's identity API.
2. **Fetch email**: `background.js` calls the Gmail REST API, pulls headers and bodies, and normalizes MIME parts.
3. **Anonymize**: The hybrid NLP/regex engine in `lib/anonymizer.js` swaps PII for placeholders (`{{PERSON_1}}`, `{{EMAIL_2}}`, etc.).
4. **Summarize**: Masked text, thread metadata, and inferred context flow to your configured Chat Completions endpoint (`gpt-4o` by default).
5. **Render**: `content.js` injects an overlay tooltip inside Gmail that shows the model's summary, detected type, action-needed flag, and an optional label button. Placeholders are restored client-side only for display.

## Prerequisites
- Google Chrome 119+ (Manifest V3 support).
- Google Cloud project with Gmail API enabled and an OAuth client ID for Chrome extensions.
- OpenAI-compatible endpoint and API key (for OpenAI, Azure OpenAI, or proxy services).

## Setup

### 1. Configure Google OAuth
1. In the [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the Gmail API.
2. Create OAuth 2.0 credentials of type **Chrome App** and note the client ID.
3. Replace the placeholder values in `PrivAgent-for-Chrome/manifest.json`:
   - `key`: optional extension key (remove or replace with your published key).
   - `oauth2.client_id`: set to your OAuth client ID.
   - `oauth2.scopes`: leave as provided unless you tighten permissions.

### 2. Load the extension locally
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `PrivAgent-for-Chrome` folder.
3. Confirm that the extension appears with the PrivAgent icon and popup.

### 3. Provide an LLM endpoint
1. Click the PrivAgent toolbar icon.
2. In **Settings**, enter your Chat Completions endpoint, preferred model (e.g. `gpt-4o`), and API key.
3. Save settings; you can clear them or purge cached anonymizer memory from the same panel.

### 4. Sign in and test
1. Press **Sign in with Google** in the popup and complete OAuth.
2. Visit Gmail and hover over a thread. A tooltip appears with the summary, suggested label, and action flag if confidence exceeds 0.6.
3. Click **Add label** to apply the suggested Gmail label directly from the tooltip.

## Project Layout

```
PrivAgent-for-Chrome/
├── manifest.json           # Extension manifest (MV3, permissions, OAuth config)
├── background.js           # Gmail API access, anonymization pipeline, OpenAI calls
├── content.js              # Gmail DOM integration, tooltip UI, label actions
├── popup.html/.css/.js     # Toolbar popup UI, auth + endpoint configuration
├── style.css               # Tooltip styling injected into Gmail
└── lib/
	├── anonymizer.js       # Regex + NLP masking engine built atop compromise.js
	└── compromise.js       # Bundled compromise NLP library
```

## Privacy Mechanics
- **Mask-first policy**: No raw text leaves the browser. All remote calls use placeholder tokens generated per session.
- **Placeholder mapping**: `background.js` restores masked content only after the model response returns, keeping tokens deterministic while avoiding accidental leaks.
- **User control**: Clear the anonymizer cache from the popup to flush learned placeholder mappings.

## Development Notes
- The project is plain JavaScript (no bundler). Update files directly and reload the extension from `chrome://extensions`.
- When adjusting anonymization rules, extend `REGEX_RULES` or the compromise-driven entity detection in `lib/anonymizer.js`.
- To target other providers, adapt the API client in `background.js` while preserving the masking flow.

## Troubleshooting
- **Sign-in loops**: Use the popup's **Sign out** button, then remove cached tokens via `chrome://settings/clearBrowserData` if needed.
- **401 or `AUTH_REQUIRED`**: The Gmail token expired—trigger sign-in again.
- **`OPENAI_CONFIG_REQUIRED`** messages**: Ensure the endpoint includes `/chat/completions` and the API key is valid.
- **Tooltip not appearing**: Verify you are on `mail.google.com` in the standard Gmail interface; Inbox view layouts or heavily customized themes may require tweaks in `content.js` selectors.

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

(c) 2025 Yifan Xu, Jietong Zhou, Yihang Zou, Yuchu Guo.
