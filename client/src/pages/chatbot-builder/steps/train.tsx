/**
 * Train step for the chatbot builder wizard. Ports core's edit-step-train.blade.php: four source tabs
 * (website, PDF, text, Q&A), the source list, and the Train and Delete actions.
 *
 * Wired now:
 * - Text and Q&A entries are saved as source records. Core stores these before any embedding runs.
 * - The source list is read from the server and refreshes after each save.
 *
 * Pending (EXTERNAL): website crawl, PDF upload, Train and Delete. They need a crawler, a PDF or spreadsheet
 * parser and an embeddings store that Desk does not have yet. Each one calls its route. A failure (501 or
 * any other error) shows the "Training backend not connected in Desk yet" state. Nothing here calls an AI or
 * embeddings provider from the browser.
 *
 * The sources routes are NOT in server/modules/chatbot/builder-routes/endpoint-map.md yet. They are proposed
 * below under /api/chatbot/builder/:id/sources. See DECISIONS.md, section "Train step".
 */
import { useState, type ChangeEvent, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest, queryClient } from "@/lib/queryClient";
import { AuthStorage } from "@/lib/auth-storage";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Loader2, Trash2 } from "lucide-react";
import type { StepProps } from "../types";

// ---------------------------------------------------------------------------
// Types and limits
// ---------------------------------------------------------------------------

/** Source types. Same values as core's EmbeddingTypeEnum. "file" is the PDF tab. */
type SourceType = "website" | "file" | "text" | "qa";
type TabId = "website" | "pdf" | "text" | "qa";

const TABS: { id: TabId; label: string; sourceType: SourceType }[] = [
  { id: "website", label: "Website", sourceType: "website" },
  { id: "pdf", label: "PDF", sourceType: "file" },
  { id: "text", label: "Text", sourceType: "text" },
  { id: "qa", label: "Q&A", sourceType: "qa" },
];

/** Wire shape of one source record. Not in the contract yet (see the note at the top). */
interface TrainSource {
  id: string;
  type: SourceType;
  title: string;
  url: string | null;
  /** True once the source is embedded. Core shows this as the "Trained" badge. */
  trained: boolean;
}

interface TextEntryBody {
  type: "text" | "qa";
  /** Text title, or the question for Q&A. */
  title: string;
  /** Text body, or the answer for Q&A. */
  content: string;
}

/**
 * Core's PDF tab says "Max: 25Mb" and accepts PDF, XLSX and CSV. Core's request class sets no size or type
 * limit, so these come from the core UI copy and the parsers that ChatbotTrainController routes to.
 */
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const FILE_EXTENSIONS = ["pdf", "xlsx", "xls", "csv", "txt", "json"] as const;
const FILE_ACCEPT = FILE_EXTENSIONS.map((ext) => `.${ext}`).join(",");

/** Desk-side limit for a typed URL. Core sets none. */
const URL_MAX_LENGTH = 2048;

// ---------------------------------------------------------------------------
// Client-side validation
// ---------------------------------------------------------------------------

/** Core's TrainUrlRequest uses Laravel's url rule. The crawler needs http or https, so only those pass here. */
function validateUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter a URL.";
  if (value.length > URL_MAX_LENGTH) return `The URL must be ${URL_MAX_LENGTH} characters or fewer.`;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "Enter a full URL, starting with https:// or http://.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The URL must start with http:// or https://.";
  }
  if (!parsed.hostname.includes(".")) return "Enter a URL with a domain, for example https://example.com.";
  return null;
}

function validateFile(file: File): string | null {
  const dot = file.name.lastIndexOf(".");
  const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (!(FILE_EXTENSIONS as readonly string[]).includes(ext)) {
    return `Choose a file of type ${FILE_EXTENSIONS.join(", ").toUpperCase()}.`;
  }
  if (file.size === 0) return "This file is empty.";
  if (file.size > FILE_MAX_BYTES) return "This file is larger than 25 MB.";
  return null;
}

