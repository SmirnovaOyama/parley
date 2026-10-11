import { useState, type ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { Tabs } from "../../components/Controls.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { t } from "../../lib/i18n.ts";

const TABS = [
  { id: "overview", label: t("Overview") },
  { id: "keys", label: t("API keys") },
  { id: "people", label: t("People") },
  { id: "groups", label: t("Groups") },
  { id: "chats", label: t("Chats") },
  { id: "usage", label: t("Usage") },
  { id: "tools", label: t("Tools") },
  { id: "settings", label: t("Settings") },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function AdminLayout() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = (pathname.split("/")[2] ?? "overview") as TabId;
  const overview = current === "overview";

  // The overview greets you; the other tabs are "Admin". The whole admin area runs wider than the
  // reading column, so dashboards and tables have room and switching tabs never moves the header.
  return (
    <div className="admin-page">
      <PageHeader title={overview ? greeting() : t("Admin")} />
      <div className="oy-page-column page-body">
        <div className="admin-tabs">
          <Tabs tabs={TABS} value={current} onChange={(tab) => navigate(`/admin/${tab}`)} />
        </div>
        <TabView key={current}>
          <Outlet />
        </TabView>
      </div>
    </div>
  );
}

/** A tab's content eases in, unless the whole page is sliding in already (back from a key or a person). */
function TabView({ children }: { children: ReactNode }) {
  const [ease] = useState(() => !document.documentElement.dataset.slide);
  return <div className={ease ? "view-enter-forward" : undefined}>{children}</div>;
}

function greeting(): string {
  const hour = new Date().getHours();
  return hour >= 5 && hour < 12 ? t("Good morning") : hour >= 12 && hour < 18 ? t("Good afternoon") : t("Good evening");
}
