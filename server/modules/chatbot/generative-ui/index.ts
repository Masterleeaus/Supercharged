export { createBuilderRegistry, BuilderRegistryError, BUILDER_COLLECTIONS } from "./builder-registry.ts";
export type { BuilderRegistry, BuilderCatalogue, BuilderCollection } from "./builder-registry.ts";
export { normaliseSpec, repairSpec, isSupportedSurface, MAX_ELEMENTS, SUPPORTED_SURFACES } from "./spec-normaliser.ts";
export type { SpecChange } from "./spec-normaliser.ts";
export { validateSpec, isSafeKey, isSafePointer, pointerToken } from "./spec-validator.ts";
export type { SpecValidation, SpecIssue, IssueSeverity } from "./spec-validator.ts";
export {
  DEFAULT_COMPOSER_OPTIONS,
  shouldGenerate,
  augmentPrompt,
  composeResponse,
  plainFallbackText,
  encodeEnvelope,
  decodeEnvelope,
} from "./response-composer.ts";
export type { ComposerOptions, ComposeResult, DecodedEnvelope } from "./response-composer.ts";
export type { Obj } from "./semantics.ts";
