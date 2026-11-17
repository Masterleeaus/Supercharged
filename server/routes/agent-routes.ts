/**
 * ============================================================
 * © 2025 Titan Zero Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */


import { Router } from "express";
import { RouteContext } from "./common";
import { registerAgentCrudListRoutes } from "./agent/crud-list";
import { registerAgentSingleRoutes } from "./agent/crud-single";
import { registerKnowledgeBaseRoutes } from "./agent/knowledge-base";
import { registerAgentVersionRoutes } from "./agent/versions";
import { registerVoiceRoutes } from "./agent/voices";

export function createAgentRoutes(ctx: RouteContext): Router {
  const router = Router();
  registerAgentCrudListRoutes(router, ctx);
  registerAgentSingleRoutes(router, ctx);
  registerKnowledgeBaseRoutes(router, ctx);
  registerAgentVersionRoutes(router, ctx);
  registerVoiceRoutes(router, ctx);
  return router;
}
