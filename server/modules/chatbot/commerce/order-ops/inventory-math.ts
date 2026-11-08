/**
 * Inventory allocation and assessment. Pure port of InventoryChannelAllocator.php,
 * MarketplaceInventoryReconciliation.php and InventoryConflictResolutionPolicy.php.
 * Quantities are integers. Percentages use basis points with BigInt, rounded down (intdiv in PHP).
 */
import { OrderOpsError, type InventoryConflictCode, type InventoryPolicy } from "./types.ts";

export interface AllocationPolicy {
  allocationMode?: string;
  allocationBps?: number;
  bufferQuantity?: number;
  minimumQuantity?: number;
  maximumQuantity?: number | null;
  fixedQuantity?: number;
  channelCount?: number;
}

export interface Allocation {
  canonicalAvailable: number;
  protectedBuffer: number;
  distributable: number;
  allocationMode: string;
  channelCount: number;
  targetQuantity: number;
}

const MODES = ["mirror", "equal_share", "percentage", "fixed_cap", "percentage_cap"] as const;

function percentage(quantity: number, basisPoints: number): number {
  const bps = Math.min(10_000, Math.max(0, basisPoints));
  return Number((BigInt(quantity) * BigInt(bps)) / 10_000n);
}

export function allocate(canonicalAvailable: number, policy: AllocationPolicy = {}): Allocation {
  const available = Math.max(0, canonicalAvailable);
  const buffer = Math.max(0, policy.bufferQuantity ?? 0);
  const distributable = Math.max(0, available - buffer);
  const mode = (policy.allocationMode ?? "equal_share").trim().toLowerCase();
  const maximum = policy.maximumQuantity === null || policy.maximumQuantity === undefined ? null : Math.max(0, policy.maximumQuantity);
  const channels = Math.max(1, policy.channelCount ?? 1);
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new OrderOpsError("Unsupported inventory allocation mode.");
  }

  let target: number;
  switch (mode) {
    case "mirror":
      target = distributable;
      break;
    case "equal_share":
      target = Math.floor(distributable / channels);
      break;
    case "fixed_cap":
      target = Math.min(distributable, Math.max(0, policy.fixedQuantity ?? maximum ?? 0));
      break;
    default:
      target = percentage(distributable, policy.allocationBps ?? 10_000);
  }
  if (maximum !== null) target = Math.min(target, maximum);
  const minimum = Math.max(0, policy.minimumQuantity ?? 0);
  if (target > 0 && target < minimum) target = 0;

  return {
    canonicalAvailable: available,
    protectedBuffer: buffer,
    distributable,
    allocationMode: mode,
    channelCount: channels,
    targetQuantity: Math.max(0, target),
  };
}

export interface CanonicalStateView {
  quantity: number;
  reserved: number;
  committed: number;
  incoming: number;
  damaged: number;
  safetyStock: number;
  available: number;
  version: number;
}

export interface ChannelObservation {
  quantity: number;
  observedAt: Date | null;
  sourceHash: string;
}

export interface AssessmentPolicy {
  targetQuantity: number;
  maximumSyncAgeSeconds: number;
  quantityTolerance: number;
}

export interface InventoryAssessment {
  conflict: boolean;
  blocking: boolean;
  code: InventoryConflictCode;
  severity: "none" | "warning" | "critical";
  message: string;
  targetQuantity: number;
  externalQuantity: number;
  delta: number;
  canonicalVersion: number;
  canonicalAvailable: number;
  reserved: number;
  committed: number;
  sourceHash: string;
  snapshotFresh: boolean;
  snapshotAgeSeconds: number | null;
  maximumSyncAgeSeconds: number;
  oversellExposure: number;
  undersellQuantity: number;
}

/** Compares local availability with the marketplace quantity. Never writes. The caller decides what to do. */
export function assess(canonical: CanonicalStateView, channel: ChannelObservation, policy: AssessmentPolicy, nowMs: number): InventoryAssessment {
  const target = Math.max(0, policy.targetQuantity);
  const external = Math.max(0, channel.quantity);
  const tolerance = Math.max(0, policy.quantityTolerance);
  const maximumAge = Math.max(30, policy.maximumSyncAgeSeconds);
  let fresh = false;
  let ageSeconds: number | null = null;
  if (channel.observedAt && !Number.isNaN(channel.observedAt.getTime())) {
    ageSeconds = Math.max(0, Math.floor((nowMs - channel.observedAt.getTime()) / 1000));
    fresh = ageSeconds <= maximumAge;
  }

  const base = {
    targetQuantity: target,
    externalQuantity: external,
    delta: target - external,
    canonicalVersion: canonical.version,
    canonicalAvailable: Math.max(0, canonical.available),
    reserved: Math.max(0, canonical.reserved),
    committed: Math.max(0, canonical.committed),
    sourceHash: channel.sourceHash,
    snapshotFresh: fresh,
    snapshotAgeSeconds: ageSeconds,
    maximumSyncAgeSeconds: maximumAge,
    oversellExposure: 0,
    undersellQuantity: 0,
  };

  if (!fresh) {
    return {
      ...base, conflict: true, blocking: true, code: "external_state_stale", severity: "critical",
      message: "The marketplace inventory observation is too old for a safe correction. Refresh the listing first.",
    };
  }
  const difference = external - target;
  if (Math.abs(difference) <= tolerance) {
    return {
      ...base, conflict: false, blocking: false, code: "in_sync", severity: "none",
      message: "Marketplace inventory matches the permitted channel allocation.",
    };
  }
  if (external > target) {
    return {
      ...base, oversellExposure: external - target, conflict: true, blocking: true, code: "external_above_target", severity: "critical",
      message: "Marketplace inventory exceeds the reservation-aware channel allocation and may oversell.",
    };
  }
  return {
    ...base, undersellQuantity: target - external, conflict: true, blocking: false, code: "external_below_target", severity: "warning",
    message: "Marketplace inventory is lower than the permitted channel allocation and may suppress sales.",
  };
}

export interface ResolutionEligibility {
  autoPrepare: boolean;
  autoExecute: false;
  reason: string;
}

/** Automatic preparation only. Execution always needs seller approval, so autoExecute is never true. */
export function evaluateResolution(policy: Pick<InventoryPolicy, "resolutionMode" | "requireFreshSnapshot" | "maximumAutoDelta">, assessment: Pick<InventoryAssessment, "conflict" | "blocking" | "snapshotFresh" | "delta">): ResolutionEligibility {
  if (policy.resolutionMode !== "auto_prepare") {
    return { autoPrepare: false, autoExecute: false, reason: "The policy does not permit automatic preparation." };
  }
  if (!assessment.conflict) return { autoPrepare: false, autoExecute: false, reason: "No correction is required." };
  if (assessment.blocking) return { autoPrepare: false, autoExecute: false, reason: "The conflict requires a fresh or manual review." };
  if (policy.requireFreshSnapshot && !assessment.snapshotFresh) {
    return { autoPrepare: false, autoExecute: false, reason: "The marketplace observation is stale." };
  }
  const maximumDelta = Math.max(0, policy.maximumAutoDelta);
  if (maximumDelta < 1 || Math.abs(assessment.delta) > maximumDelta) {
    return { autoPrepare: false, autoExecute: false, reason: "The quantity change exceeds the automatic preparation limit." };
  }
  return { autoPrepare: true, autoExecute: false, reason: "A bounded correction may be prepared, but seller approval is still required." };
}
