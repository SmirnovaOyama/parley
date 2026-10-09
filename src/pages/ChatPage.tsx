import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { EmptyState, Spinner, Advisory } from "../components/Feedback.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { ModelPicker } from "../components/ModelPicker.tsx";
import { Transcript, type UiMessage } from "../components/Transcript.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, streamChat, type Choice, type Instructions, type Message, type ModelChoice, type Share } from "../lib/api.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

type Loaded = {
  conversation: {
    id: string;
    title: string;
    keyId: number | null;
    model: string | null;
    effort: string | null;
    instructions: Instructions;
  };
  messages: Message[];
  generating: boolean;
  share: Share | null;
};
type Models = { choices: ModelChoice[]; start: Choice | null };
/** What a chat last ran on; model and effort are missing on chats from before they were kept. */
type ChatPick = { keyId: number | null; model?: string | null; effort?: string | null };

/**
 * The pick shown for a chat: what it last ran on when that's still offered (its thinking level if
 * the model still takes it), the key's starting model for older chats, else the person's start.
 */
function resolvePick(models: Models, pick: ChatPick | null): Choice | null {
  const { choices, start } = models;
  const forKey = pick?.keyId != null ? choices.filter((c) => c.keyId === pick.keyId) : [];
  const match = forKey.find((c) => c.model === pick?.model) ?? (start?.keyId === pick?.keyId ? forKey.find((c) => c.model === start?.model) : undefined) ?? forKey[0];
  if (!match) return start;
  const effort = match.efforts.some((e) => e.id === pick?.effort) ? pick!.effort! : match.defaultEffort;
  return { keyId: match.keyId, model: match.model, effort };
}

const NEAR_BOTTOM = 48;
const POLL_MS = 1500;

