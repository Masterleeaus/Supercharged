/**
 * Knowledge-base articles: list, create, edit and delete. Company-scoped on the backend.
 * Articles can be linked to chatbots of the same company. The backend refuses any link to another company.
 * Chatbot choices come from the existing chatbots list (GET /api/chatbot/chatbots), passed in as a prop so the
 * owner can wire the source.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import {
  articlesKey,
  chatbotOptionsKey,
  createArticle,
  deleteArticle,
  errorMessage,
  isPending,
  listArticles,
  listChatbotOptions,
  updateArticle,
} from "./api";
import type { ArticleFormBody, KnowledgeBaseArticle } from "./types";
import { EmptyState, ErrorState, LoadingRows, PendingState } from "./shared";

/** Must match CONTENT_LIMITS in server/modules/chatbot/content-admin/schemas.ts. */
const TITLE_MAX = 255;
const DESCRIPTION_MAX = 1000;
const CONTENT_MAX = 50000;

export interface ChatbotOption {
  id: string;
  title: string;
}

interface Props {
  /** Optional. The company's chatbots for the link checkboxes. When omitted, the page loads GET /api/chatbot/chatbots. */
  chatbots?: ChatbotOption[];
}

type Draft = ArticleFormBody & { id: string | null };
const EMPTY: Draft = { id: null, title: "", description: "", content: "", isFeatured: false, chatbotIds: [] };

export default function KnowledgeBasePage({ chatbots: chatbotsProp }: Props) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<KnowledgeBaseArticle | null>(null);

  const listQuery = useQuery<KnowledgeBaseArticle[]>({ queryKey: articlesKey, queryFn: listArticles, retry: false });
  const botsQuery = useQuery<ChatbotOption[]>({
    queryKey: chatbotOptionsKey,
    queryFn: listChatbotOptions,
    enabled: chatbotsProp === undefined,
  });
  const chatbots: ChatbotOption[] = chatbotsProp ?? botsQuery.data ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: articlesKey });
  const titleOf = (id: string) => chatbots.find((c) => c.id === id)?.title ?? "Chatbot";

  const saveMutation = useMutation({
    mutationFn: (d: Draft) => {
      const body: ArticleFormBody = {
        title: d.title.trim(),
        description: d.description.trim(),
        content: d.content?.trim() ? d.content : null,
        isFeatured: d.isFeatured,
        chatbotIds: d.chatbotIds,
      };
      return d.id ? updateArticle(d.id, body) : createArticle(body);
    },
    onSuccess: (_row, d) => {
      toast({ title: d.id ? "Article saved" : "Article created" });
      setDraft(null);
      setFormError(null);
      refresh();
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteArticle(id),
    onSuccess: () => {
      toast({ title: "Article deleted" });
      setToDelete(null);
      refresh();
    },
    onError: (err) => {
      setToDelete(null);
      toast({ title: "Could not delete", description: errorMessage(err), variant: "destructive" });
    },
  });

  const openNew = () => {
    setFormError(null);
    setDraft({ ...EMPTY });
  };
  const openEdit = (row: KnowledgeBaseArticle) => {
    setFormError(null);
    setDraft({
      id: row.id,
      title: row.title,
      description: row.description,
      content: row.content ?? "",
      isFeatured: row.isFeatured,
      chatbotIds: row.chatbotIds,
    });
  };
  const toggleChatbot = (id: string, checked: boolean) => {
    if (!draft) return;
    const next = checked ? [...draft.chatbotIds, id] : draft.chatbotIds.filter((x) => x !== id);
    setDraft({ ...draft, chatbotIds: next });
  };

  const canSave =
    !!draft && draft.title.trim().length > 0 && draft.description.trim().length > 0 && !saveMutation.isPending;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Knowledge base</h1>
          <p className="text-sm text-muted-foreground">Articles your chatbots can use to answer questions.</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          New article
        </Button>
      </div>

      {isPending(listQuery.error) ? (
        <PendingState title="Knowledge base is not connected yet">
          The article routes are not mounted on this server. Articles will show here once they are.
        </PendingState>
      ) : listQuery.error ? (
        <ErrorState message={errorMessage(listQuery.error)} />
      ) : listQuery.isLoading ? (
        <LoadingRows />
      ) : !listQuery.data?.length ? (
        <EmptyState title="No articles yet" action={<Button variant="outline" onClick={openNew}>Write the first one</Button>} />
      ) : (
        <ul className="space-y-3">
          {listQuery.data.map((row) => (
            <li key={row.id}>
              <Card>
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{row.title}</p>
                      {row.isFeatured && <Badge variant="secondary">Featured</Badge>}
                    </div>
                    <p className="text-sm text-muted-foreground">{row.description}</p>
                    {row.chatbotIds.length > 0 && (
                      <p className="text-xs text-muted-foreground">Used by: {row.chatbotIds.map(titleOf).join(", ")}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button variant="outline" size="icon" aria-label={`Edit ${row.title}`} onClick={() => openEdit(row)}>
                      <Pencil className="h-4 w-4" aria-hidden="true" />
                    </Button>
                    <Button variant="outline" size="icon" aria-label={`Delete ${row.title}`} onClick={() => setToDelete(row)}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit article" : "New article"}</DialogTitle>
            <DialogDescription>The description shows in lists. The content is what chatbots read.</DialogDescription>
          </DialogHeader>
          {draft && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (canSave) saveMutation.mutate(draft);
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="kb-title">Title</Label>
                <Input id="kb-title" maxLength={TITLE_MAX} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="kb-description">Short description</Label>
                <Textarea id="kb-description" rows={2} maxLength={DESCRIPTION_MAX} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="kb-content">Content</Label>
                <Textarea id="kb-content" rows={10} maxLength={CONTENT_MAX} value={draft.content ?? ""} onChange={(e) => setDraft({ ...draft, content: e.target.value })} />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="kb-featured">Featured</Label>
                <Switch id="kb-featured" checked={draft.isFeatured} onCheckedChange={(v) => setDraft({ ...draft, isFeatured: v })} />
              </div>
              {chatbots.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">Use in these chatbots</legend>
                  {chatbots.map((bot) => (
                    <label key={bot.id} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={draft.chatbotIds.includes(bot.id)}
                        onCheckedChange={(v) => toggleChatbot(bot.id, v === true)}
                      />
                      {bot.title}
                    </label>
                  ))}
                </fieldset>
              )}
              {formError && (
                <p role="alert" className="text-sm text-destructive">
                  {formError}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setDraft(null)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!canSave}>
                  {saveMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this article?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete ? `"${toDelete.title}" will be removed and chatbots will stop using it.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (toDelete) deleteMutation.mutate(toDelete.id);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
