import { kvGet, kvSet } from "./store";
import type {
  PublishTargets,
  PublishCaptions,
  PublishResult,
} from "./publish";

export interface ScheduledPost {
  id: string;
  accountId: string;
  accountName: string;
  scheduledFor: number; // epoch ms
  mediaUrl?: string; // al publiek (Blob)
  mediaType?: "image" | "video";
  thumb?: string; // kleine preview-url
  subject: string;
  targets: PublishTargets;
  captions: PublishCaptions;
  status: "pending" | "posted" | "failed";
  results?: PublishResult[];
  createdAt: number;
}

const KEY = "scheduled-posts";

export async function listScheduled(): Promise<ScheduledPost[]> {
  return (await kvGet<ScheduledPost[]>(KEY)) ?? [];
}

export async function addScheduled(post: ScheduledPost): Promise<void> {
  const all = await listScheduled();
  all.push(post);
  await kvSet(KEY, all);
}

export async function updateScheduled(
  id: string,
  patch: Partial<ScheduledPost>,
): Promise<void> {
  const all = await listScheduled();
  const idx = all.findIndex((p) => p.id === id);
  if (idx >= 0) {
    all[idx] = { ...all[idx], ...patch };
    await kvSet(KEY, all);
  }
}

export async function removeScheduled(id: string): Promise<void> {
  const all = await listScheduled();
  await kvSet(
    KEY,
    all.filter((p) => p.id !== id),
  );
}

/** Posts die klaarstaan om verstuurd te worden (verleden + pending). */
export async function duePosts(now: number): Promise<ScheduledPost[]> {
  const all = await listScheduled();
  return all.filter((p) => p.status === "pending" && p.scheduledFor <= now);
}
