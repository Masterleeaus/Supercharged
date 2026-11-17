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
import { CreditWidget } from "../CreditWidget";

export default function CreditWidgetExample() {
  return (
    <div className="p-8 flex gap-4">
      <CreditWidget credits={15420} />
      <CreditWidget credits={250} lowBalance={true} />
    </div>
  );
}
