/** Global flag the ai.js userscript checks to skip mounting its own floating button. */
export const OMNICHAT_HOST_FLAG = "window.__OMNICHAT_HOST__=true;";

/** Builds the full script injected into the webview on dom-ready. */
export function buildInjectionScript(source: string): string {
	return OMNICHAT_HOST_FLAG + "\n" + source;
}
