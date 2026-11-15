/**
 * The three named Manager agents shown to a company as separate agents (issue #50): Hub, Go and Command.
 *
 * Pure. It describes each Manager for the Supercharged experience: who it is for, where it is entered,
 * what it is for, and where it escalates. The tool list and access rules stay in the role files under
 * ./roles/; this module reads the loaded catalogue and fails closed if any Manager is missing, so a
 * surface never shows a Manager that the runtime cannot run.
 */
import type { RoleCatalogue } from "./loader.ts";

export const NAMED_MANAGER_IDS = ["hub-manager", "go-manager", "command-manager"] as const;
export type NamedManagerId = (typeof NAMED_MANAGER_IDS)[number];

export interface NamedManagerEntry {
  id: NamedManagerId;
  /** The display name. Must equal the role's name in the catalogue. */
  name: string;
  /** Who the Manager talks to. */
  audience: string;
  /** Where the Manager is entered in Supercharged. */
  entryPoint: string;
  /** What it is for, in plain words. */
  responsibilities: string;
  /** Where a case goes when the Manager cannot settle it. */
  escalationPath: string;
}

export const NAMED_MANAGER_DIRECTORY: readonly NamedManagerEntry[] = [
  {
    id: "hub-manager",
    name: "Hub Manager",
    audience: "Customers, prospects and enquirers",
    entryPoint: "Customer enquiry form, web chat and SMS",
    responsibilities: "Enquiries, quote and booking requests, customer care and follow-up. Drafts replies for a person to send.",
    escalationPath: "Complaints, disputes and safety concerns go to a person. Any hazard or injury: contact emergency services first.",
  },
  {
    id: "go-manager",
    name: "Go Manager",
    audience: "Technicians and crews on their assigned jobs",
    entryPoint: "Field app job view and chat",
    responsibilities: "Job briefs, site notes, checklists, progress notes, photos and sign-off on site.",
    escalationPath: "Money or customer-terms questions go to the Command Manager. Unsafe conditions stop the task and go to a person at once.",
  },
  {
    id: "command-manager",
    name: "Command Manager",
    audience: "Business owner and approved managers",
    entryPoint: "Owner dashboard and chat",
    responsibilities: "Schedule, rosters, exceptions, approvals, purchasing drafts and business reports.",
    escalationPath: "Every purchase, payment, refund and roster change waits for owner approval. Safety or compliance issues go to the owner first.",
  },
];

export type NamedManagerListing =
  | { ok: true; managers: NamedManagerEntry[] }
  | { ok: false; missing: NamedManagerId[]; mismatched: NamedManagerId[] };

/**
 * Returns the three named Managers, in directory order, only when every one is in the catalogue under the
 * same name. Otherwise returns the ids that are missing or mismatched. Never throws.
 */
export function listNamedManagers(catalogue: RoleCatalogue): NamedManagerListing {
  const missing: NamedManagerId[] = [];
  const mismatched: NamedManagerId[] = [];
  for (const entry of NAMED_MANAGER_DIRECTORY) {
    const role = catalogue.get(entry.id);
    if (!role) {
      missing.push(entry.id);
    } else if (role.name !== entry.name) {
      mismatched.push(entry.id);
    }
  }
  if (missing.length > 0 || mismatched.length > 0) return { ok: false, missing, mismatched };
  return { ok: true, managers: NAMED_MANAGER_DIRECTORY.map((entry) => ({ ...entry })) };
}
