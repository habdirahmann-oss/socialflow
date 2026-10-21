import Link from "next/link";
import LogoutLink from "./LogoutLink";

type NavHref = "/" | "/planning" | "/verbindingen";

const ITEMS: { href: NavHref; label: string; icon: React.ReactNode }[] = [
  {
    href: "/",
    label: "Nieuwe post",
    icon: (
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    ),
  },
  {
    href: "/planning",
    label: "Planning",
    icon: (
      <>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M3.5 10h17M8 3v4M16 3v4" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/verbindingen",
    label: "Kanalen",
    icon: (
      <>
        <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" strokeLinecap="round" />
        <path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" strokeLinecap="round" />
      </>
    ),
  },
];

function NavIcon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/**
 * App-indeling: vaste zijbalk links (desktop) of een balk bovenaan (mobiel),
 * met een rustige paginakop en de inhoud op een lichtgrijze achtergrond.
 */
export default function AppShell({
  active,
  title,
  subtitle,
  actions,
  children,
  wide,
}: {
  active: NavHref;
  title: string;
  subtitle?: React.ReactNode;
  /** Rechts in de paginakop (bv. accountkeuze). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Brede inhoud (opstelscherm); anders smaller en gecentreerd. */
  wide?: boolean;
}) {
  return (
    <div className="flex min-h-screen bg-background">
      {/* Zijbalk (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface px-3 py-5 md:flex">
        <Link href="/" className="mb-7 flex items-center gap-2.5 px-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" className="h-8 w-8 rounded-lg" />
          <span className="text-[15px] font-semibold tracking-tight">SocialFlow</span>
        </Link>
        <nav className="flex flex-col gap-0.5">
          {ITEMS.map((it) => {
            const on = it.href === active;
            return (
              <Link
                key={it.href}
                href={it.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${
                  on
                    ? "bg-brand/10 font-semibold text-brand"
                    : "text-muted hover:bg-surface-2 hover:text-foreground"
                }`}
              >
                <NavIcon>{it.icon}</NavIcon>
                {it.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto px-3">
          <LogoutLink />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col md:pl-60">
        {/* Balk bovenaan (mobiel) */}
        <header className="sticky top-0 z-40 flex items-center justify-between gap-3 border-b border-border bg-surface px-4 py-2.5 md:hidden">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" className="h-7 w-7 rounded-lg" />
            <span className="text-sm font-semibold">SocialFlow</span>
          </Link>
          <nav className="flex items-center gap-1">
            {ITEMS.map((it) => (
              <Link
                key={it.href}
                href={it.href}
                aria-label={it.label}
                className={`rounded-lg p-2 ${
                  it.href === active ? "bg-brand/10 text-brand" : "text-muted"
                }`}
              >
                <NavIcon>{it.icon}</NavIcon>
              </Link>
            ))}
          </nav>
        </header>

        <main className={`mx-auto w-full px-4 pb-24 pt-6 md:px-8 md:pt-8 ${wide ? "max-w-7xl" : "max-w-5xl"}`}>
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
