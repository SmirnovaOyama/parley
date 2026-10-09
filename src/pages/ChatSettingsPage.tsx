import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DangerRow } from "../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { charsLeft, MAX_INSTRUCTION_CHARS } from "../components/InstructionsForm.tsx";
import { LineArea, LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SharePanel } from "../components/SharePanel.tsx";
import { api, type Instructions, type Message, type Share, type SharingMode } from "../lib/api.ts";
import { Icon } from "../icons/Icon.tsx";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

type Loaded = {
  conversation: { id: string; title: string; instructions: Instructions };
  messages: Message[];
  generating: boolean;
  share: Share | null;
  sharing: SharingMode;
};

/**
 * One chat's settings, on their own page (/chat/:id/settings): its name and instructions, its
 * share link, and deleting it. /chat/new/settings sets the instructions for the chat about to start.
 */
export function ChatSettingsPage() {
  const { id = "new" } = useParams();
  const isNew = id === "new";
  const navigate = useNavigate();
  const slideTo = useSlideNavigate();
  const { refreshConversations, newChatInstructions, setNewChatInstructions } = useSession();

  const [chat, setChat] = useState<Loaded | null>(null);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState("");
  const [aboutMe, setAboutMe] = useState("");
  const [answerStyle, setAnswerStyle] = useState("");
  const [saved, setSaved] = useState<{ name: string } & Instructions>({ name: "", aboutMe: "", answerStyle: "" });
  const [ready, setReady] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReady(false);
    const fill = (title: string, ins: Instructions) => {
      setName(title);
      setAboutMe(ins.aboutMe);
      setAnswerStyle(ins.answerStyle);
      setSaved({ name: title, ...ins });
      setReady(true);
    };
    if (isNew) {
      // The chat about to start: a draft from earlier, else the Account defaults.
      if (newChatInstructions) fill("", newChatInstructions);
      else api.get<Instructions>("/auth/instructions").then((d) => fill("", d), () => fill("", { aboutMe: "", answerStyle: "" }));
      return;
    }
    api.get<Loaded>(`/conversations/${id}`).then(
      (data) => {
        setChat(data);
        setShare(data.share);
        fill(data.conversation.title, data.conversation.instructions);
      },
      () => setMissing(true),
    );
    // The draft is read once, when the page opens.
  }, [id, isNew]);

  const back = isNew ? "/chat" : `/chat/${id}`;
  const next = { aboutMe: aboutMe.trim(), answerStyle: answerStyle.trim() };
  const nameChanged = !isNew && name.trim() !== saved.name;
  const instructionsChanged = next.aboutMe !== saved.aboutMe || next.answerStyle !== saved.answerStyle;

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
        slideTo(back, "back", { state: { note: "Saved for this chat" } });
        return;
      }
      if (nameChanged) await api.patch(`/conversations/${id}`, { title: name.trim() });
      if (instructionsChanged) await api.put<Instructions>(`/conversations/${id}/instructions`, next);
      if (nameChanged) void refreshConversations();
      slideTo(back, "back", { state: { note: instructionsChanged ? "Saved. The instructions apply from your next message" : "Saved" } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.del(`/conversations/${id}`);
    void refreshConversations();
    navigate("/chat", { replace: true });
  };

  // The page slid in from the chat, so every way back slides it away again.
  const backLink = { label: isNew ? "New chat" : chat?.conversation.title ?? "Chat", to: back, slide: true };

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
        {!ready ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              {!isNew && (
                <LineField id="chat-name" label="Name" value={name} maxLength={120} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              )}
              <LineArea
                id="chat-about"
                label="What should the AI know about you?"
                value={aboutMe}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAboutMe(e.target.value)}
                hint={charsLeft(aboutMe)}
              />
              <LineArea
                id="chat-style"
                label="How should it answer?"
                value={answerStyle}
                maxLength={MAX_INSTRUCTION_CHARS}
                onChange={(e) => setAnswerStyle(e.target.value)}
                hint={charsLeft(answerStyle)}
              />
              <p className="panel-note">
                {isNew
                  ? "For this chat only. Your defaults for new chats are under Account"
                  : "For this chat only. A change applies from your next message"}
              </p>
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <button type="submit" className="btn-primary" disabled={busy || (!nameChanged && !instructionsChanged)}>
                  Save
                </button>
                <Link
                  to={back}
                  className="btn-secondary"
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    slideTo(back, "back");
                  }}
                >
                  Cancel
                </Link>
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
                    <div className="share-panel">
                      <p className="share-text">Save this chat as a Markdown file: what's on screen, without the AI's thinking</p>
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
                  <DangerRow
                    label="Delete this chat"
                    confirmLabel="Delete this chat? Admins of this site can still see it"
                    onConfirm={remove}
                  />
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
