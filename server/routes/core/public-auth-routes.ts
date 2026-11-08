import type { Express } from "express";
import { createPublicRoutes } from "../../routes/public-routes";
import { createAuthRoutes } from "../../routes/auth-routes";
import type { RouteContext } from "./shared";

export function registerPublicAuthRoutes(app: Express, deps: { routeContext: RouteContext }): void {
  const { routeContext } = deps;

  // Register public routes (installer, health, branding, SEO, contact, etc.)
  const publicRoutes = createPublicRoutes(routeContext);
  app.use(publicRoutes);

  // Register authentication routes (login, register, OTP, password, etc.)
  const authRoutes = createAuthRoutes(routeContext);
  app.use(authRoutes);
}
