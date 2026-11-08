/**
 * HTTP routes for the {{pascal}} module.
 *
 * Auth chain per route: authenticateToken (verifies the JWT, sets req.user),
 * then requireRole(...) (admins always pass; other roles must be listed).
 * Mount under the path chosen in index.ts. Routes stay thin: validate, call the
 * service, map the result to HTTP.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authenticateToken, requireRole } from "../../middleware/auth";
import { {{pascal}}Error, type {{pascal}}Service } from "./{{name}}-service";

/**
 * Validation placeholder. Replace the fields with the real request contract.
 * Parse with safeParse so a bad body becomes a 400, never a thrown error.
 */
export const create{{pascal}}Body = z.object({
  name: z.string().min(1).max(200),
});

export function create{{pascal}}Router(service: {{pascal}}Service): Router {
  const router = Router();

  // Example: readable by admins and by any user holding the "user" role.
  router.get(
    "/",
    authenticateToken,
    requireRole("user"),
    async (_req: Request, res: Response) => {
      try {
        res.json(await service.list());
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // Example: writes are admin-only. requireRole("admin") is the strictest form.
  router.post(
    "/",
    authenticateToken,
    requireRole("admin"),
    async (req: Request, res: Response) => {
      const parsed = create{{pascal}}Body.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", issues: parsed.error.issues });
      }
      try {
        const created = await service.create(parsed.data);
        return res.status(201).json(created);
      } catch (err) {
        return sendError(res, err);
      }
    },
  );

  return router;
}

function sendError(res: Response, err: unknown) {
  if (err instanceof {{pascal}}Error) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error("[{{pascal}}] unexpected error:", err);
  return res.status(500).json({ error: "Internal server error" });
}
