/**
 * Write conflict checks. Port of Support/MarketplaceConflictDetector.php.
 * A blocking conflict stops a write before it reaches the provider. Warnings do not.
 * Pure: the caller passes the clock and the internal stock figure.
 */
import type { MarketplaceWriteOperation } from "./operations.ts";

export interface ConflictFinding {
  code: "source_version_changed" | "stale_snapshot" | "missing_snapshot_time" | "inventory_exceeds_available" | "inventory_not_mapped";
  message: string;
  details?: Record<string, number | string | null>;
}

export interface ConflictAssessment {
  blocking: boolean;
  conflicts: ConflictFinding[];
  warnings: ConflictFinding[];
}

export interface ConflictInput {
  operation: MarketplaceWriteOperation;
  changes: Record<string, unknown>;
  /** Hash the seller reviewed. The write is refused when the stored listing has moved on. */
  expectedSourceHash: string;
  /** Hash of the snapshot we hold now. */
  currentSourceHash: string;
  /** When the snapshot was last confirmed with the provider. Null means unknown. */
  lastSeenAt: Date | null;
  now: Date;
  maximumSnapshotAgeSeconds: number;
  /** Internal available stock for the mapped product. Null means the listing is not mapped to inventory. */
  internalAvailable: number | null;
  allowOversell: boolean;
}

export function assessConflicts(input: ConflictInput): ConflictAssessment {
  const conflicts: ConflictFinding[] = [];
  const warnings: ConflictFinding[] = [];

  if (input.expectedSourceHash === "" || input.currentSourceHash === "" || input.currentSourceHash !== input.expectedSourceHash) {
    conflicts.push({
      code: "source_version_changed",
      message: "The marketplace listing changed after it was reviewed. Refresh it before applying the update.",
      details: { expectedSourceHash: input.expectedSourceHash, actualSourceHash: input.currentSourceHash },
    });
  }

  const maximumAge = Math.max(30, input.maximumSnapshotAgeSeconds);
  if (input.lastSeenAt === null) {
    conflicts.push({ code: "missing_snapshot_time", message: "The listing has no verified observation time. Refresh it first." });
  } else {
    const ageSeconds = Math.floor((input.now.getTime() - input.lastSeenAt.getTime()) / 1000);
    if (ageSeconds > maximumAge) {
      conflicts.unshift({
        code: "stale_snapshot",
        message: "The marketplace listing snapshot is too old for a safe write. Refresh it first.",
        details: { maximumAgeSeconds: maximumAge, ageSeconds },
      });
    }
  }

  if (input.operation === "update_inventory") {
    if (input.internalAvailable === null) {
      warnings.push({ code: "inventory_not_mapped", message: "This marketplace listing is not mapped to internal inventory." });
    } else if (!input.allowOversell && Number(input.changes.quantity ?? 0) > input.internalAvailable) {
      conflicts.push({
        code: "inventory_exceeds_available",
        message: "The requested marketplace quantity exceeds available internal stock.",
        details: { requestedQuantity: Number(input.changes.quantity ?? 0), internalAvailable: input.internalAvailable },
      });
    }
  }

  return { blocking: conflicts.length > 0, conflicts, warnings };
}
