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
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface CreditWidgetProps {
  credits: number;
  lowBalance?: boolean;
}

export function CreditWidget({ credits, lowBalance = false }: CreditWidgetProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="gap-2 font-mono" data-testid="button-credits">
          <CreditCard className="h-4 w-4" />
          <span className={lowBalance ? "text-destructive" : ""}>{credits.toLocaleString()}</span>
          <span className="text-muted-foreground text-xs">credits</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="px-4 py-3">
          <div className="text-sm font-medium mb-1">Credit Balance</div>
          <div className="text-2xl font-mono font-semibold">{credits.toLocaleString()}</div>
          <div className="text-xs text-muted-foreground mt-1">Available credits</div>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="button-recharge">
          <CreditCard className="mr-2 h-4 w-4" />
          Recharge Credits
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="button-view-usage">
          View Usage History
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
