import { describe, expect, it } from "vitest";
import { parseConvexJson } from "./convexOutput";

describe("Convex CLI output parsing", () => {
	it("parses a JSON object with nested braces and trailing CLI text", () => {
		expect(
			parseConvexJson(
				[
					"Running function...",
					'{ "page": [{ "text": "brace } inside string", "items": [1, 2] }], "isDone": true }',
					"Function ran successfully.",
				].join("\n"),
			),
		).toEqual({
			page: [{ text: "brace } inside string", items: [1, 2] }],
			isDone: true,
		});
	});

	it("skips incomplete JSON-looking prefixes", () => {
		expect(parseConvexJson("partial { nope\n[1, 2, 3]\n")).toEqual([1, 2, 3]);
	});
});
