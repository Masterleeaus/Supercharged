import type { Response } from 'express';

/**
 * Placeholder for POST /api/admin/migrate-call-user-ids on the admin router.
 * The real migration lives in server/routes.ts (app.post('/api/admin/migrate-call-user-ids')).
 * This route is mounted first and used to answer success without doing anything, so it now refuses
 * with 501 until the real migration is wired through here.
 */
export function migrateCallUserIdsNotWired(_req: unknown, res: Response) {
  return res.status(501).json({
    error: 'not_implemented',
    message: 'Call user ID migration is not wired to this endpoint. No changes were made.',
  });
}
