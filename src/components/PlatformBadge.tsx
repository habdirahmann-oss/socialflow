import { PLATFORM_MAP, type PlatformId } from "@/lib/platforms";

const LABEL: Record<PlatformId, string> = {
  instagram: "IG",
  tiktok: "TT",
  facebook: "f",
  youtube: "YT",
};

/** Klein gekleurd kanaal-icoon (IG / TT / f / YT). */
export default function PlatformBadge({ id }: { id: string }) {
  const p = PLATFORM_MAP[id as PlatformId];
  if (!p) return null;
  return (
    <span
      className="flex h-6 w-6 items-center justify-center rounded-lg text-[10px] font-bold text-white"
      style={{ background: p.gradient }}
      title={p.name}
    >
      {LABEL[id as PlatformId]}
    </span>
  );
}
