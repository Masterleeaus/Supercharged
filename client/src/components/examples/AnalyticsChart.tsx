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
import { AnalyticsChart } from "../AnalyticsChart";

const barData = [
  { name: "Mon", value: 240 },
  { name: "Tue", value: 380 },
  { name: "Wed", value: 290 },
  { name: "Thu", value: 450 },
  { name: "Fri", value: 520 },
  { name: "Sat", value: 180 },
  { name: "Sun", value: 150 },
];

const pieData = [
  { name: "Hot Leads", value: 342 },
  { name: "Warm Leads", value: 1248 },
  { name: "Cold Leads", value: 823 },
  { name: "Lost", value: 234 },
];

export default function AnalyticsChartExample() {
  return (
    <div className="p-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
      <AnalyticsChart title="Calls This Week" type="bar" data={barData} />
      <AnalyticsChart title="Lead Distribution" type="pie" data={pieData} />
    </div>
  );
}
