import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { CheckList, OptionList, Switch } from "../components/Controls.tsx";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { LineArea, LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SharePanel } from "../components/SharePanel.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { api, type Instructions, type KnowledgeBase, type Message, type Persona, type Policy, type Share, type SharingMode } from "../lib/api.ts";
import { Icon } from "../icons/Icon.tsx";
import { plural } from "../lib/format.ts";
import { ABOUT_HINT, charsLeft, MAX_INSTRUCTION_CHARS, STYLE_HINT } from "../lib/instructions.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

type Loaded = {
  conversation: {
    id: string;
    title: string;
    instructions: Instructions;
    project: { id: string; name: string } | null;
    knowledgeIds: string[];
    pinned: boolean;
  };
  messages: Message[];
  generating: boolean;
  share: Share | null;
  sharing: SharingMode;
};

type Saved = { name: string; aboutMe: string; answerStyle: string; projectId: string; knowledge: string[]; pinned: boolean };

/** What the delete line says, by how long the site keeps deleted chats for its admins. */
function deleteWarning(policy: Policy | null): string {
  const days = policy?.retainDeletedDays;
  if (days === 0) return "Delete this chat? It's gone for good, for admins too";
  if (days != null) return `Delete this chat? Admins of this site can still see it for ${plural(days, "day", "days")}`;
  return "Delete this chat? Admins of this site can still see it";
}

/**
 * One chat's settings, on their own page (/chat/:id/settings): its name and instructions, its
 * project and knowledge, pinning, its share link, and deleting it. /chat/new/settings sets these
 * for the chat about to start.
 */
