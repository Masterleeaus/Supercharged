/**
 * Contacts (chatbot customers): read-only list and detail. Detail opens in a side panel on the same page, so the
 * owner does not need a new route to wire it. Shows a pending state when the backend answers 501.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { contactsKey, errorMessage, isPending, listContacts } from "./api";
import type { Contact } from "./types";
import { EmptyState, ErrorState, LoadingRows, PendingState } from "./shared";

/** Name for display: the stored name, else the email, else the phone, else a placeholder. */
export function contactLabel(c: Pick<Contact, "name" | "email" | "phone">): string {
  return c.name?.trim() || c.email || c.phone || "Unnamed contact";
}

/** Case-insensitive match on name, email, phone or channel. */
export function matchesContact(c: Contact, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [c.name, c.email, c.phone, c.chatbotChannel].some((v) => (v ?? "").toLowerCase().includes(q));
}

export default function ContactsPage() {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const listQuery = useQuery<Contact[]>({ queryKey: contactsKey, queryFn: listContacts, retry: false });
  const rows = (listQuery.data ?? []).filter((c) => matchesContact(c, query));
  const selected = listQuery.data?.find((c) => c.id === selectedId) ?? null;

  if (isPending(listQuery.error)) {
    return (
      <div className="p-4 md:p-6">
        <h1 className="mb-4 text-2xl font-semibold">Contacts</h1>
        <PendingState title="Contacts are not connected yet">
          The contact reader is not mounted on this server. The list will show here once it is.
        </PendingState>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-sm text-muted-foreground">People who have chatted with your bots.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          <Input
            aria-label="Search contacts"
            placeholder="Search by name, email, phone or channel"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {listQuery.error ? (
            <ErrorState message={errorMessage(listQuery.error)} />
          ) : listQuery.isLoading ? (
            <LoadingRows />
          ) : rows.length === 0 ? (
            <EmptyState title={query ? "No contacts match this search" : "No contacts yet"} />
          ) : (
            <ul className="divide-y rounded-md border">
              {rows.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className={`flex w-full items-center justify-between gap-4 p-3 text-left hover:bg-muted ${
                      c.id === selectedId ? "bg-muted" : ""
                    }`}
                    aria-pressed={c.id === selectedId}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{contactLabel(c)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{c.email ?? c.phone ?? "No email or phone"}</span>
                    </span>
                    <span className="shrink-0 text-xs capitalize text-muted-foreground">{c.chatbotChannel ?? "web"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <aside aria-label="Contact details">
          {selected ? (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">{contactLabel(selected)}</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setSelectedId(null)}>
                  Close
                </Button>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Email</dt>
                  <dd className="break-all">{selected.email ?? "Not given"}</dd>
                  <dt className="text-muted-foreground">Phone</dt>
                  <dd>{selected.phone ?? "Not given"}</dd>
                  <dt className="text-muted-foreground">Channel</dt>
                  <dd className="capitalize">{selected.chatbotChannel ?? "web"}</dd>
                  <dt className="text-muted-foreground">Language</dt>
                  <dd>{selected.preferredLanguage ?? "Not set"}</dd>
                  <dt className="text-muted-foreground">First seen</dt>
                  <dd>{new Date(selected.createdAt).toLocaleDateString()}</dd>
                </dl>
              </CardContent>
            </Card>
          ) : (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              Select a contact to see details.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
