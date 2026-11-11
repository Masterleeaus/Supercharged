import { Link, useLocation } from "wouter";
import { Inbox, Megaphone } from "lucide-react";
import { MODE_DESTINATIONS, selectedMode } from "@/lib/mode-navigation";
import { useDeskProductMode } from "@/hooks/useDeskProductMode";
import type { ProductMode } from "@/lib/desk-product-mode";

const ICONS = { marketing: Megaphone, inbox: Inbox };
function ModeLink({ mode, label, href }: { mode: ProductMode; label: string; href: string }) {
  const { loading, availability } = useDeskProductMode(mode);
  const [pathname] = useLocation();
  const Icon = ICONS[mode];
  const unavailable = !loading && !availability.available;
  return <Link href={href} aria-current={selectedMode(pathname) === mode ? "page" : undefined}
    data-testid={`mode-nav-${mode}`}
    className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent aria-[current=page]:bg-accent">
    <Icon className="h-4 w-4 shrink-0" />
    <span>{label}</span>
    {unavailable && <span className="ml-auto text-xs text-muted-foreground" aria-label="Unavailable">Unavailable</span>}
  </Link>;
}
export function ModeNavigation() {
  return <nav aria-label="Supercharged modes" className="space-y-1">
    {MODE_DESTINATIONS.map((destination) =>
      <ModeLink key={destination.id} mode={destination.id} label={destination.label} href={destination.href} />)}
  </nav>;
}