export function ChatSettingsPage() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const { search } = useLocation();
  const slideTo = useSlideNavigate();
  const { refreshConversations, newChatInstructions, setNewChatInstructions, newChatKnowledge, setNewChatKnowledge, projects, refreshProjects } = useSession();
  const startProject = isNew ? (new URLSearchParams(search).get("project") ?? "") : "";

  const [chat, setChat] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [aboutMe, setAboutMe] = useState("");
  const [answerStyle, setAnswerStyle] = useState("");
  const [projectId, setProjectId] = useState("");
  const [knowledge, setKnowledge] = useState<string[]>([]);
  const [pinned, setPinned] = useState(false);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [personas, setPersonas] = useState<Persona[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [saved, setSaved] = useState<Saved>({ name: "", aboutMe: "", answerStyle: "", projectId: "", knowledge: [], pinned: false });
  const [ready, setReady] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReady(false);
    void refreshProjects();
    api.get<{ knowledge: KnowledgeBase[] }>("/knowledge").then((r) => setBases(r.knowledge), () => {});
    api.get<{ personas: Persona[] }>("/personas").then((r) => setPersonas(r.personas), () => setPersonas([]));
    api.get<Policy>("/policy").then(setPolicy, () => {});
    const fill = (next: Saved) => {
      setName(next.name);
      setAboutMe(next.aboutMe);
      setAnswerStyle(next.answerStyle);
      setProjectId(next.projectId);
      setKnowledge(next.knowledge);
      setPinned(next.pinned);
      setSaved(next);
      setReady(true);
    };
    if (isNew) {
      // The chat about to start: a draft from earlier, else the Account defaults.
      const draft = { name: "", projectId: startProject, knowledge: newChatKnowledge, pinned: false };
      if (newChatInstructions) fill({ ...draft, ...newChatInstructions });
      else
        api.get<Instructions>("/auth/instructions").then(
          (d) => fill({ ...draft, ...d }),
          () => fill({ ...draft, aboutMe: "", answerStyle: "" }),
        );
      return;
    }
    api.get<Loaded>(`/conversations/${id}`).then(
      (data) => {
        setChat(data);
        setShare(data.share);
        const c = data.conversation;
        fill({ name: c.title, ...c.instructions, projectId: c.project?.id ?? "", knowledge: c.knowledgeIds, pinned: c.pinned });
      },
      () => setMissing(true),
    );
    // The draft is read once, when the page opens.
  }, [id, isNew]);

  const back = isNew ? `/chat${projectId ? `?project=${projectId}` : ""}` : `/chat/${id}`;
  const next = { aboutMe: aboutMe.trim(), answerStyle: answerStyle.trim() };
  const nameChanged = !isNew && name.trim() !== saved.name;
  const instructionsChanged = next.aboutMe !== saved.aboutMe || next.answerStyle !== saved.answerStyle;
  const projectChanged = projectId !== saved.projectId;
  const knowledgeChanged = [...knowledge].sort().join() !== [...saved.knowledge].sort().join();
  const pinChanged = pinned !== saved.pinned;
  const changed = nameChanged || instructionsChanged || projectChanged || knowledgeChanged || pinChanged;
  const project = projects.find((p) => p.id === projectId);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!isNew && !name.trim()) {
      setError("Give the chat a name");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        setNewChatInstructions(next);
        setNewChatKnowledge(knowledge);
        slideTo(back, "back", { state: { note: "Saved for this chat" } });
        return;
      }
      const patch = {
        ...(nameChanged ? { title: name.trim() } : {}),
        ...(projectChanged ? { projectId: projectId || null } : {}),
        ...(pinChanged ? { pinned } : {}),
      };
      if (Object.keys(patch).length) await api.patch(`/conversations/${id}`, patch);
      if (instructionsChanged) await api.put<Instructions>(`/conversations/${id}/instructions`, next);
      if (knowledgeChanged) await api.put(`/conversations/${id}/knowledge`, { knowledgeIds: knowledge });
      if (nameChanged || projectChanged || pinChanged) void refreshConversations();
      if (projectChanged) void refreshProjects();
      const reachesModel = instructionsChanged || projectChanged || knowledgeChanged;
      slideTo(back, "back", { state: { note: reachesModel ? "Saved. The changes apply from your next message" : "Saved" } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.del(`/conversations/${id}`);
    void refreshConversations();
    slideTo("/chat", "back", { replace: true });
  };

  // The page slid in from the chat, so every way back slides it away again.
  const backLink = { label: isNew ? "New chat" : (chat?.conversation.title ?? "Chat"), to: back };

  if (missing) {
    return (
      <>
        <PageHeader title="Chat settings" back={{ label: "Chats", to: "/chats" }} />
        <div className="oy-page-column page-body">
          <EmptyState doodle="chat" title="This chat isn't here">
            It may have been deleted
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Chat settings" subtitle={isNew ? "For the chat you're about to start" : undefined} back={backLink} />
      <div className="oy-page-column page-body">
        {/* Personas load with the rest, so their list never pops in above the fields. */}
        {!ready || !personas ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              {!isNew && (
                <LineField id="chat-name" label="Name" value={name} maxLength={120} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              )}
              {personas.length > 0 && (
                // Picking one copies its words into the fields below; the tick follows whichever
                // persona the words still match.
                <OptionList
                  label="Persona"
                  value={personas.find((p) => p.aboutMe === aboutMe.trim() && p.answerStyle === answerStyle.trim())?.id ?? ""}
                  onChange={(pick) => {
                    const p = personas.find((x) => x.id === pick);
                    if (!p) return;
                    setAboutMe(p.aboutMe);
                    setAnswerStyle(p.answerStyle);
                  }}
                  options={personas.map((p) => ({ id: p.id, label: p.name, detail: p.forNewChats ? "New chats start as this one" : undefined }))}
                />
              )}
              <LineArea
                id="chat-about"
                label="What should the AI know about you?"
                value={aboutMe}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAboutMe(e.target.value)}
                hint={charsLeft(aboutMe, ABOUT_HINT)}
              />
              <LineArea
                id="chat-style"
                label="How should it answer?"
                value={answerStyle}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAnswerStyle(e.target.value)}
                hint={charsLeft(answerStyle, STYLE_HINT)}
              />
              <p className="panel-note">
                {isNew
                  ? "For this chat only. Which persona new chats start as is under Account"
                  : "For this chat only. A change applies from your next message"}
              </p>

              {projects.length > 0 && (
                <OptionList
                  label="Project"
                  value={projectId}
                  onChange={setProjectId}
                  options={[
                    { id: "", label: "None" },
                    ...projects.map((p) => ({ id: p.id, label: p.name, detail: p.instructions.trim() ? "Its instructions join this chat's" : undefined })),
                  ]}
                />
              )}

              <CheckList
                label={project ? "Knowledge, besides the project's" : "Knowledge it can search"}
                values={knowledge}
                onChange={setKnowledge}
                options={bases.map((k) => {
                  const shared = k.shared && !k.mine ? "Shared by your admins" : "";
                  const docs = plural(k.docs, "document", "documents");
                  const plain = [shared, docs].filter(Boolean).join(". ");
                  if (!projects.length) return { id: k.id, label: k.name, detail: plain };
                  // With projects to pick from, each row keeps room for the longer line, so picking a
                  // project above never grows the rows here.
                  const inProject = !!project?.knowledgeIds.includes(k.id);
                  return {
                    id: k.id,
                    label: k.name,
                    detail: (
                      <span className="swap">
                        <span className={inProject ? undefined : "reserve"} aria-hidden={inProject ? undefined : true}>
                          {[shared, "The project has it already", docs].filter(Boolean).join(". ")}
                        </span>
                        {!inProject && <span>{plain}</span>}
                      </span>
                    ),
                  };
                })}
                empty="You have no knowledge bases yet. Make one under Knowledge to let chats search your documents"
              />

              {!isNew && (
                <div className="oy-section is-plain">
                  <div className="oy-row">
                    <Icon name="pin" size={20} />
                    <div className="text">
                      <label className="title" htmlFor="chat-pinned">
                        Pin to the top of your chats
                      </label>
                    </div>
                    <Switch id="chat-pinned" checked={pinned} onChange={setPinned} />
                  </div>
                </div>
              )}

              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!changed}>
                  Save
                </BusyButton>
                <SlideLink to={back} direction="back" className="btn-secondary">
                  Cancel
                </SlideLink>
              </div>
            </form>

            {chat && (
              <>
                {(chat.sharing !== "off" || share) && (
                  <div className="oy-group settings-group">
                    <p className="oy-overline">Sharing</p>
                    <SharePanel
                      conversationId={id}
                      share={share}
                      upToDate={!!share && chat.messages.at(-1)?.id === share.leafId}
                      sharing={chat.sharing}
                      busy={chat.generating}
                      empty={chat.messages.length === 0}
                      onChange={(s) => {
                        setShare(s);
                        void refreshConversations();
                      }}
                    />
                  </div>
                )}
                {chat.messages.length > 0 && (
                  <div className="oy-group settings-group">
                    <p className="oy-overline">Export</p>
                    <div className="settings-panel">
                      <p className="settings-text">Save this chat as a Markdown file: what's on screen, without the AI's thinking</p>
                      <div className="form-page-actions">
                        <a className="btn-secondary" href={`/api/conversations/${id}/export`} download>
                          <Icon name="download" size={16} />
                          Download as Markdown
                        </a>
                      </div>
                    </div>
                  </div>
                )}
                {/* The row turns into its "are you sure" line in the same place, so nothing jumps. */}
                <div className="settings-danger">
                  <DangerRow label="Delete this chat" confirmLabel={deleteWarning(policy)} onConfirm={remove} />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
