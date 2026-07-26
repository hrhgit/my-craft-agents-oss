/**
 * Canonical Mortise Automations protocol, store, scheduler, and runtime.
 */

// Condition evaluator
export { evaluateConditions, type ConditionContext } from './conditions.ts';

// Unified Automations V3 protocol and runtime
export * from './v3-types.ts';
export { AutomationTriggerV3Schema, AutomationActionV3Schema, AutomationDefinitionV3Schema, AutomationRunV1Schema, AutomationsDocumentV3Schema, CloudEventV1Schema, parseAutomationRunV1, parseAutomationsDocumentV3, parseCloudEventV1 } from './v3-schemas.ts';
export { AutomationV3Store, automationIdentity, type AutomationV3StoreOptions, type AcceptCloudEventOptions } from './v3-store.ts';
export { AutomationV3Runtime, type AutomationV3RuntimeOptions, type AutomationEventDispatchResultV1 } from './v3-runtime.ts';
export { AutomationWorkspaceHostV3, type AutomationWorkspaceHostV3Options } from './v3-host-runtime.ts';
export { createAutomationAsyncApiDocumentV1, type AutomationAsyncApiDocumentOptionsV1 } from './v3-asyncapi.ts';