function validatePair(firstLabel: string, first: string, secondLabel: string, second: string): string | null {
  if (first.trim() === "") return `${firstLabel} is required.`;
  if (second.trim() === "") return `${secondLabel} is required.`;
  return null;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

const SOURCES_BASE = (chatbotId: string) => `/api/chatbot/builder/${encodeURIComponent(chatbotId)}/sources`;
const sourcesKey = (chatbotId: string) => ["chatbot", "builder", chatbotId, "sources"] as const;

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function errorFromBody(data: unknown): string | null {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return null;
}

/** NEW (proposed, not in endpoint-map.md). GET the source list for this chatbot. */
async function listSources(chatbotId: string): Promise<TrainSource[]> {
  const res = await apiRequest("GET", SOURCES_BASE(chatbotId));
  return (await res.json()) as TrainSource[];
}

/** NEW, wired (proposed, not in endpoint-map.md). POST a text or Q&A source record. Saved without embedding. */
async function createTextSource(chatbotId: string, body: TextEntryBody): Promise<TrainSource> {
  const res = await apiRequest("POST", SOURCES_BASE(chatbotId), body);
  return (await res.json()) as TrainSource;
}

/** EXTERNAL. Crawl a website, all linked pages or one page. Needs core's LinkParser equivalent. */
async function crawlWebsite(chatbotId: string, url: string, single: boolean): Promise<TrainSource[]> {
  const res = await apiRequest("POST", `${SOURCES_BASE(chatbotId)}/website`, { url, single });
  return (await res.json()) as TrainSource[];
}

/** EXTERNAL. Multipart upload plus parse. apiRequest only sends JSON, so this sends FormData itself. */
async function uploadFileSource(chatbotId: string, file: File): Promise<TrainSource[]> {
  const form = new FormData();
  form.append("file", file);
  const headers: Record<string, string> = { Accept: "application/json" };
  const auth = AuthStorage.getAuthHeader();
  if (auth) headers.Authorization = auth;

  const res = await fetch(`${SOURCES_BASE(chatbotId)}/file`, {
    method: "POST",
    headers,
    body: form,
    credentials: "include",
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(errorFromBody(data) ?? `Upload failed (${res.status})`, res.status, data);
  }
  if (!Array.isArray(data)) throw new Error("Unexpected response from the upload route.");
  return data as TrainSource[];
}

/** EXTERNAL. Generate embeddings for the selected sources. Needs the embeddings provider. */
async function trainSources(chatbotId: string, ids: string[]): Promise<TrainSource[]> {
  const res = await apiRequest("POST", `${SOURCES_BASE(chatbotId)}/train`, { ids });
  return (await res.json()) as TrainSource[];
}

/** EXTERNAL. Delete one source and its embeddings. */
async function deleteSource(chatbotId: string, sourceId: string): Promise<void> {
  await apiRequest("DELETE", `${SOURCES_BASE(chatbotId)}/${encodeURIComponent(sourceId)}`);
}

// ---------------------------------------------------------------------------
// Source list
// ---------------------------------------------------------------------------

interface SourceListProps {
  tabLabel: string;
  sources: TrainSource[];
  selected: string[];
  locked: boolean;
  trainPending: boolean;
  deletingId: string | null;
  onToggle: (sourceId: string) => void;
  onToggleAll: () => void;
  onDelete: (sourceId: string) => void;
  onTrain: () => void;
}

function SourceList({
  tabLabel,
  sources,
  selected,
  locked,
  trainPending,
  deletingId,
  onToggle,
  onToggleAll,
  onDelete,
  onTrain,
}: SourceListProps) {
  const allSelected = sources.length > 0 && sources.every((s) => selected.includes(s.id));

  return (
    <section aria-label={`${tabLabel} sources`} className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">Sources ({sources.length})</h3>
        {sources.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onToggleAll} disabled={locked}>
            {allSelected ? "Deselect all" : "Select all"}
          </Button>
        )}
      </div>

      {sources.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {tabLabel.toLowerCase()} sources yet.</p>
      ) : (
        <ul className="space-y-2">
          {sources.map((source) => {
            const name = source.title || source.url || "Untitled source";
            return (
              <li key={source.id} className="flex items-center gap-3 rounded-lg border p-2">
                <input
                  id={`train-source-${source.id}`}
                  type="checkbox"
                  className="size-4 shrink-0"
                  checked={selected.includes(source.id)}
                  onChange={() => onToggle(source.id)}
                  disabled={locked}
                />
                <Label htmlFor={`train-source-${source.id}`} className="min-w-0 flex-1 truncate text-sm font-normal">
                  {name}
                </Label>
                <Badge variant={source.trained ? "default" : "outline"} className="whitespace-nowrap">
                  {source.trained ? "Trained" : "Not trained"}
                </Badge>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${name}`}
                  onClick={() => onDelete(source.id)}
                  disabled={locked}
                >
                  {deletingId === source.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {sources.length > 0 && (
        <Button className="w-full" onClick={onTrain} disabled={locked || selected.length === 0}>
          {trainPending ? (
            <>
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              Training...
            </>
          ) : (
            `Train selected sources (${selected.length})`
          )}
        </Button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export default function TrainStep({ chatbotId, disabled }: StepProps<"train">) {
  const { toast } = useToast();
  const [tab, setTab] = useState<TabId>("website");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [backendIssue, setBackendIssue] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  const [url, setUrl] = useState("");
  const [singleUrl, setSingleUrl] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [textTitle, setTextTitle] = useState("");
  const [textContent, setTextContent] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");

  const ready = chatbotId !== null;
  const id = chatbotId ?? "";

  const sourcesQuery = useQuery<TrainSource[]>({
    queryKey: sourcesKey(id),
    queryFn: () => listSources(id),
    enabled: ready,
  });
  const sources = sourcesQuery.data ?? [];
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];
  const tabSources = sources.filter((s) => s.type === current.sourceType);
  const selectedHere = tabSources.filter((s) => selected.includes(s.id)).map((s) => s.id);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: sourcesKey(id) });
  }

  function changeTab(next: TabId) {
    setTab(next);
    setFieldError(null);
  }

  // Wired: text and Q&A records.
  const saveEntry = useMutation({
    mutationFn: (body: TextEntryBody) => createTextSource(id, body),
    onSuccess: (_created, body) => {
      setFieldError(null);
      if (body.type === "qa") {
        setQuestion("");
        setAnswer("");
      } else {
        setTextTitle("");
        setTextContent("");
      }
      refresh();
      toast({ title: body.type === "qa" ? "Q&A saved" : "Text saved" });
    },
    onError: (err) => setFieldError(messageOf(err, "Could not save this entry.")),
  });

  // EXTERNAL: each one sets backendIssue on failure and clears it on success.
  const crawl = useMutation({
    mutationFn: (vars: { url: string; single: boolean }) => crawlWebsite(id, vars.url, vars.single),
    onSuccess: () => {
      setBackendIssue(null);
      setUrl("");
      refresh();
      toast({ title: "Pages added" });
    },
    onError: (err) => setBackendIssue(messageOf(err, "Could not fetch this URL.")),
  });

  const upload = useMutation({
    mutationFn: (chosen: File) => uploadFileSource(id, chosen),
    onSuccess: () => {
      setBackendIssue(null);
      setFile(null);
      setFileInputKey((k) => k + 1);
      refresh();
      toast({ title: "File added" });
    },
    onError: (err) => setBackendIssue(messageOf(err, "Could not upload this file.")),
  });

  const train = useMutation({
    mutationFn: (ids: string[]) => trainSources(id, ids),
    onSuccess: () => {
      setBackendIssue(null);
      setSelected([]);
      refresh();
      toast({ title: "Training done" });
    },
    onError: (err) => setBackendIssue(messageOf(err, "Training failed.")),
  });

  const remove = useMutation({
    mutationFn: (sourceId: string) => deleteSource(id, sourceId),
    onSuccess: (_done, sourceId) => {
      setBackendIssue(null);
      setSelected((prev) => prev.filter((x) => x !== sourceId));
      refresh();
      toast({ title: "Source deleted" });
    },
    onError: (err) => setBackendIssue(messageOf(err, "Could not delete this source.")),
  });

  const anyPending =
    saveEntry.isPending || crawl.isPending || upload.isPending || train.isPending || remove.isPending;
  const locked = disabled || !ready || anyPending;

  function submitUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const problem = validateUrl(url);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    crawl.mutate({ url: url.trim(), single: singleUrl });
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0] ?? null;
    if (!chosen) {
      setFile(null);
      setFieldError(null);
      return;
    }
    const problem = validateFile(chosen);
    if (problem) {
      // Clear the picker so the rejected file is not still shown as selected.
      setFile(null);
      setFileInputKey((k) => k + 1);
      setFieldError(problem);
      return;
    }
    setFile(chosen);
    setFieldError(null);
  }

  function submitFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) {
      setFieldError("Choose a file first.");
      return;
    }
    const problem = validateFile(file);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    upload.mutate(file);
  }

  function submitEntry(event: FormEvent<HTMLFormElement>, body: TextEntryBody, first: string, second: string) {
    event.preventDefault();
    const problem = validatePair(body.type === "qa" ? "Question" : "Title", first, body.type === "qa" ? "Answer" : "Text", second);
    if (problem) {
      setFieldError(problem);
      return;
    }
    setFieldError(null);
    saveEntry.mutate({ ...body, title: body.title.trim(), content: body.content.trim() });
  }

  function toggle(sourceId: string) {
    setSelected((prev) => (prev.includes(sourceId) ? prev.filter((x) => x !== sourceId) : [...prev, sourceId]));
  }

  function toggleAll() {
    const visible = tabSources.map((s) => s.id);
    const allVisibleSelected = visible.length > 0 && visible.every((x) => selected.includes(x));
    setSelected((prev) =>
      allVisibleSelected
        ? prev.filter((x) => !visible.includes(x))
        : Array.from(new Set([...prev, ...visible])),
    );
  }

  function askDelete(sourceId: string) {
    if (!window.confirm("Delete this source?")) return;
    remove.mutate(sourceId);
  }

  const listProps = {
    tabLabel: current.label,
    sources: tabSources,
    selected: selectedHere,
    locked,
    deletingId: remove.isPending ? (remove.variables ?? null) : null,
    onToggle: toggle,
    onToggleAll: toggleAll,
    onDelete: askDelete,
    onTrain: () => train.mutate(selectedHere),
    trainPending: train.isPending,
  };

  return (
    <div className="space-y-5">
      <p className="text-xs text-muted-foreground">
        This step is optional but highly recommended to personalize your chatbot experience.
      </p>

      {!ready && (
        <Alert>
          <AlertDescription>Save the chatbot first. Sources are added to a saved chatbot.</AlertDescription>
        </Alert>
      )}

      {backendIssue && (
        <Alert>
          <AlertTitle>Training backend not connected in Desk yet</AlertTitle>
          <AlertDescription>
            Website crawl, PDF upload, training and delete need a service that Desk does not have yet. Text and Q&A
            entries are still saved. Details: {backendIssue}
          </AlertDescription>
        </Alert>
      )}

      {sourcesQuery.isError && (
        <Alert>
          <AlertTitle>Could not load sources</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>{messageOf(sourcesQuery.error, "Request failed.")}</span>
            <Button size="sm" variant="outline" onClick={() => void sourcesQuery.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div role="tablist" aria-label="Source type" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Button
            key={t.id}
            role="tab"
            aria-selected={t.id === tab}
            size="sm"
            variant={t.id === tab ? "default" : "outline"}
            onClick={() => changeTab(t.id)}
            disabled={disabled || anyPending}
          >
            {t.label}
          </Button>
        ))}
      </div>

      {fieldError && (
        <Alert variant="destructive">
          <AlertDescription>{fieldError}</AlertDescription>
        </Alert>
      )}

      {tab === "website" && (
        <div className="space-y-5">
          <form className="space-y-4" onSubmit={submitUrl} noValidate>
            <h3 className="text-sm font-medium">1. Add URL</h3>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="train-crawl-mode"
                  className="size-4"
                  checked={!singleUrl}
                  onChange={() => setSingleUrl(false)}
                  disabled={locked}
                />
                Website
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="radio"
                  name="train-crawl-mode"
                  className="size-4"
                  checked={singleUrl}
                  onChange={() => setSingleUrl(true)}
                  disabled={locked}
                />
                Single URL
              </label>
            </div>
            <div className="space-y-2">
              <Label htmlFor="train-url">URL</Label>
              <div className="flex gap-2">
                <Input
                  id="train-url"
                  type="url"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  disabled={locked}
                />
                <Button type="submit" disabled={locked}>
                  {crawl.isPending ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Fetching...
                    </>
                  ) : (
                    "Fetch"
                  )}
                </Button>
              </div>
            </div>
          </form>

          <SourceList {...listProps} />
        </div>
      )}

      {tab === "pdf" && (
        <div className="space-y-5">
          <form className="space-y-4" onSubmit={submitFile} noValidate>
            <h3 className="text-sm font-medium">1. Add file</h3>
            <div className="space-y-2">
              <Label htmlFor="train-file">File</Label>
              <Input
                key={fileInputKey}
                id="train-file"
                type="file"
                accept={FILE_ACCEPT}
                onChange={chooseFile}
                disabled={locked}
              />
              <p className="text-xs text-muted-foreground">
                {file ? `Selected: ${file.name}` : "PDF, XLSX, XLS, CSV, TXT or JSON. Max 25 MB."}
              </p>
            </div>
            <Button type="submit" className="w-full" disabled={locked || !file}>
              {upload.isPending ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  Uploading...
                </>
              ) : (
                "Upload"
              )}
            </Button>
          </form>

          <SourceList {...listProps} />
        </div>
      )}

      {tab === "text" && (
        <div className="space-y-5">
          <form
            className="space-y-4"
            onSubmit={(e) => submitEntry(e, { type: "text", title: textTitle, content: textContent }, textTitle, textContent)}
            noValidate
          >
            <h3 className="text-sm font-medium">1. Add text</h3>
            <div className="space-y-2">
              <Label htmlFor="train-text-title">Title</Label>
              <Input
                id="train-text-title"
                placeholder="Type your title here"
                value={textTitle}
                onChange={(e) => setTextTitle(e.target.value)}
                disabled={locked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="train-text-content">Text</Label>
              <Textarea
                id="train-text-content"
                rows={6}
                placeholder="Type your text here"
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                disabled={locked}
              />
            </div>
            <Button type="submit" className="w-full" disabled={locked}>
              {saveEntry.isPending && saveEntry.variables?.type === "text" ? "Saving..." : "Add"}
            </Button>
          </form>

          <SourceList {...listProps} />
        </div>
      )}

      {tab === "qa" && (
        <div className="space-y-5">
          <form
            className="space-y-4"
            onSubmit={(e) => submitEntry(e, { type: "qa", title: question, content: answer }, question, answer)}
            noValidate
          >
            <h3 className="text-sm font-medium">1. Add Q&amp;A</h3>
            <div className="space-y-2">
              <Label htmlFor="train-qa-question">Question</Label>
              <Input
                id="train-qa-question"
                placeholder="Type the question here"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={locked}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="train-qa-answer">Answer</Label>
              <Textarea
                id="train-qa-answer"
                rows={6}
                placeholder="Type the answer here"
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                disabled={locked}
              />
            </div>
            <Button type="submit" className="w-full" disabled={locked}>
              {saveEntry.isPending && saveEntry.variables?.type === "qa" ? "Saving..." : "Add"}
            </Button>
          </form>

          <SourceList {...listProps} />
        </div>
      )}

      {ready && sourcesQuery.isPending && (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      )}
    </div>
  );
}
