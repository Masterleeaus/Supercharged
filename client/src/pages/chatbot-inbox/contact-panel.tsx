/**
 * Right column: details of the open conversation. Shows only fields the server sends.
 * Customer tags, name, IP address and country are not in the mounted response, so they show a pending note.
 */
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import type { InboxConversation } from "./types";
import { channelLabel, formatTime } from "./format";

interface ContactPanelProps {
  conversation: InboxConversation | undefined;
}

export function ContactPanel({ conversation }: ContactPanelProps) {
  if (!conversation) {
    return <p className="p-4 text-sm text-muted-foreground">Select a conversation to see its details.</p>;
  }

  return (
    <div className="space-y-4 p-4 text-sm">
      <section className="space-y-2" aria-labelledby="contact-details-title">
        <h3 id="contact-details-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Details
        </h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
          <dt className="text-muted-foreground">ID</dt>
          <dd className="break-all font-mono text-xs">{conversation.id}</dd>
          <dt className="text-muted-foreground">Channel</dt>
          <dd>{channelLabel(conversation.channel)}</dd>
          <dt className="text-muted-foreground">Ticket</dt>
          <dd>{conversation.ticketStatus === "closed" ? "Closed" : "New"}</dd>
          <dt className="text-muted-foreground">Handled by</dt>
          <dd>{conversation.handler === "human" ? "Human agent" : "AI agent"}</dd>
          <dt className="text-muted-foreground">Staff member</dt>
          <dd>{conversation.handlerStaffId ? <span className="font-mono text-xs">{conversation.handlerStaffId}</span> : "None"}</dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd>{formatTime(conversation.updatedAt)}</dd>
        </dl>
      </section>

      <Separator />

      <section className="space-y-2" aria-labelledby="contact-tags-title">
        <h3 id="contact-tags-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tags
        </h3>
        <Badge variant="outline">Pending backend</Badge>
        <p className="text-xs text-muted-foreground">
          Customer tags need the customer-tag routes. They are not in Desk yet, so none are shown.
        </p>
      </section>

      <Separator />

      <section className="space-y-2" aria-labelledby="contact-person-title">
        <h3 id="contact-person-title" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Customer
        </h3>
        <p className="text-xs text-muted-foreground">
          Name, IP address and country are not sent by the server yet. Nothing is shown in their place.
        </p>
      </section>
    </div>
  );
}
