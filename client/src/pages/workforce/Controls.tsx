/**
 * Company controls for the SuperchargedAt.Work team: turn roles on or off, set each role's tier (up to its cap),
 * list denied tools and extra approval rules, and set budgets. Admin only. The server checks everything again
 * on save and refuses bad values, so this page only helps the admin enter them.
 *
 * Server contract (company-controls-routes.ts):
 *   GET /api/workforce/company-controls  -> { configured, version, roles: [{id, name, cap}], budgetKeys, controls }
 *   PUT /api/workforce/company-controls  { expectedVersion, controls } -> { version, changed, changes, controls }
 *
 * Owner rules (money, customer_send, delete) are always on and cannot be turned off here.
 */
import { useEffect, useState } from "react";
import { apiRequest, ApiError } from "@/lib/queryClient";

const TIERS = ["assist", "suggest", "auto", "predictive"] as const;
type Tier = (typeof TIERS)[number];
const OWNER_RULES = ["money", "customer_send", "delete"] as const;

const BUDGET_LABELS: Record<string, string> = {
  maxToolCallsPerRun: "Tool calls allowed in one run",
  maxTokensPerRun: "Tokens allowed in one run",
  maxSpendCentsPerRun: "Spend allowed in one run (cents)",
  maxRunsPerCompanyPerDay: "Runs started per day",
  maxSpendCentsPerCompanyPerDay: "Spend allowed per day (cents)",
};

interface RoleRow {
  id: string;
  name: string;
  cap: Tier;
}

interface RoleControl {
  enabled: boolean;
  tier: Tier;
}

interface ControlsDoc {
  roles: Record<string, RoleControl>;
  policy: { requireApprovalFor: string[]; deniedTools: string[]; maxAmountCents?: number };
  budgets: Record<string, number> | null;
}

interface ControlsResponse {
  configured: boolean;
  version: number;
  roles: RoleRow[];
  budgetKeys: string[];
  controls: ControlsDoc;
}

interface SaveResponse {
  version: number;
  changed: boolean;
  changes: string[];
}

function tiersUpTo(cap: Tier): Tier[] {
  return TIERS.slice(0, TIERS.indexOf(cap) + 1);
}

function parseList(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const reason = (error.data as { reason?: string } | undefined)?.reason;
    if (reason) return reason;
    if (error.status === 409) return "Someone else changed these settings. Reload and try again.";
    if (error.status === 403) return "Only a company admin can change these settings.";
  }
  return "The settings could not be saved. Nothing was changed.";
}

