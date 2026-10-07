# Save whole conversation (OmniChat ↔ ai.js injection)

- **Date:** 2026-10-03
- **Status:** Approved (design), pending implementation plan
- **Route:** A — inject ai.js into the webview (fidelity first)

## Context

OmniChat embeds AI chat sites in an Electron `<webview>` and can save **the user's
current text selection** to the vault (`AIChatView.saveSelection()` →
`SaveDestinationModal`). It cannot save a full conversation.

`ai.js` (AfterChat, AGPL-3.0, untracked reference file at repo root) already has 30+
per-platform adapters that fetch a whole conversation via same-origin APIs and render it
as Markdown (Metadata / Thought Process / References).

## Goal

Add a **"Save chat"** action to OmniChat that saves the **current whole conversation** as
Markdown, reusing ai.js's adapters verbatim so fidelity matches AfterChat. The generated
Markdown is written through the existing `SaveDestinationModal` (new note / append /
insert-at-cursor).

## Non-goals

- Batch export of all/selected conversations to the vault (ai.js supports it; not v1).
- Ollama native chat UI (no webview, no ai.js adapter).
- Editing ai.js adapters or its Markdown format.
- Any new settings.

## Design

### 1. ai.js — add a programmatic hook and suppress its own UI

Add a `window.__AfterChat` hook (usable regardless of host, but only driven by the
plugin) and gate `initialize()` so the userscript does not mount its floating button when
embedded.

```js
// (place after PLATFORM_ADAPTERS / helper definitions, before initialize)
window.__AfterChat = {
  hasAdapter: () => PLATFORM_ADAPTERS.some((p) => p.detect()),
  async getCurrentConversationMarkdown() {
    const adapter = PLATFORM_ADAPTERS.find((p) => p.detect());
    if (!adapter || typeof adapter.toMarkdown !== 'function') {
      return { ok: false, reason: 'unsupported' };
    }
    let id = null;
    try {
      id = adapter.getCurrentConversationId ? adapter.getCurrentConversationId() : null;
    } catch (e) { id = null; }
    if (!id) return { ok: false, reason: 'no-conversation' };
    try {
      const data = await adapter.getConversationDetails(id);
      if (data?.store) delete data.store.zeroQuery;
      const title = getChatTitle(data, '当前对话');
      const markdown = adapter.toMarkdown(data, title, id);
      return { ok: true, title, platform: adapter.name, markdown };
    } catch (err) {
      return { ok: false, reason: 'error', message: (err && err.message) || String(err) };
    }
  },
};

function initialize() {
  if (window.__OMNICHAT_HOST__) return; // embedded: plugin drives export, no floating button
  // ...unchanged...
}
```

Adapters, `toMarkdown`, `getChatTitle`, `PLATFORM_ADAPTERS` are untouched.

### 2. Build — bundle ai.js source as a string

esbuild `onLoad` plugin in `esbuild.config.mjs` reads `ai.js` and exports it as a default
string. Single source of truth; ships inside `main.js` (release pipeline unchanged).

```js
import { readFileSync } from 'node:fs';
// inside build config:
plugins: [{
  name: 'afterchat-raw',
  setup(build) {
    build.onResolve({ filter: /^afterchat-raw$/ }, () => ({ path: 'afterchat-raw', namespace: 'afterchat' }));
    build.onLoad({ filter: /.*/, namespace: 'afterchat' }, () => ({
      contents: `export default ${JSON.stringify(readFileSync(new URL('./ai.js', import.meta.url), 'utf8'))}`,
      loader: 'js',
    }));
  },
}],
```

Ambient type declaration `src/types/afterchat-raw.d.ts`:

```ts
declare module "afterchat-raw" {
  const source: string;
  export default source;
}
```

### 3. New tiny module — `src/afterchat.ts`

```ts
import afterchatSource from "afterchat-raw";

/** Flag the userscript checks to skip mounting its own floating button. */
export const OMNICHAT_HOST_FLAG = "window.__OMNICHAT_HOST__=true;";

/** Full script injected into the webview on dom-ready. */
export function getAfterChatInjectionScript(): string {
  return OMNICHAT_HOST_FLAG + "\n" + afterchatSource;
}
```

### 4. Injection — `AIChatView.mountWebview()` dom-ready

After the existing stealth / scroll-fix injections (AIChatView.ts ~401):

