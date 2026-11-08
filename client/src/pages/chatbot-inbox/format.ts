/** Small display helpers for the staff inbox. */

const CHANNEL_LABELS: Record<string, string> = {
  web: "Web chat",
  frame: "Live chat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  messenger: "Messenger",
  instagram: "Instagram",
  voice: "Voice",
};

/** Known channel keys get a name. Any other key is shown as it arrives, so a new channel never breaks the list. */
export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Local date and time for a server ISO string. Falls back to the raw text when it cannot be read. */
export function formatTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
