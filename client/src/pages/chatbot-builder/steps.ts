/**
 * Ordered step registry for the chatbot builder wizard. Order matches core StepEnum and the core edit window.
 *
 * Each component is loaded from client/src/pages/chatbot-builder/steps/<id>.tsx and must be a DEFAULT export.
 * Each file currently renders "Not yet built" and is replaced by the step agents.
 */
import { lazy } from "react";
import type { StepDefinition } from "./types";

export const WIZARD_STEPS: StepDefinition[] = [
  {
    id: "configure",
    label: "Configure",
    group: "configure",
    external: false,
    component: lazy(() => import("./steps/configure")),
  },
  {
    id: "customize",
    label: "Customize",
    group: "customize",
    external: false,
    component: lazy(() => import("./steps/customize")),
  },
  {
    id: "train",
    label: "Train",
    group: "train",
    // Training needs an ingestion and embeddings provider Desk does not have yet. See DECISIONS.md.
    external: true,
    // Off unless VITE_ENABLE_CHATBOT_BUILDER_TRAIN is exactly "true". The /sources routes it calls are not on the backend yet.
    enabled: import.meta.env.VITE_ENABLE_CHATBOT_BUILDER_TRAIN === "true",
    component: lazy(() => import("./steps/train")),
  },
  {
    id: "embed",
    label: "Test and embed",
    group: "embed",
    external: false,
    component: lazy(() => import("./steps/embed")),
  },
  {
    id: "channel",
    label: "Channel",
    group: "channel",
    external: true,
    // Core shows this step only when channel add-ons are installed. Off unless VITE_ENABLE_CHATBOT_BUILDER_CHANNEL is exactly "true".
    enabled: import.meta.env.VITE_ENABLE_CHATBOT_BUILDER_CHANNEL === "true",
    component: lazy(() => import("./steps/channel")),
  },
];
