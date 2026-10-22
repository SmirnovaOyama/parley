import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Marked, searchWords, useChatSearch } from "../components/ChatSearch.tsx";
import { BusyMark, EmptyState, Spinner } from "../components/Feedback.tsx";
import { SearchLine } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { formatNumber, shortDate } from "../lib/format.ts";
import { groupChats } from "../lib/groups.ts";
import { t, tn } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

/** The list of chats, in groups by when they were last active; the main way in on phones, where the sidebar is hidden. */
export function ChatsPage() {
  const { conversations, refreshConversations, projects, refreshProjects } = useSession();
  // Opening a chat (or a new one), Projects or Knowledge slides it in from the right.
  const open = useSlideNavigate();
  // The search is kept in the address, so coming back from a chat finds it as it was.
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const results = useChatSearch(query);
  const words = searchWords(query);

  useEffect(() => {
    void refreshConversations();
    void refreshProjects();
  }, [refreshConversations, refreshProjects]);

  const search = (next: string) => {
    setQuery(next);
    setParams(next.trim() ? { q: next.trim() } : {}, { replace: true });
  };

  const projectName = (id: string | null | undefined) => (id ? projects.find((p) => p.id === id)?.name : undefined);

  return (
    <>
      <PageHeader
        title={t("Chats")}
        subtitle={conversations.length ? tn(conversations.length, "{length} chat", "{length} chats", { length: conversations.length }) : undefined}
        trailing={
          <button type="button" className="btn-primary" onClick={() => open("/chat", "forward")}>
            <Icon name="compose" size={20} />
            {t("New chat")}
          </button>
        }
      />
      <div className="oy-page-column page-body">
        <SearchLine id="chats-search" label={t("Search your chats")} value={query} onChange={search} className="chats-search" />

        {query.trim() ? (
          !results ? (
            <Spinner label={t("Searching")} />
          ) : results.length === 0 ? (
            <EmptyState title={t("No chats match")}>{t("Try other words, or fewer of them")}</EmptyState>
          ) : (
            <div className="oy-group">
              <p className="oy-overline">{tn(results.length, "{length} chat", "{length} chats", { length: formatNumber(results.length) })}</p>
              <div className="oy-section">
                {results.map((r) => (
                  <button key={r.id} type="button" className="oy-row" onClick={() => open(`/chat/${r.id}`, "forward")}>
                    <Icon name="chat" size={20} />
                    <div className="text">
                      <p className="title truncate">
                        <Marked text={r.title} words={words} />
                        {projectName(r.projectId) && <span className="tag">{projectName(r.projectId)}</span>}
                      </p>
                      {r.snippet && (
                        <p className="desc chat-snippet">
                          <Marked text={r.snippet} words={words} />
                        </p>
                      )}
                    </div>
                    <span className="trail tabular">{shortDate(r.updatedAt)}</span>
                    <Icon name="chevron-right" size={18} className="chevron" />
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <>
            {/* Projects and knowledge live in the sidebar on wide screens; here they lead the list. */}
            <div className="oy-section chats-places">
              <SlideLink className="oy-row" to="/compare" direction="forward">
                <Icon name="compare" size={20} />
                <div className="text">
                  <p className="title">{t("Compare models")}</p>
                  <p className="desc">{t("Ask one question and compare the answers")}</p>
                </div>
                <Icon name="chevron-right" size={18} />
              </SlideLink>
              <SlideLink className="oy-row" to="/tasks" direction="forward">
                <Icon name="clock" size={20} />
                <div className="text">
                  <p className="title">{t("Scheduled tasks")}</p>
                  <p className="desc">{t("Run prompts on a schedule")}</p>
                </div>
                <Icon name="chevron-right" size={18} />
              </SlideLink>
              <SlideLink className="oy-row" to="/projects" direction="forward">
                <Icon name="folder" size={20} />
                <div className="text">
                  <p className="title">{t("Projects")}</p>
                </div>
                <span className="trail tabular">{projects.length || ""}</span>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
              <SlideLink className="oy-row" to="/knowledge" direction="forward">
                <Icon name="book" size={20} />
                <div className="text">
                  <p className="title">{t("Knowledge")}</p>
                </div>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
            </div>

            {conversations.length === 0 ? (
              <EmptyState
                doodle="chat"
                title={t("No chats yet")}
                action={
                  <button type="button" className="btn-primary" onClick={() => open("/chat", "forward")}>
                    {t("Start a chat")}
                  </button>
                }
              >
                {t("Start one and it shows up here")}
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
                            {c.shared && <span className="tag">{t("Shared")}</span>}
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
          </>
        )}
      </div>
    </>
  );
}
