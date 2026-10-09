import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { Icon, type IconName } from "../icons/Icon.tsx";
import { APP_NAME } from "../lib/brand.ts";
import { useSession } from "../lib/session.tsx";
import { BusyMark, Spinner } from "./Feedback.tsx";

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
  const underChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
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
  const { pathname } = useLocation();

  return (
    <nav className="oy-sidebar app-sidebar" aria-label="Main">
      <p className="wordmark">{APP_NAME}</p>
      <div className="items">
        <NavItem to="/chat" icon="compose" label="New chat" current={pathname === "/chat"} accent />
      </div>

      <p className="oy-overline sidebar-heading">Chats</p>
      <ChatList>
        {conversations.length === 0 ? (
          <p className="sidebar-empty">Your chats show up here</p>
        ) : (
          conversations.map((c) => (
            <Link
              key={c.id}
              to={`/chat/${c.id}`}
              className="oy-nav-item sidebar-chat"
              aria-current={pathname === `/chat/${c.id}` || pathname.startsWith(`/chat/${c.id}/`) ? "page" : undefined}
              title={c.title}
            >
              <span className="truncate">{c.title}</span>
              {c.generating && <BusyMark />}
            </Link>
          ))
        )}
      </ChatList>

      <div className="items sidebar-footer">
        {user?.role === "admin" && (
          <NavItem to="/admin" icon="gear" label="Admin" current={pathname.startsWith("/admin")} />
        )}
        <NavItem to="/account" icon="user" label="Account" current={pathname === "/account"} />
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
    { to: "/chats", icon: "chats", label: "Chats", current: pathname === "/chats" },
    ...(user?.role === "admin"
      ? [{ to: "/admin", icon: "gear" as const, label: "Admin", current: pathname.startsWith("/admin") }]
      : []),
    { to: "/account", icon: "user", label: "Account", current: pathname === "/account" },
  ];

  // One pill slides to the current tab; on pages no tab owns (a chat's settings) it fades out.
  const at = items.findIndex((item) => item.current);

  return (
    <div className="app-bottom-nav">
      <nav className="oy-bottom-nav" aria-label="Main">
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
