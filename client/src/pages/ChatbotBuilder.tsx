/**
 * Chatbot builder screen. Calls the /api/chatbot routes directly (chatbot-routes.ts).
 *
 * Sections: chatbot list, create/edit form, read-only recent conversations for the selected chatbot.
 * Requests go through apiRequest from lib/queryClient, which attaches AuthStorage.getAuthHeader()
 * as the Bearer token and handles token refresh and ApiError messages.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Plus, RefreshCw, Save } from "lucide-react";

const BASE = "/api/chatbot";
const CONVERSATION_PAGE_SIZE = 20;

// Wire shapes. Dates arrive as ISO strings in JSON.
interface ChatbotRecord {
  id: string;
  title: string;
  language: string;
  welcomeMessage: string | null;
  instructions: string | null;
  generativeUiEnabled: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ConversationListItem {
  id: string;
  chatbotId: string;
  sessionId: string;
  channel: string;
  ticketStatus: "new" | "closed";
  pinned: boolean;
  connectAgentAt: string | null;
  lastActivityAt: string;
  hasUnreadUserMessage: boolean;
}

interface Page<T> {
  data: T[];
  total: number;
  page: number;
  perPage: number;
}

interface Draft {
  title: string;
  language: string;
  welcomeMessage: string;
  instructions: string;
  generativeUiEnabled: boolean;
  active: boolean;
}

const EMPTY_DRAFT: Draft = {
  title: "",
  language: "en",
  welcomeMessage: "",
  instructions: "",
  generativeUiEnabled: false,
  active: true,
};

const CHATBOTS_KEY = ["chatbot", "chatbots"] as const;

function draftFrom(bot: ChatbotRecord): Draft {
  return {
    title: bot.title,
    language: bot.language,
    welcomeMessage: bot.welcomeMessage ?? "",
    instructions: bot.instructions ?? "",
    generativeUiEnabled: bot.generativeUiEnabled,
    active: bot.active,
  };
}

/** Maps the form to the strict body schemas. Blank optional text is sent as null. */
function toPayload(d: Draft) {
  return {
    title: d.title.trim(),
    language: d.language.trim(),
    welcomeMessage: d.welcomeMessage.trim() === "" ? null : d.welcomeMessage,
    instructions: d.instructions.trim() === "" ? null : d.instructions,
    generativeUiEnabled: d.generativeUiEnabled,
    active: d.active,
  };
}