```ts
void wv.executeJavaScript(getAfterChatInjectionScript()).catch((err) => {
  console.warn("OmniChat: ai.js injection failed", err);
});
```

Idempotent (re-injection on navigation just re-assigns the hook). Ollama never reaches a
webview `dom-ready`, so no extra guard is needed.

### 5. Plugin action — new toolbar button

Add `vc-save-chat-btn` ("Save chat") next to the existing `Save` in `buildContextBar()`.
Reuse the existing `Save` button's classes/styling so no new CSS is strictly required
(add a `styles.css` rule only if the shared class doesn't fit).

```ts
async saveConversation(): Promise<void> {
  if (getServiceKey(this.activeUrl) === "ollama") {
    new Notice("Saving a whole conversation isn't supported for Ollama yet.");
    return;
  }
  if (!this.webview?.executeJavaScript) { new Notice("Chat view isn't ready yet."); return; }

  let res: unknown;
  try {
    res = await this.webview.executeJavaScript(
      "window.__AfterChat && window.__AfterChat.getCurrentConversationMarkdown"
        + " ? window.__AfterChat.getCurrentConversationMarkdown() : null",
    );
  } catch (err) {
    console.error("OmniChat: failed to read conversation", err);
    new Notice("Couldn't read the conversation — see console for details.");
    return;
  }

  const r = res as
    | { ok: true; title: string; platform: string; markdown: string }
    | { ok: false; reason: string; message?: string }
    | null;

  if (!r) { new Notice("Open a conversation in a supported AI site first."); return; }
  if (!r.ok) {
    if (r.reason === "no-conversation") new Notice("Open a conversation first.");
    else if (r.reason === "unsupported") new Notice("This site isn't supported for whole-conversation save yet.");
    else new Notice(r.message || "Couldn't read the conversation.");
    return;
  }

  const body = /^#\s/.test(r.markdown) ? r.markdown : `# ${r.title}\n\n${r.markdown}`;
  new SaveDestinationModal(
    this.app,
    body,
    this.plugin.settings.saveNoteFolder,
    this.plugin.settings.useDateSubfolder,
    r.platform || null,
    /* formatEnabled */ false,
  ).open();
}
```

`formatEnabled = false` because ai.js output is already valid Markdown;
`formatAIResponseText()` targets raw clipboard text and would be a no-op-to-harmful here.

## Data flow

```
click "Save chat"
  → webview.executeJavaScript(hook call)
  → ai.js detects adapter, fetches conversation (same-origin cookies), toMarkdown()
  → { ok, title, platform, markdown } returned via structured clone
  → prepend "# title" if missing
  → SaveDestinationModal → app.vault.create / modify / editor.replaceSelection
```

## Files touched

| File | Change |
|---|---|
| `ai.js` | add `window.__AfterChat` hook; gate `initialize()` on `__OMNICHAT_HOST__`; track in git |
| `esbuild.config.mjs` | `afterchat-raw` onLoad plugin |
| `src/types/afterchat-raw.d.ts` | ambient module declaration (new) |
| `src/afterchat.ts` | injection-script builder (new) |
| `src/views/AIChatView.ts` | inject on dom-ready; add button + `saveConversation()` |
| `src/__tests__/afterchat.test.ts` | unit test (new) |

## Edge cases

- **List page / no conversation open** → `reason: 'no-conversation'` → "Open a conversation first."
- **Custom or unsupported host** → no adapter → `reason: 'unsupported'`.
- **`toMarkdown` throws** (e.g., empty data) → `reason: 'error'` with message.
- **CSP / executeJavaScript rejection** → caught → Notice.
- **Very long conversations** → large string via structured clone; acceptable for desktop.
- **Ollama** → explicit Notice; webview hook never runs.

## Licensing

`ai.js` is AGPL-3.0; `main.js` is MIT. Per decision, ai.js (with the hook edits) will be
committed to the repo and bundled into `main.js`, accepting the mixed-license risk. The
AGPL header in `ai.js` is preserved.

## Testing

- Unit: `getAfterChatInjectionScript()` contains `__OMNICHAT_HOST__` and `__AfterChat`.
- Manual: load each built-in service in the webview, open a conversation, click "Save
  chat", confirm the note matches AfterChat's `.md` output.

## Open questions

None.
