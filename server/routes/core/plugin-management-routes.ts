import type { Express, RequestHandler } from "express";
import { type Server } from "http";
import { authenticateToken, authenticateAnyToken } from "../../middleware/auth";
import { checkAdminOrTeamMember, requireAdminPermission } from "../../middleware/admin-auth";
import { logger } from "../../utils/logger";

export async function registerPluginManagementRoutes(app: Express, deps: { httpServer: Server }): Promise<void> {
  const { httpServer } = deps;

  // Register Plugin Installer Routes FIRST (before general plugin routes to avoid /:name param conflict)
  const pluginInstallerRoutes = await import('../../routes/plugin-installer');
  app.use('/api/admin/plugins/installer', checkAdminOrTeamMember, pluginInstallerRoutes.default);

  // Register Plugin Management Routes (Admin or team member with permissions)
  // Allows viewing and managing installed plugins
  const pluginRoutes = await import('../../routes/plugin-routes');
  app.use('/api/admin/plugins', checkAdminOrTeamMember, requireAdminPermission('settings', 'plugins', 'read'), pluginRoutes.default);
  // Public plugin bundle endpoint (no auth required - bundles are just JS code)
  app.use('/api/plugins', pluginRoutes.publicPluginRouter);
  // User-accessible plugin capabilities endpoint (requires auth for user-specific data)
  // Uses authenticateAnyToken to accept both user JWTs and admin team session tokens
  app.use('/api/plugins', authenticateAnyToken, pluginRoutes.userPluginRouter);

  logger.info('✅ Plugin Management routes initialized');

  // Auto-load any additional plugins from /plugins directory
  // This allows installing new plugins by just copying the folder and restarting
  try {
    const { loadPlugins } = await import('../../plugins/loader');
    const { workforceLoaderOptions } = await import('../../integrations/workforce-runtime/titan-ports');
    const loadedPlugins = await loadPlugins(app, {
      sessionAuthMiddleware: authenticateToken as unknown as import('express').RequestHandler,
      adminAuthMiddleware: checkAdminOrTeamMember as unknown as import('express').RequestHandler,
      // Workforce previews require a named permission. Team membership alone is not enough (D2).
      workforceAdminMiddleware: [
        checkAdminOrTeamMember as unknown as import('express').RequestHandler,
        requireAdminPermission('workforce', 'previews', 'create') as unknown as import('express').RequestHandler,
      ],
      httpServer,
      ...workforceLoaderOptions(),
    });
    if (loadedPlugins.filter(p => p.registered).length > 0) {
      logger.info(`✅ Auto-loaded ${loadedPlugins.filter(p => p.registered).length} plugin(s) from /plugins directory`);
    }
  } catch (error) {
    logger.warn('[Plugin Loader] Failed to auto-load plugins:', error);
  }
}
