// HTTP routes for the inbox, comms mode only. Factory only: nothing is mounted here.
//
// Not exposed on purpose:
//   - recordInbound: provider webhooks need their own signed route, not a staff session.
//   - applyApprovalDecision: called by the approvals engine, not by a client.

import type { InboxService } from './inbox-service.ts';
import { InboxError } from './inbox-service.ts';
import { THREAD_STATUSES, type Assignee, type ThreadStatus } from './types.ts';
// The service validates assignee: null unassigns, {kind, id} assigns, and a missing field is
// rejected. Pass the body value through unchanged so a missing field can never unassign a thread.
import type { ThreadFilter } from './ports.ts';
import {
  bodyOf,
  commsRoute,
  prepareCommsRouter,
  queryString,
  type CommsRouterDeps,
  type HttpRequest,
  type RouterLike,
} from '../desk-modes/comms-router.ts';

export type InboxRouterDeps = CommsRouterDeps<InboxService>;

function threadFilter(req: HttpRequest): ThreadFilter {
  const filter: ThreadFilter = {};
  const status = queryString(req, 'status');
  if (status !== undefined) {
    if (!(THREAD_STATUSES as readonly string[]).includes(status)) {
      throw new InboxError('status must be open, snoozed or closed', 'invalid');
    }
    filter.status = status as ThreadStatus;
  }
  const assigneeId = queryString(req, 'assigneeId');
  if (assigneeId !== undefined) filter.assigneeId = assigneeId;
  return filter;
}

export function createInboxRouter(deps: InboxRouterDeps): RouterLike {
  const router = prepareCommsRouter(deps, 'inbox');
  const { service, scope } = deps;
  // Inbox administration (assignment, status) is staff-only. Thread reads and staff replies stay open to members.
  const staffOnly = deps.requireRole('admin', 'manager');

  router.get('/threads', commsRoute(scope, (s, req) => service.listThreads(s.companyId, threadFilter(req))));

  router.get('/threads/:id', commsRoute(scope, (s, req) => service.getThread(s.companyId, req.params.id)));

  router.get('/threads/:id/messages', commsRoute(scope, (s, req) => service.listMessages(s.companyId, req.params.id)));

  router.post(
    '/threads/:id/assignment',
    staffOnly,
    commsRoute(scope, (s, req) =>
      service.assignThread(s.companyId, s.actor, req.params.id, bodyOf(req).assignee as Assignee | null),
    ),
  );

  router.post(
    '/threads/:id/status',
    staffOnly,
    commsRoute(scope, (s, req) =>
      service.setThreadStatus(s.companyId, s.actor, req.params.id, bodyOf(req).status as ThreadStatus),
    ),
  );

  router.post(
    '/threads/:id/drafts',
    commsRoute(
      scope,
      (s, req) => service.createDraft(s.companyId, s.actor, req.params.id, bodyOf(req).body as string),
      201,
    ),
  );

  router.post(
    '/threads/:id/messages',
    commsRoute(
      scope,
      (s, req) => service.sendAsStaff(s.companyId, s.actor, req.params.id, bodyOf(req).body as string),
      201,
    ),
  );

  router.post(
    '/messages/:id/send-request',
    commsRoute(scope, (s, req) => service.requestSend(s.companyId, s.actor, req.params.id)),
  );

  return router;
}
