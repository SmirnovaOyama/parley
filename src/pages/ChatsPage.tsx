import { useEffect } from "react";
import { BusyMark, EmptyState } from "../components/Feedback.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Icon } from "../icons/Icon.tsx";
import { shortDate } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

/** The list of chats; the main way in on phones, where the sidebar is hidden. */
export function ChatsPage() {
  const { conversations, refreshConversations } = useSession();
  // Opening a chat (or a new one) slides it in from the right.
  const open = useSlideNavigate();

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

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
          <div className="oy-section">
            {conversations.map((c) => (
              <button key={c.id} type="button" className="oy-row" onClick={() => open(`/chat/${c.id}`, "forward")}>
                <Icon name="chat" size={20} />
                <div className="text">
                  <p className="title truncate">
                    {c.title}
                    {c.shared && <span className="tag">Shared</span>}
                  </p>
                </div>
                {c.generating && <BusyMark />}
                <span className="trail tabular">{shortDate(c.updatedAt)}</span>
                <Icon name="chevron-right" size={18} className="chevron" />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
