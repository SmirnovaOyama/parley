import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Icon, type IconName } from "../icons/Icon.tsx";
import { Wordmark } from "../icons/Brand.tsx";
import { groupChats } from "../lib/groups.ts";
import { useSession } from "../lib/session.tsx";
import { t } from "../lib/i18n.ts";
import { isUnderChat } from "../lib/slide.ts";
import { Marked, searchWords, useChatSearch } from "./ChatSearch.tsx";
import { BusyMark, Spinner } from "./Feedback.tsx";
import { SearchLine } from "./LineField.tsx";

/** Signed-in frame: Sidebar from 768px, the floating BottomNav below it. */
export function AppShell() {
  const { user, loading } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="boot">
        <Spinner />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  // Inside a conversation the composer owns the bottom of the screen, so the tab bar steps aside.
  // A chat's settings page lays out as an ordinary page, but it belongs to the chat (it has its own
  // back link), so the tab bar stays away there too.
  const underChat = isUnderChat(location.pathname);
  const inChat = underChat && !location.pathname.endsWith("/settings");

  return (
    <div className="app">
      <Sidebar />
      <main className={`app-main${inChat ? " is-chat" : ""}${underChat ? " no-tab-bar" : ""}`}>
        <Outlet />
      </main>
      {!underChat && <BottomNav />}
    </div>
  );
}

function Sidebar() {
  const { user, conversations } = useSession();
  const { pathname, search } = useLocation();
  // Searching swaps the list of chats for what's found; the search stays while chats are opened.
  const [query, setQuery] = useState("");
  const results = useChatSearch(query);
  const words = searchWords(query);
  const isOpen = (id: string) => (pathname === `/chat/${id}` || pathname.startsWith(`/chat/${id}/`) ? "page" : undefined);

  return (
    <nav className="oy-sidebar app-sidebar" aria-label={t("Main")}>
      <p className="wordmark">
        <Wordmark />
      </p>
      <div className="items">
        <NavItem to="/chat" icon="compose" label={t("New chat")} current={pathname === "/chat" && !search} accent />
        <NavItem to="/compare" icon="compare" label={t("Compare models")} current={pathname.startsWith("/compare")} />
        <NavItem to="/tasks" icon="clock" label={t("Scheduled tasks")} current={pathname.startsWith("/tasks")} />
        <NavItem to="/cowork" icon="briefcase" label={t("Cowork")} current={pathname.startsWith("/cowork")} />
        <NavItem to="/projects" icon="folder" label={t("Projects")} current={pathname.startsWith("/projects")} />
        <NavItem to="/knowledge" icon="book" label={t("Knowledge")} current={pathname.startsWith("/knowledge")} />
      </div>
      {conversations.length > 0 && <SearchLine id="sidebar-search" label={t("Search chats")} value={query} onChange={setQuery} className="sidebar-search" />}

      <ChatList>
        {query.trim() ? (
          results && (
            <section className="sidebar-group sidebar-results" aria-label={t("Search results")}>
              {results.length === 0 ? (
                <p className="sidebar-empty">{t("No chats match")}</p>
              ) : (
                results.map((r) => (
                  <Link key={r.id} to={`/chat/${r.id}`} className="oy-nav-item sidebar-chat sidebar-hit" aria-current={isOpen(r.id)} title={r.title}>
                    <span className="truncate">
                      <Marked text={r.title} words={words} />
                    </span>
                    {r.snippet && (
                      <span className="sidebar-hit-snippet truncate">
                        <Marked text={r.snippet} words={words} />
                      </span>
                    )}
                  </Link>
                ))
              )}
            </section>
          )
        ) : conversations.length === 0 ? (
          <>
            <p className="oy-overline sidebar-heading">{t("Chats")}</p>
            <p className="sidebar-empty">{t("Your chats show up here")}</p>
          </>
        ) : (
          groupChats(conversations).map((g) => (
            <section key={g.label} className="sidebar-group" aria-label={g.label}>
              <p className="oy-overline sidebar-heading">{g.label}</p>
              {g.chats.map((c) => (
                <Link key={c.id} to={`/chat/${c.id}`} className="oy-nav-item sidebar-chat" aria-current={isOpen(c.id)} title={c.title}>
                  <span className="truncate">{c.title}</span>
                  {c.generating && <BusyMark />}
                </Link>
              ))}
            </section>
          ))
        )}
      </ChatList>

      <div className="items sidebar-footer">
        {user?.role === "admin" && (
          <NavItem to="/admin" icon="gear" label={t("Admin")} current={pathname.startsWith("/admin")} />
        )}
        <NavItem to="/settings" icon="sliders" label={t("Settings")} current={pathname === "/settings"} />
      </div>
    </nav>
  );
}

/**
 * The scrolling list of chats. Its edges fade out where there's more to scroll to, so a long list
 * reads as one you can scroll (overlay scrollbars stay hidden until you do).
 */
function ChatList({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ above: false, below: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((e) => (e.above === above && e.below === below ? e : { above, below }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const grow = new MutationObserver(measure);
    grow.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
      grow.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      className="items sidebar-chats"
      data-more-above={edges.above || undefined}
      data-more-below={edges.below || undefined}
    >
      {children}
    </div>
  );
}

type NavItemProps = { to: string; icon: IconName; label: string; current: boolean; accent?: boolean };

function NavItem({ to, icon, label, current, accent }: NavItemProps) {
  return (
    <Link
      to={to}
      className={`oy-nav-item${accent ? " is-accent" : ""}`}
      aria-current={current ? "page" : undefined}
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </Link>
  );
}

function BottomNav() {
  const { user } = useSession();
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const items: { to: string; icon: IconName; label: string; current: boolean }[] = [
    { to: "/chats", icon: "chats", label: t("Chats"), current: pathname === "/chats" || pathname.startsWith("/projects") || pathname.startsWith("/knowledge") || pathname.startsWith("/compare") || pathname.startsWith("/tasks") || pathname.startsWith("/cowork") },
    ...(user?.role === "admin"
      ? [{ to: "/admin", icon: "gear" as const, label: t("Admin"), current: pathname.startsWith("/admin") }]
      : []),
    { to: "/settings", icon: "sliders", label: t("Settings"), current: pathname === "/settings" },
  ];

  // One pill slides to the current tab; on pages no tab owns (a chat's settings) it fades out.
  const at = items.findIndex((item) => item.current);

  return (
    <div className="app-bottom-nav">
      <nav className="oy-bottom-nav" aria-label={t("Main")}>
        <div className="row" style={{ "--at": Math.max(at, 0) } as CSSProperties}>
          <span className="nav-indicator" data-on={at >= 0 || undefined} aria-hidden="true" />
          {items.map((item) => (
            <button
              key={item.to}
              type="button"
              aria-current={item.current ? "page" : undefined}
              onClick={() => navigate(item.to)}
            >
              <span className="pill">
                <Icon name={item.icon} size={22} />
              </span>
              <span className="label">{item.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}

/** Admin-only routes. */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  if (user?.role !== "admin") return <Navigate to="/chat" replace />;
  return children;
}
