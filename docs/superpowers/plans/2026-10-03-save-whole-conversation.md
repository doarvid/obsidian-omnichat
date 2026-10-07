# Save Whole Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Save chat" action to OmniChat that saves the current whole conversation as Markdown by injecting ai.js into the webview and reusing its adapters.

**Architecture:** esbuild bundles the ai.js userscript source as a string. `AIChatView` injects it (with `window.__OMNICHAT_HOST__=true`) on webview `dom-ready`; ai.js skips its own floating button and exposes `window.__AfterChat.getCurrentConversationMarkdown()`. The plugin calls that hook via `webview.executeJavaScript()`, then writes the result through the existing `SaveDestinationModal`.

**Tech Stack:** TypeScript (strict), Obsidian Plugin API, Electron `<webview>`, esbuild, Vitest.

## Global Constraints

- Desktop only; no mobile layers.
- No `innerHTML` in plugin code — build DOM imperatively (`createEl`).
- Sentence-case UI text (`eslint-plugin-obsidianmd`).
- Never suppress type errors (`as any`, `@ts-ignore`).
- `ai.js` is AGPL-3.0; preserve its license header verbatim when editing.
- Spec: `docs/superpowers/specs/2026-10-03-save-whole-conversation-design.md`.

---

### Task 1: ai.js programmatic hook + `initialize()` gate

**Files:**
- Modify: `ai.js` (place hook after the `PLATFORM_ADAPTERS` array and helper defs, immediately before `function initialize()`; gate inside `initialize`)

**Interfaces:**
- Produces: `window.__AfterChat.getCurrentConversationMarkdown(): Promise<{ok:true,title:string,platform:string,markdown:string} | {ok:false,reason:'no-conversation'|'unsupported'|'error',message?:string}>`

- [ ] **Step 1: Insert the hook before `function initialize()`**

```js
  // ---- OmniChat embedding hook -----------------------------------------------
  // When injected into the OmniChat webview the host sets window.__OMNICHAT_HOST__;
  // the userscript then skips its own floating button and exposes this API, which
  // the plugin calls through webview.executeJavaScript().
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
```

- [ ] **Step 2: Gate `initialize()` on the host flag**

```js
  function initialize() {
    if (window.__OMNICHAT_HOST__) return;   // embedded in OmniChat: plugin drives export
    const adapter = PLATFORM_ADAPTERS.find((p) => p.detect());
    // ...unchanged rest...
```

- [ ] **Step 3: Verify syntax and hook presence**

Run:
```bash
node --check ai.js && grep -c "__OMNICHAT_HOST__" ai.js && grep -c "getCurrentConversationMarkdown" ai.js
```
Expected: no syntax error; `2`; `1`.

---

### Task 2: Build plumbing (esbuild raw import) + pure injection builder

**Files:**
- Modify: `esbuild.config.mjs`
- Create: `src/types/afterchat-raw.d.ts`
- Create: `src/afterchat.ts`
- Test: `src/__tests__/afterchat.test.ts`

**Interfaces:**
- Produces: `buildInjectionScript(source: string): string`, `OMNICHAT_HOST_FLAG: string` (from `src/afterchat.ts`).
- Produces: default-export string module `"afterchat-raw"`.

- [ ] **Step 1: Write the failing test** (`src/__tests__/afterchat.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { buildInjectionScript, OMNICHAT_HOST_FLAG } from "../afterchat";

describe("buildInjectionScript", () => {
	it("prefixes the host flag and preserves the source", () => {
		const script = buildInjectionScript("var x = 1;");
		expect(script.startsWith(OMNICHAT_HOST_FLAG)).toBe(true);
		expect(script).toContain("var x = 1;");
		expect(OMNICHAT_HOST_FLAG).toBe("window.__OMNICHAT_HOST__=true;");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/afterchat.test.ts`
Expected: FAIL — cannot resolve `../afterchat`.

- [ ] **Step 3: Create `src/afterchat.ts`**

```ts
/** Global flag the ai.js userscript checks to skip mounting its own floating button. */
export const OMNICHAT_HOST_FLAG = "window.__OMNICHAT_HOST__=true;";

/** Builds the full script injected into the webview on dom-ready. */
export function buildInjectionScript(source: string): string {
	return OMNICHAT_HOST_FLAG + "\n" + source;
}
```

- [ ] **Step 4: Create `src/types/afterchat-raw.d.ts`**

```ts
declare module "afterchat-raw" {
	const source: string;
	export default source;
}
```

- [ ] **Step 5: Add the esbuild `afterchat-raw` plugin**

Add near the top of `esbuild.config.mjs`:

```js
import { readFileSync } from 'node:fs';
```

Add to the `context({ ... })` options (e.g. after `entryPoints`):

```js
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

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/afterchat.test.ts`
Expected: PASS.

---

### Task 3: AIChatView — inject on dom-ready, add button + `saveConversation()`

**Files:**
- Modify: `src/views/AIChatView.ts` (imports; `mountWebview` dom-ready ~line 400; `buildContextBar` ~line 355; method near `saveSelection` ~line 823)

**Interfaces:**
- Consumes: `buildInjectionScript` (`../afterchat`), default `"afterchat-raw"`, `SaveDestinationModal` (existing), `getServiceKey` (existing).
- Produces: `saveConversation(): Promise<void>`.

- [ ] **Step 1: Add imports**

```ts
import afterchatSource from "afterchat-raw";
import { buildInjectionScript } from "../afterchat";
```

- [ ] **Step 2: Inject on dom-ready**

Inside the `wv.addEventListener("dom-ready", ...)` handler, after the existing `executeJavaScript` calls:

```ts
				void wv.executeJavaScript(buildInjectionScript(afterchatSource)).catch((err) => {
					console.warn("OmniChat: ai.js injection failed", err);
				});
```

- [ ] **Step 3: Add the "Save chat" button** (after the existing `saveBtn` block in `buildContextBar`)

```ts
		const saveChatBtn = right.createEl("button", { cls: "vc-save-btn", text: "Save chat" });
		saveChatBtn.title = "Save the whole conversation to your vault (via ai.js)";
		saveChatBtn.setAttribute("aria-label", "Save whole AI conversation to vault");
		saveChatBtn.addEventListener("click", () => void this.saveConversation());
```

- [ ] **Step 4: Add `saveConversation()`** next to `saveSelection()`

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
			false,
		).open();
	}
```

- [ ] **Step 5: Type-check + lint**

Run: `npm run build && npm run lint`
Expected: exit 0 (build succeeds, no new lint errors).

---

### Task 4: Verify end-to-end wiring

**Files:** none (verification only)

- [ ] **Step 1: Confirm the bundle carries the hook**

Run: `grep -c "__OMNICHAT_HOST__" main.js && grep -c "__AfterChat" main.js`
Expected: both `>= 1`.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: PASS (no regressions).

- [ ] **Step 3: Manual smoke test**

Load a supported service (e.g. Claude) in the OmniChat webview, open a conversation, click **Save chat**, choose "New note". Expected: note contains `# <title>` + conversation Markdown with `## Metadata` and `## Conversation`; no AfterChat floating button appears in the webview.

---

## Self-Review

- **Spec coverage:** ai.js hook/gate → Task 1; esbuild bundling + `src/afterchat.ts` + d.ts → Task 2; injection + button + `saveConversation` → Task 3; verification → Task 4. Licensing note in spec needs no code.
- **Placeholder scan:** none.
- **Type consistency:** `buildInjectionScript`/`OMNICHAT_HOST_FLAG` names match Tasks 2–3; hook result shape matches Tasks 1 and 3.
