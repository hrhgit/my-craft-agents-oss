import { describe, expect, it } from "vitest";
import { HostFacadeError, normalizeHostThinkingLevel } from "../src/core/host-facade.ts";

const CURRENT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

describe("normalizeHostThinkingLevel", () => {
	it("accepts every current host thinking level unchanged", () => {
		for (const level of CURRENT_LEVELS) {
			expect(normalizeHostThinkingLevel(level)).toBe(level);
		}
	});

	it("returns undefined for undefined input", () => {
		expect(normalizeHostThinkingLevel(undefined)).toBeUndefined();
	});

	it("rejects the retired 'max' value as invalid host/runtime input", () => {
		// Mutation guard: if the max -> xhigh alias is reintroduced, the call
		// resolves to "xhigh" instead of throwing, and these expectations fail.
		expect(() => normalizeHostThinkingLevel("max")).toThrow(HostFacadeError);
		expect(() => normalizeHostThinkingLevel("max")).toThrow(/Invalid thinking level: max/);
	});

	it("rejects the retired 'think' value as invalid host/runtime input", () => {
		// Mutation guard: if a think -> medium alias is reintroduced, this fails.
		expect(() => normalizeHostThinkingLevel("think")).toThrow(HostFacadeError);
		expect(() => normalizeHostThinkingLevel("think")).toThrow(/Invalid thinking level: think/);
	});

	it("rejects unknown and case-variant values", () => {
		expect(() => normalizeHostThinkingLevel("ultra")).toThrow(HostFacadeError);
		expect(() => normalizeHostThinkingLevel("Medium")).toThrow(HostFacadeError);
		expect(() => normalizeHostThinkingLevel("OFF")).toThrow(HostFacadeError);
	});

	it("reports invalid_input with a message naming the offending value", () => {
		try {
			normalizeHostThinkingLevel("max");
			throw new Error("expected normalizeHostThinkingLevel to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(HostFacadeError);
			expect((error as HostFacadeError).errorKind).toBe("invalid_input");
			expect((error as Error).message).toContain("max");
		}
	});
});
