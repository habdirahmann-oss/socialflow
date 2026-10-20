import Link from "next/link";
import LogoutLink from "./LogoutLink";

const ITEMS = [
  { href: "/", label: "Composer" },
  { href: "/planning", label: "Planning" },
  { href: "/verbindingen", label: "Verbindingen" },
] as const;

/** Hoofdnavigatie: Composer · Planning · Verbindingen · Uitloggen. */
export default function AppNav({ active }: { active: "/" | "/planning" | "/verbindingen" }) {
  return (
    <nav className="flex items-center gap-1.5">
      {ITEMS.map((it) => (
        <Link
          key={it.href}
          href={it.href}
          className={`rounded-full border px-3 py-1 text-xs transition ${
            it.href === active
              ? "border-brand bg-brand/15 text-foreground"
              : "border-border text-muted hover:text-foreground"
          }`}
        >
          {it.label}
        </Link>
      ))}
      <LogoutLink className="ml-1" />
    </nav>
  );
}
