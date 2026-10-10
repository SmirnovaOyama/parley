import { useEffect } from "react";
import { BusyMark, EmptyState } from "../components/Feedback.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { shortDate } from "../lib/format.ts";
import { groupChats } from "../lib/groups.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

/** The list of chats, in groups by when they were last active; the main way in on phones, where the sidebar is hidden. */
export function ChatsPage() {
  const { conversations, refreshConversations, projects, refreshProjects } = useSession();
  // Opening a chat (or a new one), Projects or Knowledge slides it in from the right.
  const open = useSlideNavigate();

  useEffect(() => {
    void refreshConversations();
    void refreshProjects();
  }, [refreshConversations, refreshProjects]);

  const projectName = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id)?.name : undefined);

  return (
    <>
      <PageHeader
        title="Chats"
        subtitle={conversations.length ? `${conversations.length} ${conversations.length === 1 ? "chat" : "chats"}` : undefined}
        trailing={
          <button type="button" className="btn-primary" onClick={() => open("/chat", "forward")}>
            <Icon name="compose" size={20} />
            New chat
          </button>
        }
      />
      <div className="oy-page-column page-body">
        {/* Projects and knowledge live in the sidebar on wide screens; here they lead the list. */}
        <div className="oy-section chats-places">
          <SlideLink className="oy-row" to="/projects" direction="forward">
            <Icon name="folder" size={20} />
            <div className="text">
              <p className="title">Projects</p>
            </div>
            <span className="trail tabular">{projects.length || ""}</span>
            <Icon name="chevron-right" size={18} className="chevron" />
          </SlideLink>
          <SlideLink className="oy-row" to="/knowledge" direction="forward">
            <Icon name="book" size={20} />
            <div className="text">
              <p className="title">Knowledge</p>
            </div>
            <Icon name="chevron-right" size={18} className="chevron" />
          </SlideLink>
        </div>

        {conversations.length === 0 ? (
          <EmptyState
            doodle="chat"
            title="No chats yet"
            action={
              <button type="button" className="btn-primary" onClick={() => open("/chat", "forward")}>
                Start a chat
              </button>
            }
          >
            Start one and it shows up here
          </EmptyState>
        ) : (
          groupChats(conversations).map((g) => (
            <div key={g.label} className="oy-group">
              <p className="oy-overline">{g.label}</p>
              <div className="oy-section">
                {g.chats.map((c) => (
                  <button key={c.id} type="button" className="oy-row" onClick={() => open(`/chat/${c.id}`, "forward")}>
                    <Icon name={c.pinnedAt ? "pin" : "chat"} size={20} />
                    <div className="text">
                      <p className="title truncate">
                        {c.title}
                        {projectName(c.projectId) && <span className="tag">{projectName(c.projectId)}</span>}
                        {c.shared && <span className="tag">Shared</span>}
                      </p>
                    </div>
                    {c.generating && <BusyMark />}
                    <span className="trail tabular">{shortDate(c.updatedAt)}</span>
                    <Icon name="chevron-right" size={18} className="chevron" />
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
