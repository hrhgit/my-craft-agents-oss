import type {
	ExtensionUIContribution,
	ExtensionUISurface,
	ExtensionWorkspaceContentMetadataV1,
} from "@mortise/pi-coding-agent";
import { describe, expect, expectTypeOf, it } from "vitest";

const metadata = {
	title: "Deployments",
	icon: "activity",
	scope: "workspace",
	instancePolicy: "singleton",
	preferredGroup: "adjacent",
} satisfies ExtensionWorkspaceContentMetadataV1;

const contribution = {
	schemaVersion: 1,
	id: "deployment-inspector",
	surface: "workspace.content",
	workspaceContent: metadata,
	content: { type: "text", text: "Ready" },
} satisfies ExtensionUIContribution;

const responsiveContribution = {
	schemaVersion: 1,
	id: "responsive-status",
	surface: "conversation.inline",
	overflow: "scroll",
	content: {
		type: "responsive",
		full: { type: "text", text: "A full status" },
		compact: { type: "badge", label: "Status", tone: "info" },
		minimal: { type: "icon", name: "activity", label: "Status" },
	},
} satisfies ExtensionUIContribution;

describe("workspace content extension UI public types", () => {
	it("exports workspace.content and its host-owned tab metadata", () => {
		expectTypeOf(contribution.surface).toEqualTypeOf<"workspace.content">();
		expectTypeOf<"workspace.content">().toMatchTypeOf<ExtensionUISurface>();
		expect(contribution.workspaceContent).toEqual(metadata);
	});

	it("exports responsive variants and bounded scroll overflow", () => {
		expectTypeOf(responsiveContribution.content.type).toEqualTypeOf<"responsive">();
		expect(responsiveContribution.overflow).toBe("scroll");
	});
});
