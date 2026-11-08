/**
 * Chatbot builder wizard shell. Owns step navigation, the shared WizardState, and save and draft handling.
 *
 * Route: /app/chatbot-builder/wizard/:id? with the current step in ?step=<id> (see DECISIONS.md).
 * Without :id the wizard creates a chatbot on the first save. The list page (ChatbotBuilder.tsx) is unchanged.
 *
 * Save rules:
 * - Only groups that changed since the last save are sent.
 * - Moving forward (Next, or a step button) saves first. If the save fails, the user stays on the step.
 * - Drafts: unsaved edits are kept in localStorage per chatbot (key "new" before the first save). They are
 *   restored on load with a notice, and cleared when the server copy matches them.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, queryClient } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ChevronLeft, ChevronRight, Loader2, Save } from "lucide-react";
import {
  builderQueryKey,
  CHATBOTS_QUERY_KEY,
  createChatbot,
  getBuilder,
  patchBuilder,
  type BuilderPatch,
  type BuilderSnapshot,
} from "./api";
import { WIZARD_STEPS } from "./steps";
import { BUILDER_LIMITS, EMPTY_WIZARD_STATE, type StepDefinition, type StepId, type WizardState } from "./types";

const LIST_PATH = "/app/chatbot-builder";
const WIZARD_PATH = "/app/chatbot-builder/wizard";
const ROUTE_PATTERN = "/app/chatbot-builder/wizard/:id?";

/** Steps visible in the wizard. Channel stays hidden until Desk has channel add-ons. */
const STEPS: StepDefinition[] = WIZARD_STEPS.filter((s) => s.enabled !== false);

/** Groups that the backend saves. Train and channel have no save endpoint yet. */
type SavedGroup = "configure" | "customize" | "embed";
const SAVED_GROUPS: SavedGroup[] = ["configure", "customize", "embed"];

function changedGroups(current: WizardState, baseline: WizardState): SavedGroup[] {
  return SAVED_GROUPS.filter((g) => JSON.stringify(current[g]) !== JSON.stringify(baseline[g]));
}

function buildPatch(state: WizardState, groups: SavedGroup[]): BuilderPatch {
  const patch: BuilderPatch = {};
  if (groups.includes("configure")) patch.configure = state.configure;
  if (groups.includes("customize")) patch.customize = state.customize;
  // embed.uuid is read-only, so it is left out of the patch.
  if (groups.includes("embed")) patch.embed = { trustedDomains: state.embed.trustedDomains };
  return patch;
}

/** Fills any missing keys, so older drafts or partial server data still produce a full WizardState. */
function withDefaults(raw: Partial<WizardState>): WizardState {
  return {
    configure: { ...EMPTY_WIZARD_STATE.configure, ...raw.configure },
    customize: { ...EMPTY_WIZARD_STATE.customize, ...raw.customize },
    train: {},
    embed: { ...EMPTY_WIZARD_STATE.embed, ...raw.embed },
    channel: {},
  };
}