/** Mirrors the zod limits in chatbot-routes.ts so most mistakes are caught before a request. */
function validateDraft(d: Draft): string | null {
  const title = d.title.trim();
  if (title.length === 0) return "Title is required.";
  if (title.length > 200) return "Title must be 200 characters or fewer.";
  const language = d.language.trim();
  if (language.length < 2 || language.length > 10) return "Language must be 2 to 10 characters.";
  if (d.welcomeMessage.length > 2000) return "Welcome message must be 2000 characters or fewer.";
  if (d.instructions.length > 20000) return "Instructions must be 20000 characters or fewer.";
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

function formatDateTime(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

async function fetchChatbots(): Promise<ChatbotRecord[]> {
  const res = await apiRequest("GET", `${BASE}/chatbots`);
  return (await res.json()) as ChatbotRecord[];
}

async function fetchConversations(chatbotId: string): Promise<Page<ConversationListItem>> {
  // The server filters by chatbot_id, so only this chatbot's conversations are returned.
  const qs = new URLSearchParams({
    chatbot_id: chatbotId,
    per_page: String(CONVERSATION_PAGE_SIZE),
    sort: "newest",
  });
  const res = await apiRequest("GET", `${BASE}/conversations?${qs.toString()}`);
  return (await res.json()) as Page<ConversationListItem>;
}

export default function ChatbotBuilder() {
  const { toast } = useToast();
  // Same auth source as the rest of the client (AuthStorage.getAuthHeader).
  const [signedIn] = useState(() => Boolean(AuthStorage.getAuthHeader()));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<string | null>(null);

  const chatbotsQuery = useQuery<ChatbotRecord[]>({
    queryKey: CHATBOTS_KEY,
    queryFn: fetchChatbots,
    enabled: signedIn,
  });
  const chatbots = chatbotsQuery.data ?? [];
  const selected = chatbots.find((b) => b.id === selectedId) ?? null;
  const showForm = creating || selected !== null;

  const conversationsQuery = useQuery<Page<ConversationListItem>>({
    queryKey: ["chatbot", "conversations", selectedId],
    queryFn: () => fetchConversations(selectedId ?? ""),
    enabled: signedIn && selectedId !== null && !creating,
  });

  // Select the first chatbot once the list loads.
  useEffect(() => {
    if (creating || selectedId !== null || chatbots.length === 0) return;
    setSelectedId(chatbots[0].id);
    setDraft(draftFrom(chatbots[0]));
  }, [chatbots, creating, selectedId]);

  const saveMutation = useMutation({
    mutationFn: async (payload: ReturnType<typeof toPayload>) => {
      const res = creating
        ? await apiRequest("POST", `${BASE}/chatbots`, payload)
        : await apiRequest("PATCH", `${BASE}/chatbots/${selectedId}`, payload);
      return (await res.json()) as ChatbotRecord;
    },
    onSuccess: (saved) => {
      setCreating(false);
      setSelectedId(saved.id);
      setDraft(draftFrom(saved));
      setFormError(null);
      queryClient.invalidateQueries({ queryKey: CHATBOTS_KEY });
      toast({ title: "Chatbot saved" });
    },
    onError: (err) => {
      setFormError(errorMessage(err, "Could not save the chatbot."));
    },
  });

  function selectChatbot(bot: ChatbotRecord) {
    setCreating(false);
    setSelectedId(bot.id);
    setDraft(draftFrom(bot));
    setFormError(null);
  }

  function startCreate() {
    setCreating(true);
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setFormError(null);
  }

  function update(patch: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...patch }));
  }

  function save() {
    const problem = validateDraft(draft);
    if (problem) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    saveMutation.mutate(toPayload(draft));
  }

  if (!signedIn) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Sign in to open the chatbot builder.
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Chatbot Builder</h1>
        <Button size="sm" onClick={startCreate} disabled={saveMutation.isPending}>
          <Plus className="mr-1.5 h-4 w-4" />
          New chatbot
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
        {/* Section 1: chatbot list (GET /api/chatbot/chatbots) */}
        <Card className="p-3 space-y-2 self-start">
          <div className="text-sm font-medium">Chatbots</div>
          {chatbotsQuery.isLoading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : chatbotsQuery.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load chatbots</AlertTitle>
              <AlertDescription className="space-y-2">
                <p>{errorMessage(chatbotsQuery.error, "Request failed.")}</p>
                <Button size="sm" variant="outline" onClick={() => chatbotsQuery.refetch()}>
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : chatbots.length === 0 ? (
            <p className="text-sm text-muted-foreground">No chatbots yet. Create one to get started.</p>
          ) : (
            <ul className="space-y-1">
              {chatbots.map((bot) => (
                <li key={bot.id}>
                  <button
                    type="button"
                    onClick={() => selectChatbot(bot)}
                    className={`w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${
                      bot.id === selectedId && !creating ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <span className="block truncate">{bot.title}</span>
                    <span className="text-xs text-muted-foreground">
                      {bot.active ? "Active" : "Inactive"} · {bot.language}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4 min-w-0">
          {/* Section 2: create or edit form (POST /api/chatbot/chatbots, PATCH /api/chatbot/chatbots/:id) */}
          {showForm ? (
            <Card className="p-4 space-y-4">
              <div className="text-sm font-medium">{creating ? "New chatbot" : "Edit chatbot"}</div>

              <div className="space-y-1.5">
                <Label htmlFor="chatbot-title">Title</Label>
                <Input
                  id="chatbot-title"
                  value={draft.title}
                  maxLength={200}
                  onChange={(e) => update({ title: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="chatbot-language">Language</Label>
                <Input
                  id="chatbot-language"
                  value={draft.language}
                  maxLength={10}
                  placeholder="en"
                  onChange={(e) => update({ language: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="chatbot-welcome">Welcome message</Label>
                <Textarea
                  id="chatbot-welcome"
                  rows={3}
                  value={draft.welcomeMessage}
                  maxLength={2000}
                  onChange={(e) => update({ welcomeMessage: e.target.value })}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="chatbot-instructions">Instructions</Label>
                <Textarea
                  id="chatbot-instructions"
                  rows={8}
                  value={draft.instructions}
                  maxLength={20000}
                  onChange={(e) => update({ instructions: e.target.value })}
                />
              </div>

              <div className="flex flex-wrap gap-6">
                <div className="flex items-center gap-2">
                  <Switch
                    id="chatbot-active"
                    checked={draft.active}
                    onCheckedChange={(checked) => update({ active: checked })}
                  />
                  <Label htmlFor="chatbot-active">Active</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="chatbot-generative-ui"
                    checked={draft.generativeUiEnabled}
                    onCheckedChange={(checked) => update({ generativeUiEnabled: checked })}
                  />
                  <Label htmlFor="chatbot-generative-ui">Generative UI</Label>
                </div>
              </div>

              {formError && (
                <Alert variant="destructive">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button onClick={save} disabled={saveMutation.isPending}>
                  {saveMutation.isPending ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 h-4 w-4" />
                  )}
                  {saveMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </div>
            </Card>
          ) : (
            <Card className="p-4 text-sm text-muted-foreground">
              Select a chatbot to edit it, or create a new one.
            </Card>
          )}

          {/* Section 3: recent conversations, read-only (GET /api/chatbot/conversations?chatbot_id=) */}
          <Card className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium">Recent conversations</div>
              {selectedId !== null && !creating && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => conversationsQuery.refetch()}
                  disabled={conversationsQuery.isFetching}
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${conversationsQuery.isFetching ? "animate-spin" : ""}`} />
                </Button>
              )}
            </div>

            {selectedId === null || creating ? (
              <p className="text-sm text-muted-foreground">Save the chatbot to see its conversations.</p>
            ) : conversationsQuery.isLoading ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : conversationsQuery.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load conversations</AlertTitle>
                <AlertDescription>
                  {errorMessage(conversationsQuery.error, "Request failed.")}
                </AlertDescription>
              </Alert>
            ) : (conversationsQuery.data?.data.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">No conversations for this chatbot yet.</p>
            ) : (
              <ul className="divide-y">
                {conversationsQuery.data?.data.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-xs">{c.sessionId}</div>
                      <div className="text-xs text-muted-foreground">
                        {c.channel} · {formatDateTime(c.lastActivityAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {c.hasUnreadUserMessage && <Badge>Unread</Badge>}
                      {c.connectAgentAt && <Badge variant="secondary">Agent</Badge>}
                      <Badge variant="outline">{c.ticketStatus}</Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {conversationsQuery.data && conversationsQuery.data.total > 0 && selectedId !== null && !creating && (
              <p className="text-xs text-muted-foreground">
                Showing {conversationsQuery.data.data.length} of {conversationsQuery.data.total}.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
