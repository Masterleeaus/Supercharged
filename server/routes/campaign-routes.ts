'use strict';
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
import { createCampaignCoreRoutes } from "./campaign-core-routes";
import { createCampaignContactRoutes } from "./campaign-contacts-routes";
import { createCampaignExecutionRoutes } from "./campaign-execution-routes";

export function createCampaignRoutes(ctx: RouteContext): Router {
  const router = Router();
  router.use(createCampaignCoreRoutes(ctx));
  router.use(createCampaignContactRoutes(ctx));
  router.use(createCampaignExecutionRoutes(ctx));
  return router;
}
