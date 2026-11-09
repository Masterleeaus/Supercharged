import { Link } from "wouter";
import { Megaphone, Workflow, BarChart3 } from "lucide-react";

export default function MarketingHome() {
  return <main className="space-y-5" data-testid="marketing-mode">
    <header><h1 className="text-2xl font-semibold" data-testid="mode-marketing-title">Marketing</h1><p className="text-muted-foreground">Campaign planning, outreach and response monitoring.</p></header>
    <div className="grid gap-3 md:grid-cols-3">
      <Link href="/app/campaigns" className="rounded-lg border p-4 hover:bg-accent"><Megaphone className="mb-3 h-5 w-5" /><strong>Campaigns</strong><p className="text-sm text-muted-foreground">Manage outreach and campaigns</p></Link>
      <Link href="/app/flows" className="rounded-lg border p-4 hover:bg-accent"><Workflow className="mb-3 h-5 w-5" /><strong>Flows</strong><p className="text-sm text-muted-foreground">Automations and triggers</p></Link>
      <Link href="/app/analytics" className="rounded-lg border p-4 hover:bg-accent"><BarChart3 className="mb-3 h-5 w-5" /><strong>Analytics</strong><p className="text-sm text-muted-foreground">Review existing metrics</p></Link>
    </div>
  </main>;
}
