import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AppShell, RequireAdmin } from "./components/AppShell.tsx";
import { SessionProvider } from "./lib/session.tsx";
import { AccountPage } from "./pages/AccountPage.tsx";
import { AuthPage, ForgotPasswordPage, ResetPasswordPage } from "./pages/AuthPage.tsx";
import { BonusPage } from "./pages/BonusPage.tsx";
import { ChatPage } from "./pages/ChatPage.tsx";
import { ComparePage } from "./pages/ComparePage.tsx";
import { ChatSettingsPage } from "./pages/ChatSettingsPage.tsx";
import { ChatsPage } from "./pages/ChatsPage.tsx";
import { TaskFormPage, TasksPage } from "./pages/TasksPage.tsx";
import { CoworkJobPage, CoworkPage } from "./pages/CoworkPage.tsx";
import { ConnectionsPage, ConnectionTokenPage } from "./pages/ConnectionsPage.tsx";
import { DevicesPage } from "./pages/DevicesPage.tsx";
import { TwoStepPage } from "./pages/TwoStepPage.tsx";
import { SharePage } from "./pages/SharePage.tsx";
import { AdminLayout } from "./pages/admin/AdminLayout.tsx";
import { ChatsAdminPage } from "./pages/admin/ChatsAdminPage.tsx";
import { ChatViewPage } from "./pages/admin/ChatViewPage.tsx";
import { KeyFormPage } from "./pages/admin/KeyFormPage.tsx";
import { KeysPage } from "./pages/admin/KeysPage.tsx";
import { OverviewPage } from "./pages/admin/OverviewPage.tsx";
import { PeoplePage } from "./pages/admin/PeoplePage.tsx";
import { PersonFormPage } from "./pages/admin/PersonFormPage.tsx";
import { SettingsPage } from "./pages/admin/SettingsPage.tsx";
import { UsagePage } from "./pages/admin/UsagePage.tsx";
import { GroupFormPage, GroupsPage } from "./pages/admin/GroupsPage.tsx";
import { McpFormPage, ToolsPage } from "./pages/admin/ToolsPage.tsx";
import { KnowledgeBasePage, KnowledgeFormPage, KnowledgePage } from "./pages/KnowledgePage.tsx";
import { MemoryPage } from "./pages/MemoryPage.tsx";
import { PasswordPage } from "./pages/PasswordPage.tsx";
import { PersonaFormPage, PersonasPage } from "./pages/PersonasPage.tsx";
import { ProjectPage, ProjectSettingsPage, ProjectsPage } from "./pages/ProjectsPage.tsx";

export function App() {
  // Route changes render straight away (no React transition), so a page slide can show the new page.
  return (
    <BrowserRouter useTransitions={false}>
      <SessionProvider>
        <Routes>
          <Route path="/login" element={<AuthPage mode="login" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          {/* Shared chats open on their own page, outside the app, for people without an account too. */}
          <Route path="/share/:token" element={<SharePage />} />
          <Route element={<AppShell />}>
            <Route index element={<Navigate to="/chat" replace />} />
            {/* One route for a new chat and an open one, so the page survives the first reply's redirect. */}
            <Route path="chat/:id?" element={<ChatPage />} />
            <Route path="compare/:id?" element={<ComparePage />} />
            {/* A chat's own settings; "new" is the chat about to start. */}
            <Route path="chat/:id/settings" element={<ChatSettingsPage />} />
            <Route path="chats" element={<ChatsPage />} />
            <Route path="tasks" element={<TasksPage />} />
            <Route path="tasks/new" element={<TaskFormPage />} />
            <Route path="tasks/:id" element={<TaskFormPage />} />
            <Route path="cowork" element={<CoworkPage />} />
            <Route path="cowork/:id" element={<CoworkJobPage />} />
            <Route path="settings" element={<AccountPage />} />
            <Route path="settings/bonus" element={<BonusPage />} />
            <Route path="settings/connections" element={<ConnectionsPage />} />
            <Route path="settings/connections/:id" element={<ConnectionTokenPage />} />
            <Route path="settings/devices" element={<DevicesPage />} />
            <Route path="settings/memory" element={<MemoryPage />} />
            <Route path="settings/personas" element={<PersonasPage />} />
            <Route path="settings/personas/:id" element={<PersonaFormPage />} />
            <Route path="settings/password" element={<PasswordPage />} />
            <Route path="settings/two-step" element={<TwoStepPage />} />
            {/* What was Account is now Settings: old links and bookmarks still arrive. */}
            <Route path="account/*" element={<FromAccount />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/new" element={<ProjectSettingsPage />} />
            <Route path="projects/:id" element={<ProjectPage />} />
            <Route path="projects/:id/settings" element={<ProjectSettingsPage />} />
            <Route path="knowledge" element={<KnowledgePage />} />
            <Route path="knowledge/new" element={<KnowledgeFormPage />} />
            <Route path="knowledge/:id" element={<KnowledgeBasePage />} />
            <Route path="knowledge/:id/settings" element={<KnowledgeFormPage />} />
            <Route
              path="admin"
              element={
                <RequireAdmin>
                  <AdminLayout />
                </RequireAdmin>
              }
            >
              <Route index element={<Navigate to="overview" replace />} />
              <Route path="overview" element={<OverviewPage />} />
              <Route path="keys" element={<KeysPage />} />
              <Route path="people" element={<PeoplePage />} />
              <Route path="groups" element={<GroupsPage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="chats" element={<ChatsAdminPage />} />
              <Route path="usage" element={<UsagePage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
            <Route
              path="admin/chats/:id"
              element={
                <RequireAdmin>
                  <ChatViewPage />
                </RequireAdmin>
              }
            />
            <Route
              path="admin/keys/:id"
              element={
                <RequireAdmin>
                  <KeyFormPage />
                </RequireAdmin>
              }
            />
            <Route
              path="admin/people/:id"
              element={
                <RequireAdmin>
                  <PersonFormPage />
                </RequireAdmin>
              }
            />
            <Route
              path="admin/groups/:id"
              element={
                <RequireAdmin>
                  <GroupFormPage />
                </RequireAdmin>
              }
            />
            <Route
              path="admin/mcp/:id"
              element={
                <RequireAdmin>
                  <McpFormPage />
                </RequireAdmin>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}

/** An address from when Settings was Account (/account/memory): the same page under /settings. */
function FromAccount() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={pathname.replace(/^\/account/, "/settings") + search + hash} replace />;
}
