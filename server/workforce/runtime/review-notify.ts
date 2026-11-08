/**
 * Notify humans about a review item. A suggest-tier item always lands in the review inbox, and is then
 * sent to each channel id configured in the company's settings. A failing channel never stops the
 * others and never throws; the caller gets back the list of channels that failed.
 *
 * The inbox is the source of truth, so an error from `inbox.add` is not caught here.
 */
import type { ReviewItem } from './review-inbox.ts';

export interface ReviewNotifyInbox {
  add(item: ReviewItem): void | Promise<void>;
}

export interface ReviewNotifyChannels {
  /** Channel ids from the company's settings. Duplicates are sent once. */
  ids: readonly string[];
  /** Sends the item to one channel. May throw or reject; that counts as a failed channel. */
  send(channelId: string, item: ReviewItem): void | Promise<void>;
}

export interface ReviewNotifyDeps {
  inbox: ReviewNotifyInbox;
  channels: ReviewNotifyChannels;
}

export interface ReviewNotifyResult {
  /** Channel ids that accepted the item, in configured order. */
  sent: string[];
  /** Channel ids whose send threw or rejected, in configured order. */
  failed: string[];
}

export async function notifyReview(deps: ReviewNotifyDeps, item: ReviewItem): Promise<ReviewNotifyResult> {
  await deps.inbox.add(item);

  const sent: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const channelId of deps.channels.ids ?? []) {
    if (seen.has(channelId)) continue;
    seen.add(channelId);
    try {
      await deps.channels.send(channelId, item);
      sent.push(channelId);
    } catch {
      failed.push(channelId);
    }
  }

  return { sent, failed };
}
