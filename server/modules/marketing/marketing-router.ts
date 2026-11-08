// HTTP routes for marketing pages and content, comms mode only. Factory only: nothing is mounted here.
// Page and content inputs are validated by the service (assertSections and friends).

import type { MarketingService } from './marketing-service.ts';
import { PAGE_STATUSES, CONTENT_KINDS, CONTENT_STATUSES, type PageStatus, type ContentKind, type ContentStatus } from './types.ts';
import { MarketingError } from './marketing-service.ts';
import {
  bodyOf,
  commsRoute,
  prepareCommsRouter,
  queryString,
  type CommsRouterDeps,
  type HttpRequest,
  type RouterLike,
} from '../desk-modes/comms-router.ts';

export type MarketingRouterDeps = CommsRouterDeps<MarketingService>;

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new MarketingError(`${label} must be one of ${allowed.join(', ')}`, 'invalid');
  }
  return value as T;
}

export function createMarketingRouter(deps: MarketingRouterDeps): RouterLike {
  const router = prepareCommsRouter(deps, 'marketing');
  const { service, scope } = deps;
  // Publication, archiving and approval are staff-only: admin or manager.
  const staffOnly = deps.requireRole('admin', 'manager');

  router.get(
    '/pages',
    commsRoute(scope, (s, req: HttpRequest) => {
      const filter: { status?: PageStatus; campaignId?: string } = {};
      const status = oneOf<PageStatus>(queryString(req, 'status'), PAGE_STATUSES, 'status');
      const campaignId = queryString(req, 'campaignId');
      if (status !== undefined) filter.status = status;
      if (campaignId !== undefined) filter.campaignId = campaignId;
      return service.listPages(s.companyId, filter);
    }),
  );

  router.get('/pages/:id', commsRoute(scope, (s, req) => service.getPage(s.companyId, req.params.id)));

  router.post(
    '/pages',
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.createPage(s.companyId, s.actor, {
          slug: b.slug,
          title: b.title,
          sections: b.sections,
          campaignId: b.campaignId,
          chatbotId: b.chatbotId,
        });
      },
      201,
    ),
  );

  router.patch(
    '/pages/:id',
    commsRoute(scope, (s, req) => {
      const b = bodyOf(req);
      return service.updatePage(s.companyId, s.actor, req.params.id, {
        title: b.title,
        sections: b.sections,
        campaignId: b.campaignId,
        chatbotId: b.chatbotId,
      });
    }),
  );

  router.post(
    '/pages/:id/publication',
    staffOnly,
    commsRoute(scope, (s, req) => service.publishPage(s.companyId, s.actor, req.params.id)),
  );

  router.post(
    '/pages/:id/archive',
    staffOnly,
    commsRoute(scope, (s, req) => service.archivePage(s.companyId, s.actor, req.params.id)),
  );

  router.get(
    '/content',
    commsRoute(scope, (s, req) => {
      const filter: { kind?: ContentKind; status?: ContentStatus; campaignId?: string } = {};
      const kind = oneOf<ContentKind>(queryString(req, 'kind'), CONTENT_KINDS, 'kind');
      const status = oneOf<ContentStatus>(queryString(req, 'status'), CONTENT_STATUSES, 'status');
      const campaignId = queryString(req, 'campaignId');
      if (kind !== undefined) filter.kind = kind;
      if (status !== undefined) filter.status = status;
      if (campaignId !== undefined) filter.campaignId = campaignId;
      return service.listContent(s.companyId, filter);
    }),
  );

  router.get('/content/:id', commsRoute(scope, (s, req) => service.getContent(s.companyId, req.params.id)));

  router.post(
    '/content',
    commsRoute(
      scope,
      (s, req) => {
        const b = bodyOf(req);
        return service.createContent(s.companyId, s.actor, {
          kind: b.kind,
          title: b.title,
          body: b.body,
          campaignId: b.campaignId,
        });
      },
      201,
    ),
  );

  router.patch(
    '/content/:id',
    commsRoute(scope, (s, req) => {
      const b = bodyOf(req);
      return service.updateContent(s.companyId, s.actor, req.params.id, {
        kind: b.kind,
        title: b.title,
        body: b.body,
        campaignId: b.campaignId,
      });
    }),
  );

  router.post(
    '/content/:id/approval',
    staffOnly,
    commsRoute(scope, (s, req) => service.approveContent(s.companyId, s.actor, req.params.id)),
  );

  router.post(
    '/content/:id/publication',
    staffOnly,
    commsRoute(scope, (s, req) => service.publishContent(s.companyId, s.actor, req.params.id)),
  );

  return router;
}
