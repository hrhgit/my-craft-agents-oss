# Extension Capability Composition

## Purpose

Mortise Extensions compose through versioned public capabilities. Extension packages remain independently installable and isolated; capability contracts connect providers, consumers, and compatibility Extensions without inheritance or access to private runtime objects.

## Manifest V1

`pi.extensions[].manifest` accepts two optional maps:

```json
{
  "provides": {
    "search.query": {
      "version": "1.0.0",
      "scope": "session",
      "service": {
        "operations": {
          "query": {
            "inputSchema": { "type": "object" },
            "outputSchema": { "type": "object" }
          }
        }
      },
      "ui": { "modules": ["results"], "frontends": ["panel"] }
    }
  },
  "uses": {
    "search": {
      "capability": "search.query",
      "version": "^1.0.0",
      "required": true,
      "facets": ["service", "ui"]
    }
  }
}
```

Capability and operation IDs are stable lowercase identifiers. Provided versions are exact semantic versions; consumed versions are semantic-version ranges. `required` defaults to true. `provider` may pin an Extension ID. `ui.modules` and `ui.frontends` reference IDs declared by the same package's UI V2 manifest.

Package `dependencies` continue to express exact Extension package requirements and load ordering. `uses` expresses capability requirements. Existing `capabilities` continue to declare host-owned capabilities and do not grant or publish Extension services.

## Provider Resolution

The resolver validates manifests before activating Extensions, then resolves each consumer alias against providers visible in the same runtime hierarchy. Session resolves Session, Workspace, then Global; Workspace resolves Workspace then Global; Global resolves Global only.

Pinned providers must match the requested capability, version, facets, and lifetime. Unpinned uses require exactly one match. No match is missing; more than one match is ambiguous. Required failures block only the consumer. Optional failures create a degraded binding. Required capability cycles block their members; optional edges do not participate in activation cycles.

## Service Runtime

Pi exposes `pi.services.provide(capabilityId, implementation)` and `pi.services.use(alias)`. A provider may implement only operations declared in its manifest and must implement every declared service operation. A handle resolves lazily and exposes `invoke(operation, input, { signal, timeoutMs, onProgress })`.

Input is validated immediately before provider execution and output immediately after it. Results distinguish success, unavailable, unsupported, cancelled, timed out, validation failure, and provider failure. Provider replacement invalidates old handles. An in-flight call settles against the provider generation that accepted it and is never silently replayed against a replacement.

The Extension-service protocol is independent from host-owned `CapabilityRequestV1`. It carries catalog snapshots, binding diagnostics, invocation identity, provider/runtime generation, progress, cancellation, and settlement as serializable DTOs.

## UI Facets

UI modules and frontends share capability identity and provider resolution with services, but retain browser-style loading. Existing `dependencies.extension(extensionId).module(moduleId)` remains supported. `dependencies.use(alias).module(moduleId)` loads a module from the provider selected for that consumer alias and rejects unavailable or undeclared UI facets.

Frontend placement and lifecycle remain governed by Extension UI V2. A capability binding does not let one Extension reposition another Extension's frontend or access its private DOM.

## Validation CLI

`mortise-ui` mounts multiple development packages into its disposable profile and validates their complete capability graph without consulting unrelated global Extensions. It exposes `extension-services list`, `describe`, and `invoke`; every public service operation with valid schemas is callable through this development-only control plane.

CLI invocations travel through the real Pi service registry. They require a live Session where the selected scope needs one, include provider and runtime identity, validate input/output, support timeout and cancellation, and produce scenario-level receipts and evidence. Workflow V1 supports an `extension-service` step for resumable service validation; visible UI remains validated through normal extension snapshot/action/scenario/evidence operations.