export default function Controls() {
  const [loaded, setLoaded] = useState<ControlsResponse | null>(null);
  const [roles, setRoles] = useState<Record<string, RoleControl>>({});
  const [deniedText, setDeniedText] = useState("");
  const [extraApprovalText, setExtraApprovalText] = useState("");
  const [budgets, setBudgets] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const applyDoc = (data: ControlsResponse) => {
    setLoaded(data);
    setRoles(data.controls.roles);
    setDeniedText(data.controls.policy.deniedTools.join(", "));
    setExtraApprovalText(
      data.controls.policy.requireApprovalFor.filter((rule) => !(OWNER_RULES as readonly string[]).includes(rule)).join(", "),
    );
    const next: Record<string, string> = {};
    for (const key of data.budgetKeys) next[key] = data.controls.budgets?.[key]?.toString() ?? "";
    setBudgets(next);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiRequest("GET", "/api/workforce/company-controls");
        const data = (await res.json()) as ControlsResponse;
        if (!cancelled) applyDoc(data);
      } catch (error) {
        if (!cancelled) setProblem(errorText(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setRole = (id: string, patch: Partial<RoleControl>) => {
    setRoles((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  };

  const save = async () => {
    if (!loaded) return;
    setMessage(null);
    setProblem(null);

    const budgetValues: Record<string, number> = {};
    for (const key of loaded.budgetKeys) {
      const raw = (budgets[key] ?? "").trim();
      const value = Number(raw);
      if (raw === "" || !Number.isInteger(value) || value <= 0) {
        setProblem(`${BUDGET_LABELS[key] ?? key}: enter a whole number above zero.`);
        return;
      }
      budgetValues[key] = value;
    }

    const extra = parseList(extraApprovalText);
    const controls = {
      roles,
      policy: {
        requireApprovalFor: [...OWNER_RULES, ...extra.filter((rule) => !(OWNER_RULES as readonly string[]).includes(rule))],
        deniedTools: parseList(deniedText),
      },
      budgets: budgetValues,
    };

    setSaving(true);
    try {
      const res = await apiRequest("PUT", "/api/workforce/company-controls", { expectedVersion: loaded.version, controls });
      const data = (await res.json()) as SaveResponse;
      setMessage(data.changed ? `Saved as version ${data.version}. ${data.changes.length} change(s).` : "No changes to save.");
      const reloaded = await apiRequest("GET", "/api/workforce/company-controls");
      applyDoc((await reloaded.json()) as ControlsResponse);
    } catch (error) {
      setProblem(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded && !problem) {
    return <p className="p-6 text-lg">Loading company controls...</p>;
  }
  if (!loaded) {
    return <p className="p-6 text-lg text-red-700">{problem}</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6 text-lg">
      <header className="space-y-2">
        <h1 className="text-3xl font-bold">Company controls</h1>
        <p>
          {loaded.configured
            ? `Saved settings, version ${loaded.version}.`
            : "No settings saved yet. Every role is off until you turn it on."}
        </p>
      </header>

      <section className="space-y-4" aria-labelledby="roles-heading">
        <h2 id="roles-heading" className="text-2xl font-semibold">Roles and tiers</h2>
        <p>Turn a role on, then pick its tier. A role cannot go above its own cap.</p>
        {loaded.roles.map((role) => {
          const current = roles[role.id];
          if (!current) return null;
          return (
            <div key={role.id} className="rounded-lg border p-4 space-y-3">
              <label className="flex items-center gap-3 font-medium">
                <input
                  type="checkbox"
                  className="h-6 w-6"
                  checked={current.enabled}
                  onChange={(event) => setRole(role.id, { enabled: event.target.checked })}
                />
                {role.name}
              </label>
              <label className="flex items-center gap-3">
                <span>Tier (cap: {role.cap})</span>
                <select
                  className="rounded border px-3 py-2"
                  value={current.tier}
                  onChange={(event) => setRole(role.id, { tier: event.target.value as Tier })}
                >
                  {tiersUpTo(role.cap).map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          );
        })}
      </section>

      <section className="space-y-4" aria-labelledby="actions-heading">
        <h2 id="actions-heading" className="text-2xl font-semibold">Actions and approval</h2>
        <div className="space-y-2">
          <p className="font-medium">Always need owner approval (cannot be turned off)</p>
          <ul className="list-disc pl-6">
            {OWNER_RULES.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
        <label className="block space-y-2">
          <span className="font-medium">More actions that need approval (comma separated)</span>
          <input
            className="w-full rounded border px-3 py-2"
            value={extraApprovalText}
            onChange={(event) => setExtraApprovalText(event.target.value)}
          />
        </label>
        <label className="block space-y-2">
          <span className="font-medium">Tools that are never allowed (comma separated)</span>
          <input
            className="w-full rounded border px-3 py-2"
            value={deniedText}
            onChange={(event) => setDeniedText(event.target.value)}
          />
        </label>
      </section>

      <section className="space-y-4" aria-labelledby="budgets-heading">
        <h2 id="budgets-heading" className="text-2xl font-semibold">Budgets</h2>
        <p>Every budget must be set before the company can run work. Use whole numbers above zero.</p>
        {loaded.budgetKeys.map((key) => (
          <label key={key} className="flex items-center justify-between gap-4">
            <span>{BUDGET_LABELS[key] ?? key}</span>
            <input
              inputMode="numeric"
              className="w-40 rounded border px-3 py-2 text-right"
              value={budgets[key] ?? ""}
              onChange={(event) => setBudgets((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
      </section>

      {problem && <p role="alert" className="rounded bg-red-50 p-4 text-red-800">{problem}</p>}
      {message && <p role="status" className="rounded bg-green-50 p-4 text-green-800">{message}</p>}

      <button
        type="button"
        onClick={save}
        disabled={saving}
        className="rounded bg-black px-6 py-3 text-lg font-semibold text-white disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save controls"}
      </button>
    </div>
  );
}
