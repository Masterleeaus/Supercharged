/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Distributed under the Envato / CodeCanyon License Agreement.
 * Licensed to the purchaser for use as defined by the
 * Envato Market (CodeCanyon) Regular or Extended License.
 *
 * You are NOT permitted to redistribute, resell, sublicense,
 * or share this source code, in whole or in part.
 * Respect the author's rights and Envato licensing terms.
 * ============================================================
 */
import { Router } from "express";
import { registerFlowRoutes } from "./flow-automation/flows";
import { registerFlowTestCallRoutes } from "./flow-automation/flow-test-call";
import { registerFlowQueueRoutes } from "./flow-automation/queue";
import { registerFlowTemplateRoutes } from "./flow-automation/templates";
import { registerWebhookRoutes } from "./flow-automation/webhooks";
import { registerAppointmentRoutes } from "./flow-automation/appointments";
import { registerFormRoutes } from "./flow-automation/forms";
import { registerExecutionRoutes } from "./flow-automation/executions";

const router = Router();

// Route registration order is the original order. Express matches in registration order.
registerFlowRoutes(router);
registerFlowTestCallRoutes(router);
registerFlowQueueRoutes(router);
registerFlowTemplateRoutes(router);
registerWebhookRoutes(router);
registerAppointmentRoutes(router);
registerFormRoutes(router);
registerExecutionRoutes(router);

export default router;
