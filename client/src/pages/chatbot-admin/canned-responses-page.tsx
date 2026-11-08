/**
 * Canned responses: list, create, edit and delete. Company-scoped on the backend.
 * Create and edit share one dialog. Delete asks for confirmation first.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
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
  cannedResponsesKey,
  createCannedResponse,
  deleteCannedResponse,
  errorMessage,
  isPending,
  listCannedResponses,
  updateCannedResponse,
} from "./api";
import type { CannedResponse } from "./types";
import { EmptyState, ErrorState, LoadingRows, PendingState } from "./shared";

/** Must match CONTENT_LIMITS in server/modules/chatbot/content-admin/schemas.ts. */
const TITLE_MAX = 255;
const CONTENT_MAX = 10000;

type Draft = { id: string | null; title: string; content: string };
const EMPTY: Draft = { id: null, title: "", content: "" };

export default function CannedResponsesPage() {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<CannedResponse | null>(null);

  const listQuery = useQuery<CannedResponse[]>({ queryKey: cannedResponsesKey, queryFn: listCannedResponses });

  const refresh = () => queryClient.invalidateQueries({ queryKey: cannedResponsesKey });

  const saveMutation = useMutation({
    mutationFn: (d: Draft) => {
      const body = { title: d.title.trim(), content: d.content.trim() };
      return d.id ? updateCannedResponse(d.id, body) : createCannedResponse(body);
    },
    onSuccess: (_row, d) => {
      toast({ title: d.id ? "Canned response saved" : "Canned response created" });
      setDraft(null);
      setFormError(null);
      refresh();
    },
    onError: (err) => setFormError(errorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCannedResponse(id),
    onSuccess: () => {
      toast({ title: "Canned response deleted" });
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
  const openEdit = (row: CannedResponse) => {
    setFormError(null);
    setDraft({ id: row.id, title: row.title, content: row.content });
  };

  const canSave = !!draft && draft.title.trim().length > 0 && draft.content.trim().length > 0 && !saveMutation.isPending;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Canned responses</h1>
          <p className="text-sm text-muted-foreground">Short replies your team can insert in a chat.</p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
          New response
        </Button>
      </div>

      {isPending(listQuery.error) ? (
        <PendingState title="Canned responses are not connected yet">
          The canned response routes are not mounted on this server. Your replies will show here once they are.
        </PendingState>
      ) : listQuery.error ? (
        <ErrorState message={errorMessage(listQuery.error)} />
      ) : listQuery.isLoading ? (
        <LoadingRows />
      ) : !listQuery.data?.length ? (
        <EmptyState
          title="No canned responses yet"
          action={<Button variant="outline" onClick={openNew}>Create the first one</Button>}
        />
      ) : (
        <ul className="space-y-3">
          {listQuery.data.map((row) => (
            <li key={row.id}>
              <Card>
                <CardContent className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <p className="font-medium">{row.title}</p>
                    <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-muted-foreground">{row.content}</p>
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? "Edit canned response" : "New canned response"}</DialogTitle>
            <DialogDescription>The text is sent as typed, so check spelling and links.</DialogDescription>
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
                <Label htmlFor="canned-title">Title</Label>
                <Input
                  id="canned-title"
                  maxLength={TITLE_MAX}
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="canned-content">Reply text</Label>
                <Textarea
                  id="canned-content"
                  rows={6}
                  maxLength={CONTENT_MAX}
                  value={draft.content}
                  onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                />
              </div>
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
            <AlertDialogTitle>Delete this canned response?</AlertDialogTitle>
            <AlertDialogDescription>
              {toDelete ? `"${toDelete.title}" will be removed for everyone in your company.` : ""}
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