function validateConfigure(c: WizardState["configure"]): string | null {
  const title = c.title.trim();
  if (title === "") return "Title is required.";
  if (title.length > BUILDER_LIMITS.title) return `Title must be ${BUILDER_LIMITS.title} characters or fewer.`;
  if (c.bubbleMessage.trim() === "") return "Bubble message is required.";
  if (c.bubbleMessage.length > BUILDER_LIMITS.bubbleMessage) {
    return `Bubble message must be ${BUILDER_LIMITS.bubbleMessage} characters or fewer.`;
  }
  if (c.welcomeMessage.trim() === "") return "Welcome message is required.";
  if (c.welcomeMessage.length > BUILDER_LIMITS.welcomeMessage) {
    return `Welcome message must be ${BUILDER_LIMITS.welcomeMessage} characters or fewer.`;
  }
  if (c.instructions.trim() === "") return "Instructions are required.";
  if (c.instructions.length > BUILDER_LIMITS.instructions) {
    return `Instructions must be ${BUILDER_LIMITS.instructions} characters or fewer.`;
  }
  return null;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const issues = (err.data as { issues?: Array<{ path?: unknown[]; message?: string }> } | null)?.issues;
    if (Array.isArray(issues) && issues.length > 0) {
      return issues
        .map((i) => `${(i.path ?? []).join(".") || "input"}: ${i.message ?? "invalid"}`)
        .join("; ");
    }
    if (err.message) return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** The chatbot was created but a later write failed. Carries the new id so the shell can open it. */
class PartialCreateError extends Error {
  readonly createdId: string;
  constructor(message: string, createdId: string) {
    super(message);
    this.name = "PartialCreateError";
    this.createdId = createdId;
  }
}

const draftKey = (id: string | null) => `chatbot-wizard-draft:${id ?? "new"}`;

function readDraft(id: string | null): WizardState | null {
  try {
    const raw = window.localStorage.getItem(draftKey(id));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? withDefaults(parsed as Partial<WizardState>) : null;
  } catch {
    return null;
  }
}

function writeDraft(id: string | null, state: WizardState): void {
  try {
    window.localStorage.setItem(draftKey(id), JSON.stringify(state));
  } catch {
    // Storage full or blocked. The edits stay in memory until the page closes.
  }
}

function clearDraft(id: string | null): void {
  try {
    window.localStorage.removeItem(draftKey(id));
  } catch {
    // Nothing to clear if storage is blocked.
  }
}

function stepUrl(chatbotId: string | null, step: StepId): string {
  const base = chatbotId === null ? WIZARD_PATH : `${WIZARD_PATH}/${encodeURIComponent(chatbotId)}`;
  return `${base}?step=${step}`;
}

export default function ChatbotWizard() {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [match, params] = useRoute<{ id?: string }>(ROUTE_PATTERN);
  const chatbotId: string | null = match && params?.id ? params.id : null;
  const loadKey = chatbotId ?? "new";
  // Same auth source as the list page.
  const [signedIn] = useState(() => Boolean(AuthStorage.getAuthHeader()));

  const requestedStep = new URLSearchParams(window.location.search).get("step");
  const requested = STEPS.find((s) => s.id === requestedStep) ?? STEPS[0];
  // Without a saved chatbot only the first step can be shown.
  const current = chatbotId === null ? STEPS[0] : requested;
  const currentIndex = STEPS.indexOf(current);

  const builderQuery = useQuery<BuilderSnapshot>({
    queryKey: builderQueryKey(loadKey),
    queryFn: () => getBuilder(chatbotId ?? ""),
    enabled: signedIn && chatbotId !== null,
  });

  const [draft, setDraft] = useState<WizardState>(EMPTY_WIZARD_STATE);
  const [baseline, setBaseline] = useState<WizardState>(EMPTY_WIZARD_STATE);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Read by the mutation callbacks, which can run after a newer render.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // Load the server copy (or an empty state for a new chatbot), then apply any saved draft on top of it.
  useEffect(() => {
    if (loadedFor === loadKey) return;
    if (chatbotId === null) {
      const saved = readDraft(null);
      setBaseline(EMPTY_WIZARD_STATE);
      setDraft(saved ?? EMPTY_WIZARD_STATE);
      setRestoredDraft(saved !== null && changedGroups(saved, EMPTY_WIZARD_STATE).length > 0);
      setLoadedFor(loadKey);
      return;
    }
    if (!builderQuery.data) return;
    const server = withDefaults(builderQuery.data.state);
    const saved = readDraft(chatbotId);
    setBaseline(server);
    setDraft(saved ?? server);
    setRestoredDraft(saved !== null && changedGroups(saved, server).length > 0);
    setLoadedFor(loadKey);
  }, [chatbotId, loadKey, loadedFor, builderQuery.data]);

  const isReady = loadedFor === loadKey;
  const compareTo = chatbotId === null ? EMPTY_WIZARD_STATE : baseline;
  const dirtyGroups = useMemo(() => changedGroups(draft, compareTo), [draft, compareTo]);
  const isDirty = dirtyGroups.length > 0;

  // Keep the unsaved draft in localStorage while it differs from the server copy.
  useEffect(() => {
    if (!isReady) return;
    if (changedGroups(draft, compareTo).length === 0) clearDraft(chatbotId);
    else writeDraft(chatbotId, draft);
  }, [draft, compareTo, isReady, chatbotId]);

  // Warn before leaving the page with unsaved changes.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  const saveMutation = useMutation({
    mutationFn: async (state: WizardState): Promise<{ id: string; snapshot: BuilderSnapshot | null }> => {
      if (chatbotId === null) {
        const problem = validateConfigure(state.configure);
        if (problem) throw new Error(problem);
        const c = state.configure;
        // EXISTS: POST /api/chatbot/chatbots takes only the six classic fields.
        const created = await createChatbot({
          title: c.title.trim(),
          language: c.language,
          welcomeMessage: c.welcomeMessage.trim() === "" ? null : c.welcomeMessage,
          instructions: c.instructions.trim() === "" ? null : c.instructions,
          active: c.active,
        });
        try {
          // NEW: the rest of the state. Failing here must not lose the new id, so it is wrapped below.
          const snapshot = await patchBuilder(created.id, buildPatch(state, SAVED_GROUPS));
          return { id: created.id, snapshot };
        } catch (err) {
          throw new PartialCreateError(errorMessage(err, "Could not save the chatbot."), created.id);
        }
      }

      const groups = changedGroups(state, baseline);
      if (groups.length === 0) return { id: chatbotId, snapshot: null };
      if (groups.includes("configure")) {
        const problem = validateConfigure(state.configure);
        if (problem) throw new Error(problem);
      }
      const snapshot = await patchBuilder(chatbotId, buildPatch(state, groups));
      return { id: chatbotId, snapshot };
    },
    onSuccess: ({ id, snapshot }, state) => {
      if (!snapshot) return;
      setFormError(null);
      queryClient.setQueryData(builderQueryKey(id), snapshot);
      queryClient.invalidateQueries({ queryKey: CHATBOTS_QUERY_KEY });
      if (chatbotId === null) {
        // Edits typed while the request ran stay as a draft under the new id.
        const latest = draftRef.current;
        if (changedGroups(latest, snapshot.state).length > 0) writeDraft(id, latest);
        else clearDraft(id);
        clearDraft(null);
        navigate(stepUrl(id, current.id), { replace: true });
      } else {
        setBaseline(withDefaults(snapshot.state));
      }
      toast({ title: "Chatbot saved" });
    },
    onError: (err, state) => {
      if (err instanceof PartialCreateError) {
        writeDraft(err.createdId, state);
        clearDraft(null);
        setFormError(err.message);
        navigate(stepUrl(err.createdId, current.id), { replace: true });
        return;
      }
      setFormError(errorMessage(err, "Could not save the chatbot."));
    },
  });

  /** Saves changed groups. Resolves to the chatbot id, or null when the save failed. */
  async function saveNow(): Promise<string | null> {
    try {
      const result = await saveMutation.mutateAsync(draftRef.current);
      return result.id;
    } catch {
      // onError has already set the message and any navigation.
      return null;
    }
  }

  function updateGroup(group: StepId, patch: object) {
    setDraft((prev) => ({ ...prev, [group]: { ...prev[group], ...patch } }) as WizardState);
  }

  function discardDraft() {
    clearDraft(chatbotId);
    setDraft(compareTo);
    setRestoredDraft(false);
  }

  async function goTo(target: StepDefinition) {
    setFormError(null);
    const targetIndex = STEPS.indexOf(target);
    // Moving forward saves first. A new chatbot is created here.
    if (targetIndex > currentIndex && (isDirty || chatbotId === null)) {
      const id = await saveNow();
      if (id === null) return;
      navigate(stepUrl(id, target.id), { replace: true });
      return;
    }
    navigate(stepUrl(chatbotId, target.id), { replace: true });
  }

  if (!signedIn) {
    return <div className="p-6 text-sm text-muted-foreground">Sign in to open the chatbot builder.</div>;
  }

  if (chatbotId !== null && builderQuery.isError) {
    return (
      <div className="space-y-4 p-6">
        <Alert variant="destructive">
          <AlertTitle>Could not load this chatbot</AlertTitle>
          <AlertDescription>{errorMessage(builderQuery.error, "Request failed.")}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={() => navigate(LIST_PATH)}>
          Back to chatbots
        </Button>
      </div>
    );
  }

  if (!isReady) {
    return (
      <div className="space-y-3 p-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const busy = saveMutation.isPending;
  const StepComponent = current.component;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate(LIST_PATH)}>
            <ChevronLeft className="mr-1 h-4 w-4" />
            All chatbots
          </Button>
          <h1 className="text-xl font-semibold">{draft.configure.title.trim() || "New chatbot"}</h1>
          {isDirty && <Badge variant="outline">Unsaved changes</Badge>}
        </div>
      </div>

      {restoredDraft && (
        <Alert>
          <AlertTitle>Unsaved changes restored</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>These edits are not saved to the server yet.</span>
            <Button size="sm" variant="outline" onClick={discardDraft} disabled={busy}>
              Discard
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {formError && (
        <Alert variant="destructive">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}

      <nav aria-label="Builder steps" className="flex flex-wrap gap-2">
        {STEPS.map((step, i) => (
          <Button
            key={step.id}
            size="sm"
            variant={step.id === current.id ? "default" : "outline"}
            aria-current={step.id === current.id ? "step" : undefined}
            disabled={busy || (chatbotId === null && i > 0)}
            onClick={() => void goTo(step)}
          >
            {i + 1}. {step.label}
          </Button>
        ))}
      </nav>

      <Card className="space-y-4 p-4">
        <div className="text-sm font-medium">{current.label}</div>
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <StepComponent
            step={current.id}
            value={draft[current.group]}
            onChange={(patch: object) => updateGroup(current.group, patch)}
            chatbotId={chatbotId}
            disabled={busy}
            saveNow={async () => (await saveNow()) !== null}
          />
        </Suspense>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="outline"
          disabled={currentIndex === 0 || busy}
          onClick={() => void goTo(STEPS[currentIndex - 1])}
        >
          <ChevronLeft className="mr-1.5 h-4 w-4" />
          Back
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" disabled={busy || !isDirty} onClick={() => void saveNow()}>
            {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Save className="mr-1.5 h-4 w-4" />}
            {busy ? "Saving..." : "Save"}
          </Button>
          {currentIndex < STEPS.length - 1 && (
            <Button disabled={busy} onClick={() => void goTo(STEPS[currentIndex + 1])}>
              Next
              <ChevronRight className="ml-1.5 h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
