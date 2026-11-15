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
import { useState } from "react";
import { CreateCampaignDialog } from "../CreateCampaignDialog";
import { Button } from "@/components/ui/button";

export default function CreateCampaignDialogExample() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-8">
      <Button onClick={() => setOpen(true)} data-testid="button-open-dialog">
        Open Create Campaign Dialog
      </Button>
      <CreateCampaignDialog
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
