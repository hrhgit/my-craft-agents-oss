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

describe("workspace content extension UI public types", () => {
	it("exports workspace.content and its host-owned tab metadata", () => {
		expectTypeOf(contribution.surface).toEqualTypeOf<"workspace.content">();
		expectTypeOf<"workspace.content">().toMatchTypeOf<ExtensionUISurface>();
		expect(contribution.workspaceContent).toEqual(metadata);
	});
});
