import { kvGet, kvUpdate } from "./store";
import type { MediaKind, PlatformCaption } from "./types";
import type { PlatformId } from "./platforms";

/** Bewaarde, nog niet geplaatste post (concept). Media staat al online (Blob). */
export interface Draft {
  id: string;
  accountId: string;
  subject: string;
  tone?: string;
  /** Slide 1 (of de video) + eventuele extra carrousel-foto's. */
  media: { url: string; type: MediaKind; name?: string }[];
  captions: Partial<Record<PlatformId, PlatformCaption>>;
  /** Gekozen kanalen. */
  channels: PlatformId[];
  createdAt: number;
  updatedAt: number;
}

const KEY = "drafts";
/** Ruim genoeg; oudste concepten vallen eraf. */
const MAX_DRAFTS = 200;

export async function listDrafts(accountId?: string | null): Promise<Draft[]> {
  const all = (await kvGet<Draft[]>(KEY)) ?? [];
  return all
    .filter((d) => !accountId || d.accountId === accountId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getDraft(id: string): Promise<Draft | null> {
  return ((await kvGet<Draft[]>(KEY)) ?? []).find((d) => d.id === id) ?? null;
}

/** Nieuw of bijwerken (zelfde id). */
export async function saveDraft(d: Draft): Promise<Draft> {
  let saved = d;
  await kvUpdate<Draft[]>(KEY, (cur) => {
    const list = cur ?? [];
    const i = list.findIndex((x) => x.id === d.id);
    if (i >= 0) {
      saved = { ...d, createdAt: list[i].createdAt };
      list[i] = saved;
    } else {
      list.push(d);
    }
    return list.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_DRAFTS);
  });
  return saved;
}

export async function deleteDraft(id: string): Promise<void> {
  await kvUpdate<Draft[]>(KEY, (cur) => (cur ?? []).filter((d) => d.id !== id));
}
