/**
 * Centre column: the message thread, the staff composer and the handoff actions.
 * Internal notes are shown to staff only and are sent with isInternalNote set, so the server never delivers them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Bot, Lock, UserRound } from "lucide-react";
import {
  closeTicket,
  getThread,
  handBack,
  INBOX_QUERY_KEY,
  isInboxPending,
  postStaffReply,
  takeOver,
  threadQueryKey,
} from "./api";
import { channelLabel, formatTime } from "./format";
import { MAX_REPLY_LENGTH, type InboxConversation, type InboxMessage } from "./types";

interface ConversationThreadProps {
  conversationId: string;
  canWrite: boolean;
}

const POLL_MS = 10_000;

export function ConversationThread({ conversationId, canWrite }: ConversationThreadProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState("");
  const [asNote, setAsNote] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const thread = useQuery({
    queryKey: threadQueryKey(conversationId),
    queryFn: () => getThread(conversationId),
    refetchInterval: POLL_MS, // polling until the realtime transport is chosen (see DECISIONS.md)
  });

  // A different conversation starts with an empty composer and no pending close.
  useEffect(() => {
    setDraft("");
    setAsNote(false);
    setConfirmClose(false);
  }, [conversationId]);

  const messages = useMemo<InboxMessage[]>(
    () => [...(thread.data?.messages ?? [])].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    [thread.data],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length]);

  const conversation = thread.data?.conversation;

  /** Replace the thread and list rows with the server's answer, without waiting for the next poll. */
  const applyConversation = (next: InboxConversation) => {
    queryClient.setQueryData(threadQueryKey(conversationId), (old: typeof thread.data) =>
      old ? { ...old, conversation: next } : old,
    );
    queryClient.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
  };

  const reply = useMutation({
    mutationFn: () => postStaffReply(conversationId, { message: draft.trim(), isInternalNote: asNote }),
    onSuccess: (result) => {
      setDraft("");
      queryClient.invalidateQueries({ queryKey: threadQueryKey(conversationId) });
      // Notes are never delivered, so deliveryFailed can only be true for a customer reply.
      if (result.deliveryFailed) {
        toast({
          title: "Saved, not delivered",
          description: "The reply is saved, but the customer channel did not accept it.",
          variant: "destructive",
        });
      }
    },
    onError: (err) => toast({ title: "Reply not sent", description: errorText(err), variant: "destructive" }),
  });

  const takeover = useMutation({
    mutationFn: () => takeOver(conversationId),
    onSuccess: (r) => {
      applyConversation(r.conversation);
      toast({ title: "You have taken over this chat" });
    },
    onError: (err) => toast({ title: "Take over failed", description: errorText(err), variant: "destructive" }),
  });

  const handback = useMutation({
    mutationFn: () => handBack(conversationId),
    onSuccess: (r) => {
      applyConversation(r.conversation);
      toast({ title: "Chat handed back to the AI agent" });
    },
    onError: (err) => toast({ title: "Hand back failed", description: errorText(err), variant: "destructive" }),
  });

  const close = useMutation({
    mutationFn: () => closeTicket(conversationId),
    onSuccess: (r) => {
      setConfirmClose(false);
      applyConversation(r.conversation);
      toast({ title: "Ticket closed" });
    },
    onError: (err) => toast({ title: "Close failed", description: errorText(err), variant: "destructive" }),
  });

  const busy = reply.isPending || takeover.isPending || handback.isPending || close.isPending;
  const trimmedLength = draft.trim().length;
  const tooLong = draft.length > MAX_REPLY_LENGTH;

  if (thread.isLoading) {
    return (
      <div className="space-y-3 p-6">
        <Skeleton className="h-10 w-1/2" />
        <Skeleton className="h-10 w-2/3 ml-auto" />
        <Skeleton className="h-10 w-1/2" />
      </div>
    );
  }

  if (thread.isError) {
    if (isInboxPending(thread.error)) return <PendingNotice />;
    const notFound = thread.error instanceof ApiError && thread.error.status === 404;
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>{notFound ? "Conversation not found" : "Could not load this conversation"}</AlertTitle>
          <AlertDescription>{errorText(thread.error)}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!conversation) return null;

  const closed = conversation.ticketStatus === "closed";
  const aiHandling = conversation.handler === "ai";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b p-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">Conversation {conversation.id.slice(0, 8)}</h2>
          <p className="text-xs text-muted-foreground">
            {channelLabel(conversation.channel)} · updated {formatTime(conversation.updatedAt)}
          </p>
        </div>
        <Badge variant={aiHandling ? "secondary" : "default"} className="gap-1">
          {aiHandling ? <Bot className="size-3" /> : <UserRound className="size-3" />}
          {aiHandling ? "AI agent" : "Human agent"}
        </Badge>
        {closed && <Badge variant="outline">Closed</Badge>}
      </header>

      {canWrite && (
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          {aiHandling ? (
            <Button size="sm" onClick={() => takeover.mutate()} disabled={busy || closed}>
              Take over
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => handback.mutate()} disabled={busy || closed}>
              Hand back to AI
            </Button>
          )}
          {!closed &&
            (confirmClose ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => close.mutate()} disabled={busy}>
                  Confirm close
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmClose(false)} disabled={busy}>
                  Keep open
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setConfirmClose(true)} disabled={busy}>
                Close ticket
              </Button>
            ))}
        </div>
      )}

      <ol className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-label="Messages">
        {thread.isFetching && messages.length === 0 && <li className="text-sm text-muted-foreground">Loading</li>}
        {!thread.isFetching && messages.length === 0 && (
          <li className="text-sm text-muted-foreground">No messages yet.</li>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        <div ref={endRef} />
      </ol>

      {canWrite ? (
        <div className="space-y-2 border-t p-3">
          {!closed && aiHandling && !asNote && (
            <p className="text-xs text-muted-foreground">
              The AI agent is still handling this chat. Take over first so the customer does not get two replies.
            </p>
          )}
          {closed && <p className="text-xs text-muted-foreground">This ticket is closed.</p>}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Switch id="inbox-internal-note" checked={asNote} onCheckedChange={setAsNote} disabled={busy} />
              <Label htmlFor="inbox-internal-note" className="text-sm">
                Internal note (staff only)
              </Label>
            </div>
            <span className={`text-xs ${tooLong ? "text-destructive" : "text-muted-foreground"}`}>
              {draft.length} / {MAX_REPLY_LENGTH}
            </span>
          </div>
          <Textarea
            aria-label={asNote ? "Internal note" : "Reply to customer"}
            placeholder={asNote ? "Write a note only staff can see" : "Write a reply to the customer"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            disabled={busy}
          />
          <div className="flex justify-end">
            <Button
              onClick={() => reply.mutate()}
              disabled={busy || trimmedLength === 0 || tooLong}
              variant={asNote ? "secondary" : "default"}
            >
              {asNote ? (
                <>
                  <Lock />
                  Save note
                </>
              ) : (
                "Send reply"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <p className="border-t p-3 text-xs text-muted-foreground">
          Your role can read conversations but not reply or change them.
        </p>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: InboxMessage }) {
  if (message.isInternalNote) {
    return (
      <li className="ms-auto max-w-[85%] rounded-xl border border-dashed border-amber-500/60 bg-amber-500/10 p-3">
        <p className="mb-1 flex items-center gap-1 text-xs font-medium">
          <Lock className="size-3" /> Internal note, staff only
        </p>
        <p className="whitespace-pre-wrap text-sm">{message.message}</p>
        <time className="mt-1 block text-xs text-muted-foreground" dateTime={message.createdAt}>
          {formatTime(message.createdAt)}
        </time>
      </li>
    );
  }

  const fromCustomer = message.role === "user";
  const who = fromCustomer ? "Customer" : message.staffId ? "Staff" : "AI agent";
  return (
    <li className={`max-w-[85%] rounded-xl p-3 ${fromCustomer ? "bg-muted" : "ms-auto bg-secondary"}`}>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{who}</p>
      <p className="whitespace-pre-wrap text-sm">{message.message}</p>
      <time className="mt-1 block text-xs text-muted-foreground" dateTime={message.createdAt}>
        {formatTime(message.createdAt)}
      </time>
    </li>
  );
}

function PendingNotice() {
  return (
    <div className="p-6">
      <Alert>
        <AlertTitle>Staff inbox is not switched on yet</AlertTitle>
        <AlertDescription>
          The staff inbox routes are not mounted or not enabled for this environment. Nothing has been sent or changed.
        </AlertDescription>
      </Alert>
    </div>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Your role does not allow this action.";
    if (err.status === 404) return "This conversation is no longer available.";
    if (err.status === 400) return err.message || "The request was not valid.";
    return err.message || "Something went wrong. Please try again.";
  }
  return "Something went wrong. Please try again.";
}
