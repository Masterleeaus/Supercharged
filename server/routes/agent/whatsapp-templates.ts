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


import { logger } from "../../utils/logger";

/** Names of WhatsApp templates for a user, from the Meta or WhatsWay plugin when active. */
export async function fetchWhatsappTemplateNames(userId: string): Promise<string[]> {
  try {
    const { importPlugin } = await import('../../utils/plugin-import');
    const { metaWhatsAppService, whatswayService } = await importPlugin('plugins/messaging/index.ts');

    try {
      const metaSettings = await metaWhatsAppService.getSettings(userId);
      if (metaSettings && metaSettings.isActive) {
        const templates = await metaWhatsAppService.getTemplates(userId);
        const names = templates.map((t: any) => t.name);
        logger.info(`📋 [WhatsApp Templates] Fetched ${names.length} Meta template(s) for user ${userId}`);
        return names;
      }
    } catch (metaErr: any) {
      logger.warn(`⚠️  [WhatsApp Templates] Meta fetch failed: ${metaErr.message}`);
    }

    try {
      const wwSettings = await whatswayService.getSettings(userId);
      if (wwSettings && wwSettings.isActive) {
        const templates = await whatswayService.getTemplates(userId);
        const names = templates.map((t: any) => t.name);
        logger.info(`📋 [WhatsApp Templates] Fetched ${names.length} WhatsWay template(s) for user ${userId}`);
        return names;
      }
    } catch (wwErr: any) {
      logger.warn(`⚠️  [WhatsApp Templates] WhatsWay fetch failed: ${wwErr.message}`);
    }

    return [];
  } catch (err: any) {
    logger.warn(`⚠️  [WhatsApp Templates] Messaging plugin not available: ${err.message}`);
    return [];
  }
}
