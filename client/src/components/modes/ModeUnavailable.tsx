import { AlertCircle } from "lucide-react";
import { Link } from "wouter";
import { MODE_UNAVAILABLE_TEXT, type ModeAvailability } from "@/lib/mode-capabilities";
import { destinationForMode } from "@/lib/mode-navigation";
import type { ProductMode } from "@/lib/desk-product-mode";

export function ModeUnavailable({ mode, reason }: {
  mode: ProductMode;
  reason: Exclude<ModeAvailability, { available: true }>["reason"];
}) {
  const destination = destinationForMode(mode);
  return <section role="status" className="mx-auto max-w-xl space-y-3 rounded-lg border p-6">
    <div className="flex items-center gap-2 font-semibold"><AlertCircle className="h-5 w-5" />{destination.label} unavailable</div>
    <p className="text-sm text-muted-foreground">{MODE_UNAVAILABLE_TEXT[reason]}</p>
    <Link href="/app/settings" className="text-sm underline">Workspace settings</Link>
  </section>;
}
