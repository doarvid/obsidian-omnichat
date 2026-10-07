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