export function ChatPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { conversations, touchConversation, refreshConversations, newChatInstructions, setNewChatInstructions } = useSession();

  const [messages, setMessages] = useState<UiMessage[]>([]);
  // An open chat starts with its title from the list and the loading line, so its first frame
  // (the one that slides in from the chat list) is already right.
  const [title, setTitle] = useState(() => (id && conversations.find((c) => c.id === id)?.title) || "New chat");
  const [loading, setLoading] = useState(!!id);
  const [missing, setMissing] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [share, setShare] = useState<Share | null>(null);
  /** A short line under the title, e.g. after saving this chat's settings. */
  const [headerNote, setHeaderNote] = useState<string | null>(null);
  const [models, setModels] = useState<Models>({ choices: [], start: null });
  // The model and thinking level for this chat: what it used last, or the person's start.
  const [choice, setChoice] = useState<Choice | null>(null);
  const [chatPick, setChatPick] = useState<ChatPick | null>(null);

  useEffect(() => {
    api.get<Models>("/models").then(setModels, () => {});
  }, []);

  useEffect(() => {
    setChoice(resolvePick(models, chatPick));
  }, [chatPick, models]);

  // Which conversation the screen shows; stream handlers only touch state while it matches.
  const shownIdRef = useRef<string | null>(id ?? null);
  const justCreatedRef = useRef<string | null>(null);
  const listenRef = useRef<AbortController | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  const load = useCallback(async (convId: string) => {
    try {
      const data = await api.get<Loaded>(`/conversations/${convId}`);
      if (shownIdRef.current !== convId) return;
      setTitle(data.conversation.title);
      setChatPick({ keyId: data.conversation.keyId, model: data.conversation.model, effort: data.conversation.effort });
      setShare(data.share);
      setMessages(
        data.generating
          ? [...data.messages, { id: -1, parentId: null, role: "assistant", text: "", model: "", status: "ok", error: null, note: null, thinking: null, thinkingMs: null, instructionsChanged: false, siblingIds: [], createdAt: "", streaming: true, phase: "writing" }]
          : data.messages,
      );
      setSending(data.generating);
      setMissing(false);
      return data.generating;
    } catch {
      if (shownIdRef.current === convId) setMissing(true);
      return false;
    } finally {
      if (shownIdRef.current === convId) setLoading(false);
    }
  }, []);

  // Open a conversation (or a blank one). Coming back to a reply that's still being written
  // polls until it's saved.
  useEffect(() => {
    shownIdRef.current = id ?? null;
    setSendError(null);
    setShare(null);
    // Coming back from this chat's settings page, say what was saved.
    const note = (location.state as { note?: string } | null)?.note ?? null;
    setHeaderNote(note);
    if (note) navigate(location.pathname, { replace: true, state: null });
    if (!id) {
      setMessages([]);
      setChatPick(null);
      setTitle("New chat");
      setMissing(false);
      setLoading(false);
      setSending(false);
      return;
    }
    if (justCreatedRef.current === id) {
      justCreatedRef.current = null;
      return;
    }

    setLoading(true);
    const listed = conversations.find((c) => c.id === id);
    if (listed) setTitle(listed.title);
    setMessages([]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const still = await load(id);
      if (still && shownIdRef.current === id) timer = setTimeout(poll, POLL_MS);
      else if (shownIdRef.current === id) void refreshConversations();
    };
    void poll();
    return () => clearTimeout(timer);
  }, [id, load, refreshConversations]);

  // Stop listening (not generating) when the page goes away.
  useEffect(() => () => listenRef.current?.abort(), []);

  // Keep the newest text in view while it streams, unless the reader scrolled up. Any move up
  // lets go at once (a near-bottom threshold alone snapped the page back every frame while the
  // reader was still within reach of the end); reaching the end again picks it back up.
  const stickRef = useRef(true);
  const heightRef = useRef(0);
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      if (y < lastY - 1) stickRef.current = false;
      else if (window.innerHeight + y >= document.documentElement.scrollHeight - NEAR_BOTTOM) stickRef.current = true;
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  // Follow only when the page actually grew: a reply that's thinking behind a folded "Thinking"
  // changes nothing on screen, so the page is left alone.
  useLayoutEffect(() => {
    const height = document.documentElement.scrollHeight;
    if (stickRef.current && height !== heightRef.current) window.scrollTo({ top: height });
    heightRef.current = height;
  }, [messages]);

  // Three ways to get a reply: a new message at the end, an edited message (a new version of it,
  // keeping the old branch), or a regenerated reply (a new version of the reply). Each one shows
  // up straight away and is replaced by the saved branch once the reply is in.
  type Run =
    | { kind: "new"; text: string }
    | { kind: "edit"; text: string; target: UiMessage }
    | { kind: "regenerate"; target: UiMessage };

  const run = async (request: Run) => {
    if (sending) return;
    if (request.kind !== "regenerate" && !request.text.trim()) return;
    const text = request.kind === "regenerate" ? "" : request.text.trim();
    setSendError(null);
    setSending(true);
    if (request.kind === "new") setDraft("");
    setHeaderNote(null);
    stickRef.current = request.kind === "new";

    let convId = id ?? null;
    const isShown = () => shownIdRef.current === convId;
    const before = messages;
    const tempUserId = -Date.now();
    const tempReplyId = tempUserId - 1;
    const now = new Date().toISOString();
    const blank = { model: "", status: "ok" as const, error: null, note: null, thinking: null, thinkingMs: null, instructionsChanged: false, siblingIds: [], createdAt: now };
    const tempUser: UiMessage = { ...blank, id: tempUserId, parentId: null, role: "user", text };
    const tempReply: UiMessage = { ...blank, id: tempReplyId, parentId: null, role: "assistant", text: "", streaming: true, phase: "waiting" };
    // Everything after the edited message, or from the regenerated reply on, belongs to the old branch.
    const cut = request.kind === "new" ? before.length : before.findIndex((m) => m.id === request.target.id);
    setMessages([...before.slice(0, cut), ...(request.kind === "regenerate" ? [tempReply] : [tempUser, tempReply])]);

    const patchReply = (fn: (m: UiMessage) => UiMessage) =>
      isShown() && setMessages((list) => list.map((m) => (m.id === tempReplyId ? fn(m) : m)));

    // Text and thinking arrive token by token; paint them once per frame.
    let buffered = "";
    let bufferedThinking = "";
    let frame = 0;
    const flush = () => {
      frame = 0;
      const chunk = buffered;
      const thought = bufferedThinking;
      buffered = "";
      bufferedThinking = "";
      if (chunk || thought) {
        patchReply((m) => ({
          ...m,
          text: m.text + chunk,
          thinking: thought ? (m.thinking ?? "") + thought : m.thinking,
          phase: chunk || m.text ? "writing" : "thinking",
        }));
      }
    };

    const picked = choice ? { keyId: choice.keyId, model: choice.model, effort: choice.effort } : {};
    const body =
      request.kind === "new"
        ? { conversationId: convId, text, ...picked, ...(convId || !newChatInstructions ? {} : { instructions: newChatInstructions }) }
        : request.kind === "edit"
          ? { conversationId: convId, text, ...picked, parentId: request.target.parentId }
          : { conversationId: convId, ...picked, regenerate: request.target.parentId! };

    const listen = new AbortController();
    listenRef.current = listen;
    // The reply is in: free the message box and swap in the saved branch, so every message has
    // its real id and version count. (The stream may stay open a little longer for a new title.)
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      if (streamingIdRef.current === convId) streamingIdRef.current = null;
      // The reply is saved: its spinner in the chat list stops.
      void refreshConversations();
      if (!isShown()) return;
      setSending(false);
      const saved = convId;
      if (saved) {
        api.get<Loaded>(`/conversations/${saved}`).then(
          (data) => shownIdRef.current === saved && !data.generating && setMessages(data.messages),
          () => {},
        );
      }
    };
    try {
      await streamChat(
        body,
        {
          onMeta: (meta) => {
            convId = meta.conversationId;
            streamingIdRef.current = convId;
            if (meta.created) {
              // The draft instructions went with the first message; the next new chat starts afresh.
              setNewChatInstructions(null);
              shownIdRef.current = convId;
              justCreatedRef.current = convId;
              setTitle(meta.title);
              navigate(`/chat/${convId}`, { replace: true });
            }
            touchConversation({ id: convId, title: meta.title, updatedAt: new Date().toISOString(), generating: true });
            if (isShown()) {
              setChatPick({ keyId: meta.keyId, model: meta.modelId, effort: meta.effort });
              setMessages((list) =>
                list.map((m) =>
                  m.id === tempUserId ? { ...m, id: meta.userMessageId } : m.id === tempReplyId ? { ...m, model: meta.model } : m,
                ),
              );
            }
          },
          onDelta: (t) => {
            buffered += t;
            if (!frame) frame = requestAnimationFrame(flush);
          },
          onThinking: (t) => {
            bufferedThinking += t;
            if (!frame) frame = requestAnimationFrame(flush);
          },
          onStatus: (status, detail) => patchReply((m) => ({ ...m, phase: status, searchQuery: status === "searching" ? detail : undefined })),
          onNotice: (notice) => patchReply((m) => ({ ...m, notice })),
          onDone: (message) => {
            cancelAnimationFrame(frame);
            patchReply((m) => ({ ...message, notice: m.notice }));
            settle();
          },
          onError: (message) => {
            cancelAnimationFrame(frame);
            patchReply(() => message);
            settle();
          },
          // A title written after the reply: the stream stays open a moment longer for it.
          onTitle: (newTitle) => {
            if (!convId) return;
            touchConversation({ id: convId, title: newTitle, updatedAt: new Date().toISOString() });
            if (isShown()) setTitle(newTitle);
          },
        },
        listen.signal,
      );
    } catch (err) {
      if (!listen.signal.aborted && isShown()) {
        // Refused before anything was saved (no key, over the limit, too fast): put things back.
        setMessages(before);
        if (request.kind === "new") setDraft(text);
        setSendError((err as Error).message);
      }
    } finally {
      if (listenRef.current === listen) listenRef.current = null;
      if (streamingIdRef.current === convId) streamingIdRef.current = null;
      if (isShown()) setSending(false);
    }
  };

  const send = (text: string) => run({ kind: "new", text });

  const switchVersion = async (messageId: number) => {
    if (!id || sending) return;
    try {
      const { messages: next } = await api.post<{ messages: Message[] }>(`/conversations/${id}/branch`, { messageId });
      if (shownIdRef.current === id) setMessages(next);
    } catch (err) {
      setSendError((err as Error).message);
    }
  };

  // The chat's settings slide in from the right, like opening a chat from the list.
  const slideTo = useSlideNavigate();
  const settingsPath = `/chat/${id ?? "new"}/settings`;

  const stop = () => {
    const convId = streamingIdRef.current ?? id;
    if (convId) void api.post(`/conversations/${convId}/stop`);
  };

  return (
    <div className="chat">
      <PageHeader
        title={title}
        back={{ label: "Chats", to: "/chats", mobileOnly: true, slide: true }}
        subtitle={share ? "Shared with a link" : undefined}
        below={headerNote ? <p className="header-note">{headerNote}</p> : undefined}
        trailing={
          !missing ? (
            <Link
              className="btn-ghost icon-button"
              to={settingsPath}
              aria-label="Chat settings"
              onClick={(e) => {
                // A plain click slides; a modified click (new tab) behaves as a link.
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                e.preventDefault();
                slideTo(settingsPath, "forward");
              }}
            >
              <Icon name="gear" size={20} />
            </Link>
          ) : undefined
        }
      />

      <div className="oy-page-column chat-body">
        {loading ? (
          <Spinner label="Loading the chat" />
        ) : missing ? (
          <EmptyState doodle="chat" title="This chat isn't here">
            It may have been deleted
          </EmptyState>
        ) : messages.length === 0 ? (
          <EmptyState doodle="chat" title="Start a new chat">
            Ask a question, draft something or think out loud
          </EmptyState>
        ) : (
          <Transcript
            messages={messages}
            busy={sending}
            onEdit={(target, text) => void run({ kind: "edit", text, target })}
            onRegenerate={(target) => void run({ kind: "regenerate", target })}
            onSwitch={(messageId) => void switchVersion(messageId)}
          />
        )}
      </div>

      {!missing && (
        <div className="composer-dock">
          <div className="oy-page-column">
            {sendError && <Advisory>{sendError}</Advisory>}
            {/* One line above the box: the model on the left, thinking on the right. */}
            <div className="composer-head">
              <ModelPicker choices={models.choices} value={choice} onChange={setChoice} disabled={sending} />
            </div>
            <Composer value={draft} onChange={setDraft} onSend={() => void send(draft)} onStop={stop} sending={sending} />
            {/* Under the box, centred, so it never wraps onto a half-empty line of its own. */}
            <p className="composer-note">
              <Icon name="eye" size={14} />
              Admins can read chats
            </p>
          </div>
        </div>
      )}

    </div>
  );
}

type ComposerProps = { value: string; onChange: (v: string) => void; onSend: () => void; onStop: () => void; sending: boolean };

function Composer({ value, onChange, onSend, onStop, sending }: ComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  useEffect(() => {
    if (!sending) ref.current?.focus();
  }, [sending]);

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sending) onSend();
      }}
    >
      <label htmlFor="composer-input" className="visually-hidden">
        Message
      </label>
      <textarea
        id="composer-input"
        ref={ref}
        rows={1}
        value={value}
        placeholder="Write a message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter adds a line; never while an input method is composing.
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (!sending) onSend();
          }
        }}
      />
      {sending ? (
        <button type="button" className="composer-send is-stop" onClick={onStop} aria-label="Stop the reply">
          <Icon name="stop" size={16} />
        </button>
      ) : (
        <button type="submit" className="composer-send" disabled={!value.trim()} aria-label="Send">
          <Icon name="send" size={20} strokeWidth={2.1} />
        </button>
      )}
    </form>
  );
}
