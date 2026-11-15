/**
 * ============================================================
 * © 2025 Diploy — a brand of Bisht Technologies Private Limited
 * Original Author: BTPL Engineering Team
 * Website: https://diploy.in
 * Contact: cs@diploy.in
 *
 * Licensed under the MIT License. See the LICENSE file at the repository root.
 * Copyright (c) Titan Zero.
 * ============================================================
 */
import { StatusBadge } from "../StatusBadge";

export default function StatusBadgeExample() {
  return (
    <div className="p-8 flex flex-wrap gap-4">
      <StatusBadge status="pending" />
      <StatusBadge status="in_progress" />
      <StatusBadge status="calling" />
      <StatusBadge status="completed" />
      <StatusBadge status="failed" />
      <StatusBadge status="scheduled" />
      <StatusBadge status="hot" />
      <StatusBadge status="warm" />
      <StatusBadge status="cold" />
    </div>
  );
}
