/**
 * Public surface of the chatbot contracts. Builders import from here, never from a sibling file directly.
 * Contracts are types and constants. Implementations live in their own slice folders (see CONVENTIONS.md).
 */
export * from "./http.ts";
export * from "./ai.ts";
export * from "./channels.ts";
export * from "./knowledge.ts";
export * from "./runtime.ts";
export * from "./commerce.ts";
export * from "./booking-providers.ts";
export * from "./voice.ts";
export * from "./widget.ts";
export * from "./secrets.ts";
export * from "./flags.ts";
