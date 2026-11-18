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

import { AuthRequest } from "./common";

export function canAccessCampaign(campaign: any, req: AuthRequest): boolean {
  if (!campaign) return false;
  if (!(req as any).userId && !(req as any).user) return true;
  if (campaign.userId === (req as any).userId || campaign.userId === (req as any).user?.id) return true;
  if (['admin', 'manager', 'superadmin'].includes((req as any).user?.role || '')) return true;
  if ((req as any).user?.isTeamMember || (req as any).isTeamMember) return true;
  return false;
}
