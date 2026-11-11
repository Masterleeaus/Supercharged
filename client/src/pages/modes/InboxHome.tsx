import { Link } from "wouter";
import { Inbox, MessageSquare } from "lucide-react";

export default function InboxHome() {
  return <main className="space-y-5" data-testid="inbox-mode">
    <header><h1 className="text-2xl font-semibold" data-testid="mode-inbox-title">Omnichannel Inbox</h1><p className="text-muted-foreground">Customer conversations, assignments and human handover.</p></header>
    <Link href="/app/chatbot-inbox" className="flex max-w-md items-center gap-3 rounded-lg border p-4 hover:bg-accent">
      <Inbox className="h-5 w-5" /><span><strong>Open staff inbox</strong><span className="block text-sm text-muted-foreground">View and respond to connected conversations</span></span><MessageSquare className="ml-auto h-4 w-4" />
    </Link>
  </main>;
}
