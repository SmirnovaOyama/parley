import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { CheckList } from "../components/Controls.tsx";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, BusyMark, EmptyState, Spinner } from "../components/Feedback.tsx";
import { LineArea, LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, type KnowledgeBase, type Project } from "../lib/api.ts";
import { formatNumber, plural, shortDate } from "../lib/format.ts";
import { andText, t, tn } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

const MAX_PROJECT_INSTRUCTIONS = 8000;

/** What a project holds, as a sentence for its row. */
function projectDesc(p: Project): string {
  const chats = p.chats ? tn(p.chats, "Holds {chats} chat", "Holds {chats} chats", { chats: formatNumber(p.chats) }) : t("No chats yet");
  const extras = [p.instructions.trim() && t("instructions"), p.knowledgeIds.length && plural(p.knowledgeIds.length, "knowledge base", "knowledge bases")].filter(Boolean) as string[];
  return extras.length ? t("{chats}, with {extras}", { chats, extras: andText(extras) }) : chats;
}

/** Every project (/projects): folders of chats with their own instructions and knowledge. */
export function ProjectsPage() {
  const { projects, refreshProjects } = useSession();
  const slideTo = useSlideNavigate();
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void refreshProjects().finally(() => setLoaded(true));
  }, [refreshProjects]);

  return (
    <>
      <PageHeader
        title={t("Projects")}
        subtitle={projects.length ? plural(projects.length, "project", "projects") : undefined}
        back={{ label: t("Chats"), to: "/chats", mobileOnly: true }}
        trailing={
          <button type="button" className="btn-primary" onClick={() => slideTo("/projects/new", "forward")}>
            <Icon name="plus" size={20} />
            {t("New project")}
          </button>
        }
      />
      <div className="oy-page-column page-body">
        {!loaded && !projects.length ? (
          <Spinner />
        ) : projects.length === 0 ? (
          <EmptyState doodle="folder" title={t("No projects yet")}>
            {t("A project keeps related chats together, with instructions and knowledge that every chat in it shares")}
          </EmptyState>
        ) : (
          <div className="oy-section">
            {projects.map((p) => (
              <SlideLink key={p.id} className="oy-row" to={`/projects/${p.id}`} direction="forward">
                <Icon name="folder" size={20} />
                <div className="text">
                  <p className="title truncate">{p.name}</p>
                  <div className="desc">{projectDesc(p)}</div>
                </div>
                <span className="trail tabular">{shortDate(p.updatedAt)}</span>
                <Icon name="chevron-right" size={18} className="chevron" />
              </SlideLink>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

/** One project (/projects/:id): a way to start a chat in it, and its chats. */
export function ProjectPage() {
  const { id = "" } = useParams();
  const { conversations, refreshConversations } = useSession();
  const open = useSlideNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProject(null);
    api.get<{ project: Project }>(`/projects/${id}`).then((r) => setProject(r.project), () => setMissing(true));
    void refreshConversations();
  }, [id, refreshConversations]);

  if (missing) {
    return (
      <>
        <PageHeader title={t("Project")} back={{ label: t("Projects"), to: "/projects" }} />
        <div className="oy-page-column page-body">
          <EmptyState doodle="folder" title={t("This project isn't here")}>
            {t("It may have been deleted")}
          </EmptyState>
        </div>
      </>
    );
  }

  const chats = conversations.filter((c) => c.projectId === id);
  const startChat = () => open(`/chat?project=${id}`, "forward");

  return (
    <>
      <PageHeader
        title={project?.name ?? t("Project")}
        subtitle={project ? projectDesc(project) : undefined}
        back={{ label: t("Projects"), to: "/projects" }}
        trailing={
          <SlideLink className="btn-ghost icon-button" to={`/projects/${id}/settings`} direction="forward" aria-label={t("Project settings")}>
            <Icon name="gear" size={20} />
          </SlideLink>
        }
      />
      <div className="oy-page-column page-body">
        {!project ? (
          <Spinner />
        ) : (
          <>
            {project.instructions.trim() && <p className="project-instructions">{project.instructions}</p>}
            <div className="form-page-actions project-actions">
              <button type="button" className="btn-primary" onClick={startChat}>
                <Icon name="compose" size={18} />
                {t("New chat in this project")}
              </button>
            </div>
            <div className="oy-group settings-group">
              <p className="oy-overline">{t("Chats")}</p>
              {chats.length === 0 ? (
                <p className="group-empty">{t("No chats here yet. Start one, or move a chat in from its settings")}</p>
              ) : (
                <div className="oy-section">
                  {chats.map((c) => (
                    <button key={c.id} type="button" className="oy-row" onClick={() => open(`/chat/${c.id}`, "forward")}>
                      <Icon name={c.pinnedAt ? "pin" : "chat"} size={20} />
                      <div className="text">
                        <p className="title truncate">{c.title}</p>
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
        )}
      </div>
    </>
  );
}

/** A new project (/projects/new), or one's name, instructions and knowledge (/projects/:id/settings). */
export function ProjectSettingsPage() {
  const { id = "new" } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const { refreshProjects, refreshConversations } = useSession();
  const [project, setProject] = useState<Project | null>(null);
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [knowledge, setKnowledge] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ knowledge: KnowledgeBase[] }>("/knowledge").then((r) => setBases(r.knowledge), () => setBases([]));
    if (adding) return;
    api.get<{ project: Project }>(`/projects/${id}`).then(
      (r) => {
        setProject(r.project);
        setName(r.project.name);
        setInstructions(r.project.instructions);
        setKnowledge(r.project.knowledgeIds);
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const back = adding ? "/projects" : `/projects/${id}`;
  const left = MAX_PROJECT_INSTRUCTIONS - instructions.length;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("Give the project a name"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project: saved } = adding
        ? await api.post<{ project: Project }>("/projects", { name, instructions })
        : await api.patch<{ project: Project }>(`/projects/${id}`, { name, instructions });
      const before = project?.knowledgeIds ?? [];
      if ([...knowledge].sort().join() !== [...before].sort().join()) await api.put(`/projects/${saved.id}/knowledge`, { knowledgeIds: knowledge });
      void refreshProjects();
      // A new project opens on from the form; saved settings slide back to the project.
      slideTo(`/projects/${saved.id}`, adding ? "forward" : "back", { replace: adding });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.del(`/projects/${id}`);
    void refreshProjects();
    void refreshConversations();
    slideTo("/projects", "back", { replace: true });
  };

  return (
    <>
      <PageHeader
        title={adding ? t("New project") : t("Project settings")}
        subtitle={adding ? t("Chats you start in it share its instructions and knowledge") : undefined}
        back={{ label: adding ? t("Projects") : (project?.name ?? t("Project")), to: back }}
      />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !adding && !project ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              <LineField id="project-name" label={t("Name")} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              <LineArea
                id="project-instructions"
                label={t("Instructions for every chat in it")}
                value={instructions}
                maxLength={MAX_PROJECT_INSTRUCTIONS}
                onChange={(e) => setInstructions(e.target.value)}
                hint={left <= 400 ? t("{left} characters left", { left }) : t("What the chats are about, and how the AI should work in them")}
              />
              {bases && (
                <CheckList
                  label={t("Knowledge its chats can search")}
                  values={knowledge}
                  onChange={setKnowledge}
                  options={bases.map((k) => ({ id: k.id, label: k.name, detail: k.shared && !k.mine ? tn(k.docs, "Shared by your admins. {docs} document", "Shared by your admins. {docs} documents", { docs: formatNumber(k.docs) }) : plural(k.docs, "document", "documents") }))}
                  empty={t("You have no knowledge bases yet. Make one under Knowledge, then pick it here")}
                />
              )}
              {!adding && <p className="panel-note">{t("A change reaches each chat in the project with its next message")}</p>}
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy}>
                  {adding ? t("Make project") : t("Save")}
                </BusyButton>
                <SlideLink to={back} direction="back" className="btn-secondary">
                  {t("Cancel")}
                </SlideLink>
              </div>
            </form>
            {!adding && (
              <div className="settings-danger">
                <DangerRow label={t("Delete this project")} confirmLabel={t("Delete this project? Its chats stay, moved out of it")} onConfirm={remove} />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
