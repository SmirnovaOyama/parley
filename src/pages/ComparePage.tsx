import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { ComposerFiles, MessageFiles } from "../components/Attachments.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { InlineModelPicker } from "../components/InlineModelPicker.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Transcript, type UiMessage } from "../components/Transcript.tsx";
import { Icon } from "../icons/Icon.tsx";
import {
  api, ApiError, streamChat, type Ask, type Choice, type Comparison, type ComparisonRun,
  type ComparisonSummary, type Message, type ModelChoice,
} from "../lib/api.ts";
import { dateTime } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useUploads } from "../lib/uploads.ts";
import "../styles/compare.css";

type Models = { choices: ModelChoice[]; start: Choice | null };
type UiRun = Omit<ComparisonRun, "messages"> & {
  messages: UiMessage[];
  requestError?: string;
  stopping?: boolean;
};
type UiComparison = Omit<Comparison, "runs"> & { runs: UiRun[] };
type Listener = { comparisonId: string; controller: AbortController };
const POLL_MS = 1500;
const sameModel = (a: Pick<Choice, "keyId" | "model">, b: Pick<Choice, "keyId" | "model">) => a.keyId === b.keyId && a.model === b.model;
const latestReply = (run: UiRun) => [...run.messages].reverse().find((message) => message.role === "assistant");

function pendingReply(run: ComparisonRun, phase: UiMessage["phase"] = "waiting"): UiMessage {
  return {
    id: -run.promptMessageId, parentId: run.promptMessageId, role: "assistant", text: "", model: run.label,
    status: "ok", error: null, note: null, thinking: null, thinkingMs: null, instructionsChanged: false,
    siblingIds: [], createdAt: "", streaming: true, phase, asks: run.asks ?? [],
  };
}

function fromSaved(run: ComparisonRun): UiRun {
  if (run.deleted) return { ...run, messages: [], generating: false };
  return {
    ...run,
    messages: run.generating
      ? [...run.messages.filter((message) => message.role === "user"), pendingReply(run)]
      : run.messages,
  };
}

function statusText(run: UiRun) {
  if (run.deleted) return t("Chat deleted");
  if (run.stopping) return t("Stopping");
  const reply = latestReply(run);
  if (run.generating) {
    if (reply?.asks?.length) return t("Waiting for approval");
    if (reply?.phase === "thinking") return t("Thinking");
    if (reply?.phase === "searching") return t("Searching");
    if (reply?.phase === "coding") return t("Running code");
    if (reply?.phase === "tool") return t("Using a tool");
    if (reply?.phase === "saving") return t("Saving");
    if (reply?.phase === "uploading") return t("Sending files");
    return reply?.text ? t("Writing") : t("Waiting for a reply");
  }
  if (run.requestError || reply?.status === "failed" || reply?.status === "not-sent") return t("Couldn't answer");
  if (run.continued) return t("Continued in chat");
  if (reply?.status === "stopped") return t("Stopped");
  if (reply?.status === "truncated") return t("Answer cut short");
  if (reply?.status === "declined") return t("Declined");
  return reply ? t("Finished") : t("Ready to answer");
}

/** Each answer has its own saved chat, stream and controls, while the prompt stays shared */
export function ComparePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { projects, newChatInstructions, setNewChatInstructions, newChatKnowledge, setNewChatKnowledge, refreshConversations } = useSession();
  const projectId = searchParams.get("project");
  const project = projects.find((item) => item.id === projectId);
  const [models, setModels] = useState<Models>({ choices: [], start: null });
  const [modelsLoading, setModelsLoading] = useState(true);
  const [picks, setPicks] = useState<Choice[]>([]);
  const [draft, setDraft] = useState(() => (location.state as { compareText?: string } | null)?.compareText ?? "");
  const uploads = useUploads();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [comparison, setComparison] = useState<UiComparison | null>(null);
  const [recent, setRecent] = useState<ComparisonSummary[]>([]);
  const [loading, setLoading] = useState(!!id);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [wideAnswers, setWideAnswers] = useState(true);
  const [allRecent, setAllRecent] = useState(false);
  const shownIdRef = useRef<string | null>(id ?? null);
  const createdRef = useRef<string | null>(null);
  const creatingRef = useRef(false);
  const mountedRef = useRef(true);
  const listenersRef = useRef(new Map<string, Listener>());
  const stopRequestedRef = useRef(new Set<string>());
  // A response fetched before a stream changed must never replace its newer answer
  const revisionsRef = useRef(new Map<string, number>());
  const requestsRef = useRef(0);
  const appliedRef = useRef(0);

  const loadRecent = useCallback(async () => {
    try {
      const data = await api.get<{ comparisons: ComparisonSummary[] }>("/comparisons");
      if (mountedRef.current) {
        setRecent(data.comparisons);
        setListError(null);
      }
    } catch (err) {
      if (mountedRef.current) setListError((err as Error).message);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const data = await api.get<Models>("/models");
      if (!mountedRef.current) return;
      setModels(data);
      setPicks((previous) => {
        const next = previous.flatMap((pick) => {
          const offered = data.choices.find((item) => sameModel(item, pick));
          return offered ? [{ ...pick, effort: offered.efforts.some((level) => level.id === pick.effort) ? pick.effort : offered.defaultEffort }] : [];
        });
        const ordered = [...data.choices].sort((a, b) => Number(!!data.start && sameModel(b, data.start)) - Number(!!data.start && sameModel(a, data.start)));
        for (const item of ordered) {
          if (next.length >= Math.max(2, previous.length)) break;
          if (!next.some((pick) => sameModel(pick, item))) next.push({ keyId: item.keyId, model: item.model, effort: item.defaultEffort });
        }
        return next.slice(0, 3);
      });
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      if (mountedRef.current) setModelsLoading(false);
    }
  }, []);

  const load = useCallback(async (comparisonId: string) => {
    const request = ++requestsRef.current;
    const revisions = new Map(revisionsRef.current);
    try {
      const saved = await api.get<Comparison>(`/comparisons/${comparisonId}`);
      if (!mountedRef.current || shownIdRef.current !== comparisonId || request < appliedRef.current) return;
      appliedRef.current = request;
      setComparison((current) => ({
        ...saved,
        runs: saved.runs.map((run) => {
          const previous = current?.id === comparisonId ? current.runs.find((item) => item.conversationId === run.conversationId) : undefined;
          if (previous && (listenersRef.current.has(run.conversationId) || revisionsRef.current.get(run.conversationId) !== revisions.get(run.conversationId))) return previous;
          const next = fromSaved(run);
          // A rejected retry can leave the earlier answer intact, so keep its explanation too
          if (previous?.requestError && !run.generating && !run.deleted && latestReply(previous)?.id === latestReply(next)?.id) next.requestError = previous.requestError;
          return next;
        }),
      }));
      setMissing(false);
      setError(null);
    } catch (err) {
      if (!mountedRef.current || shownIdRef.current !== comparisonId || request < appliedRef.current) return;
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError((err as Error).message);
    } finally {
      if (mountedRef.current && shownIdRef.current === comparisonId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const listener of listenersRef.current.values()) listener.controller.abort();
      listenersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    void loadModels();
    void loadRecent();
    const onShow = () => {
      if (document.visibilityState !== "visible") return;
      void loadModels();
      void loadRecent();
      if (shownIdRef.current) void load(shownIdRef.current);
    };
    window.addEventListener("focus", onShow);
    document.addEventListener("visibilitychange", onShow);
    return () => {
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [loadModels, loadRecent, load]);

  useEffect(() => {
    shownIdRef.current = id ?? null;
    setError(null);
    setMissing(false);
    for (const [conversationId, listener] of listenersRef.current) {
      if (listener.comparisonId !== id) {
        listener.controller.abort();
        listenersRef.current.delete(conversationId);
      }
    }
    if (!id) {
      setComparison(null);
      setLoading(false);
      setDraft((location.state as { compareText?: string } | null)?.compareText ?? "");
      return;
    }
    if (createdRef.current === id) {
      createdRef.current = null;
      return;
    }
    setComparison(null);
    setLoading(true);
    void load(id);
  }, [id, load, location.key]);

  const generating = comparison?.runs.some((run) => run.generating) ?? false;
  useEffect(() => {
    if (!id || !generating) return;
    const timer = window.setInterval(() => void load(id), POLL_MS);
    return () => window.clearInterval(timer);
  }, [id, generating, load]);

  const patchRun = (comparisonId: string, conversationId: string, change: (run: UiRun) => UiRun) => {
    if (!mountedRef.current || shownIdRef.current !== comparisonId) return;
    setComparison((current) => current?.id === comparisonId
      ? { ...current, runs: current.runs.map((run) => run.conversationId === conversationId ? change(run) : run) }
      : current);
  };

  const startRun = async (comparisonId: string, run: UiRun) => {
    if (run.deleted || run.continued || run.generating || listenersRef.current.has(run.conversationId)) return;
    const conversationId = run.conversationId;
    const controller = new AbortController();
    const listener = { comparisonId, controller };
    listenersRef.current.set(conversationId, listener);
    stopRequestedRef.current.delete(conversationId);
    revisionsRef.current.set(conversationId, (revisionsRef.current.get(conversationId) ?? 0) + 1);
    const pending = pendingReply(run);
    patchRun(comparisonId, conversationId, (current) => ({
      ...current, generating: true, stopping: false, requestError: undefined, asks: [],
      messages: [...current.messages.filter((message) => message.role === "user"), pending],
    }));
    const patchReply = (change: (message: UiMessage) => UiMessage) => patchRun(comparisonId, conversationId, (current) => ({
      ...current, messages: current.messages.map((message) => message.id === pending.id ? change(message) : message),
    }));
    let text = "";
    let thinking = "";
    let frame = 0;
    let finished = false;
    let receivedMeta = false;
    const flush = () => {
      frame = 0;
      const chunk = text;
      const thought = thinking;
      text = "";
      thinking = "";
      if (chunk || thought) patchReply((message) => ({
        ...message, text: message.text + chunk,
        thinking: thought ? (message.thinking ?? "") + thought : message.thinking,
        phase: chunk || message.text ? "writing" : "thinking",
      }));
    };
    const finish = (message: Message) => {
      finished = true;
      stopRequestedRef.current.delete(conversationId);
      cancelAnimationFrame(frame);
      frame = 0;
      revisionsRef.current.set(conversationId, (revisionsRef.current.get(conversationId) ?? 0) + 1);
      patchRun(comparisonId, conversationId, (current) => ({
        ...current, generating: false, stopping: false, asks: [], requestError: undefined,
        messages: [...current.messages.filter((item) => item.role === "user"), message],
      }));
      void refreshConversations();
      void loadRecent();
    };
    try {
      await streamChat({ conversationId, regenerate: run.promptMessageId, ...run.choice, comparisonId }, {
        onMeta: (meta) => {
          receivedMeta = true;
          patchReply((message) => ({ ...message, model: meta.model }));
          // A stop clicked while the request was arriving must reach the newly started job too
          if (stopRequestedRef.current.has(conversationId)) void api.post(`/conversations/${conversationId}/stop`).catch((err: Error) => {
            patchRun(comparisonId, conversationId, (current) => ({ ...current, stopping: false, requestError: err.message }));
          });
          void refreshConversations();
        },
        onDelta: (chunk) => { text += chunk; if (!frame) frame = requestAnimationFrame(flush); },
        onThinking: (chunk) => { thinking += chunk; if (!frame) frame = requestAnimationFrame(flush); },
        onStatus: (phase, detail) => patchReply((message) => ({ ...message, phase, searchQuery: detail })),
        onNotice: (notice) => patchReply((message) => ({ ...message, notice })),
        onAsks: (asks) => patchRun(comparisonId, conversationId, (current) => ({
          ...current, asks, messages: current.messages.map((message) => message.id === pending.id ? { ...message, asks } : message),
        })),
        onDone: finish,
        onError: finish,
      }, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        cancelAnimationFrame(frame);
        flush();
        patchRun(comparisonId, conversationId, (current) => ({
          ...current, stopping: false, requestError: (err as Error).message,
          ...(err instanceof ApiError && !receivedMeta ? { generating: false, messages: run.messages } : {}),
        }));
      }
    } finally {
      cancelAnimationFrame(frame);
      if (listenersRef.current.get(conversationId) === listener) listenersRef.current.delete(conversationId);
      revisionsRef.current.set(conversationId, (revisionsRef.current.get(conversationId) ?? 0) + 1);
      if (!controller.signal.aborted) {
        if (!finished) patchReply((message) => ({ ...message, phase: "waiting" }));
        void load(comparisonId);
        void refreshConversations();
      }
    }
  };

  const selected = picks.map((pick) => models.choices.find((item) => sameModel(item, pick)));
  const unread = selected.find((item) => item && uploads.ready.some((file) => !item.reads.includes(file.kind)));
  const filesFailed = uploads.files.some((file) => file.error);
  const canCreate = picks.length >= 2 && picks.length <= 3 && selected.every(Boolean)
    && new Set(picks.map((pick) => `${pick.keyId}:${pick.model}`)).size === picks.length
    && (!!draft.trim() || uploads.ready.length > 0) && !uploads.uploading && !filesFailed && !unread && !creating;

  const create = async () => {
    if (!canCreate || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const saved = await api.post<Comparison>("/comparisons", {
        text: draft.trim(), choices: picks,
        ...(newChatInstructions ? { instructions: newChatInstructions } : {}),
        ...(newChatKnowledge.length ? { knowledgeIds: newChatKnowledge } : {}),
        ...(projectId ? { projectId } : {}),
        ...(uploads.ready.length ? { attachments: uploads.ready.map((file) => file.id) } : {}),
      });
      if (!mountedRef.current || shownIdRef.current !== null) return;
      uploads.release(uploads.take());
      setNewChatInstructions(null);
      setNewChatKnowledge([]);
      setDraft("");
      const next = { ...saved, runs: saved.runs.map(fromSaved) };
      shownIdRef.current = saved.id;
      createdRef.current = saved.id;
      setComparison(next);
      setLoading(false);
      navigate(`/compare/${saved.id}`, { replace: true, state: null });
      // Register every stream before React renders the new route, keeping this transition safe
      for (const run of next.runs) void startRun(saved.id, run);
      void loadRecent();
      void refreshConversations();
    } catch (err) {
      if (mountedRef.current) setError((err as Error).message);
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(false);
    }
  };

  const stop = async (run: UiRun) => {
    if (!id || run.stopping) return;
    stopRequestedRef.current.add(run.conversationId);
    patchRun(id, run.conversationId, (current) => ({ ...current, stopping: true, requestError: undefined }));
    try {
      await api.post(`/conversations/${run.conversationId}/stop`);
      void load(id);
    } catch (err) {
      patchRun(id, run.conversationId, (current) => ({ ...current, stopping: false, requestError: (err as Error).message }));
    }
  };

  const answer = async (run: UiRun, ask: Ask, allow: boolean) => {
    if (!id) return;
    patchRun(id, run.conversationId, (current) => ({
      ...current, asks: current.asks.filter((item) => item.id !== ask.id),
      messages: current.messages.map((message) => ({ ...message, asks: message.asks?.filter((item) => item.id !== ask.id) })),
    }));
    try {
      await api.post(`/conversations/${run.conversationId}/asks/${ask.id}`, { allow });
    } catch (err) {
      patchRun(id, run.conversationId, (current) => ({
        ...current, requestError: (err as Error).message,
        asks: current.asks.some((item) => item.id === ask.id) ? current.asks : [...current.asks, ask],
        messages: current.messages.map((message) => message.streaming
          ? { ...message, asks: message.asks?.some((item) => item.id === ask.id) ? message.asks : [...(message.asks ?? []), ask] }
          : message),
      }));
    }
  };

  const firstRun = comparison?.runs.find((run) => !run.deleted);
  const promptFiles = firstRun?.messages.find((message) => message.id === firstRun.promptMessageId)?.attachments ?? [];
  const addModel = () => {
    const next = models.choices.find((item) => !picks.some((pick) => sameModel(item, pick)));
    if (next && picks.length < 3) setPicks([...picks, { keyId: next.keyId, model: next.model, effort: next.defaultEffort }]);
  };

  const recentList = <>
    {listError ? <Advisory action={<button type="button" className="compare-text-action" onClick={() => void loadRecent()}>{t("Try again")}</button>}>{listError}</Advisory>
      : recent.length ? <div className="compare-recent-list">{(allRecent ? recent : recent.slice(0, 3)).map((item) => (
        <SlideLink key={item.id} to={`/compare/${item.id}`} direction="forward" className="compare-recent-item" aria-current={item.id === id ? "page" : undefined}>
          <span>{item.title}</span><time dateTime={item.updatedAt}>{dateTime(item.updatedAt)}</time><Icon name="chevron-right" size={16} />
        </SlideLink>
      ))}</div> : <p className="compare-muted">{t("Your saved comparisons will appear here")}</p>}
    {recent.length > 3 && <button type="button" className="compare-text-action" onClick={() => setAllRecent(!allRecent)}>{allRecent ? t("Show fewer comparisons") : t("Show all comparisons")}</button>}
  </>;

  return (
    <div className={`compare-page ${id ? "has-answers" : "is-setup"}${id && wideAnswers ? " is-wide" : ""}`}>
      <PageHeader
        title={t("Compare models")}
        subtitle={id ? undefined : project ? t("New comparison in {name}", { name: project.name }) : t("One question, different perspectives")}
        back={{ label: t("Chats"), to: "/chats", mobileOnly: true }}
        trailing={id ? <div className="compare-header-actions">
          <button type="button" className="compare-text-action compare-width-toggle" onClick={() => setWideAnswers(!wideAnswers)}>{wideAnswers ? t("Show sidebar") : t("Widen answers")}</button>
          <SlideLink className="btn-secondary" to="/compare" direction="forward"><Icon name="plus" size={18} />{t("New comparison")}</SlideLink>
        </div> : undefined}
      />
      <div className="compare-body">
        {error && <Advisory action={id ? <button type="button" className="compare-text-action" onClick={() => void load(id)}>{t("Try again")}</button> : undefined}>{error}</Advisory>}
        {loading ? <Spinner label={t("Loading the comparison")} /> : missing ? (
          <EmptyState title={t("This comparison isn't here")}><span>{t("Its chats may have been deleted")}</span></EmptyState>
        ) : !id ? (
          <form className="compare-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
            <section className="compare-form-section">
              <div className="compare-section-label"><h2><label htmlFor="comparison-question">{t("Question for every model")}</label></h2><p>{t("Send the same question and files to every model")}</p></div>
              <div className="compare-question">
                <textarea id="comparison-question" className="compare-prompt-input" rows={5} value={draft} disabled={creating}
                  placeholder={t("What would you like to compare?")} onChange={(event) => setDraft(event.target.value)}
                  onPaste={(event) => { if (!creating && event.clipboardData.files.length) { event.preventDefault(); uploads.add([...event.clipboardData.files]); } }}
                  onDragOver={(event) => { if (!creating && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
                  onDrop={(event) => { if (!creating && event.dataTransfer.files.length) { event.preventDefault(); uploads.add([...event.dataTransfer.files]); } }}
                />
                <fieldset className="compare-files" disabled={creating}><ComposerFiles files={uploads.files} onRemove={uploads.remove} /></fieldset>
                <button type="button" className="compare-text-action compare-attach-action" onClick={() => fileInputRef.current?.click()} disabled={creating}><Icon name="plus" size={18} />{t("Add files or images")}</button>
                <input ref={fileInputRef} type="file" multiple className="visually-hidden" tabIndex={-1} disabled={creating} onChange={(event) => { uploads.add([...event.target.files ?? []]); event.target.value = ""; }} aria-label={t("Add files or images")} />
                {unread && <Advisory>{t("{label} cannot read one of these files, so choose another model or remove the file", { label: unread.label })}</Advisory>}
                {uploads.problem && <Advisory>{uploads.problem}</Advisory>}
              </div>
            </section>
            <section className="compare-form-section compare-model-section">
              <div className="compare-section-label"><h2>{t("Choose your models")}</h2><p>{t("Two or three models")}</p></div>
              <div className="compare-model-fields">
                {modelsLoading ? <Spinner label={t("Loading models")} /> : models.choices.length < 2 && <Advisory>{t("At least two models are needed to compare answers")}</Advisory>}
                <fieldset className="compare-models" disabled={creating} style={{ "--compare-columns": Math.max(2, picks.length) } as CSSProperties}>
                  <legend className="visually-hidden">{t("Models in this comparison")}</legend>
                  {picks.map((pick, index) => (
                    <div className="compare-model" key={index}>
                      <InlineModelPicker label={t("Model {number}", { number: index + 1 })} choices={models.choices.filter((item) => sameModel(item, pick) || !picks.some((chosen) => sameModel(chosen, item)))} value={pick}
                        onChange={(choice) => setPicks(picks.map((current, at) => at === index ? choice : current))} disabled={creating} />
                      {picks.length === 3 && <button type="button" className="compare-text-action compare-remove-model" disabled={creating} onClick={() => setPicks(picks.filter((_, at) => at !== index))} aria-label={t("Remove model {number}", { number: index + 1 })}>{t("Remove")}</button>}
                    </div>
                  ))}
                </fieldset>
                {picks.length === 2 && models.choices.length > 2 && <button type="button" className="compare-text-action compare-add-model" disabled={creating} onClick={addModel}><Icon name="plus" size={18} />{t("Add a third model")}</button>}
              </div>
            </section>
            <div className="compare-submit-row">
              <p className="compare-cost-note">{t("Each model uses your allowance separately")}</p>
              <button type="submit" className="btn-primary" disabled={!canCreate}>{creating ? t("Starting comparison") : uploads.uploading ? t("Adding files") : t("Compare answers")}<Icon name="chevron-right" size={18} /></button>
            </div>
          </form>
        ) : comparison && (
          <>
            <section className="compare-shared-prompt" aria-labelledby="compare-question-title">
              <h2 id="compare-question-title">{t("Question for every model")}</h2>
              {comparison.text && <p>{comparison.text}</p>}
              {promptFiles.length > 0 && <MessageFiles files={promptFiles} url={(fileId) => `/api/files/${fileId}`} />}
            </section>
            <div className="compare-results-scroll" role="region" aria-label={t("Model answers")} tabIndex={0}>
              <div className="compare-results" style={{ "--compare-columns": comparison.runs.length } as CSSProperties}>
              {comparison.runs.map((run, index) => {
                const reply = latestReply(run);
                const offered = models.choices.find((item) => sameModel(item, run.choice));
                const effort = offered?.efforts.find((level) => level.id === run.choice.effort)?.label;
                const canContinue = !run.generating && !run.deleted && !!reply && reply.id > 0;
                return (
                  <section className="compare-result" key={run.conversationId} aria-labelledby={`comparison-model-${index}`}>
                    <header className="compare-result-heading">
                      <h2 id={`comparison-model-${index}`}>{run.label}</h2>
                      <div className="compare-result-info"><span role="status">{statusText(run)}</span>{effort && <span>{t("Thinking: {effort}", { effort })}</span>}</div>
                    </header>
                    <div className="compare-result-body">
                      {run.deleted ? <p className="compare-muted">{t("This answer's chat has been deleted")}</p> : (
                        <>
                          {run.requestError && <Advisory>{run.requestError}</Advisory>}
                          {run.messages.some((message) => message.role === "assistant")
                            ? <Transcript messages={run.messages.filter((message) => message.role === "assistant")} showModel={false} stackTables busy={run.generating} onAnswer={(ask, allow) => void answer(run, ask, allow)} />
                            : <p className="compare-empty-answer">{t("This model has not answered yet")}</p>}
                        </>
                      )}
                    </div>
                    {!run.deleted && (
                      <div className="compare-result-actions">
                        {run.generating ? <button type="button" className="compare-text-action" disabled={run.stopping} onClick={() => void stop(run)}><Icon name="stop" size={16} />{t("Stop")}</button>
                          : !run.continued && <button type="button" className="compare-text-action" onClick={() => void startRun(comparison.id, run)}><Icon name="retry" size={16} />{reply || run.requestError ? t("Try again") : t("Generate answer")}</button>}
                        <button type="button" className="compare-text-action is-accent" disabled={!canContinue} onClick={() => navigate(`/chat/${run.conversationId}`)}>{run.continued ? t("Open chat") : t("Continue this answer")}<Icon name="chevron-right" size={16} /></button>
                      </div>
                    )}
                  </section>
                );
              })}
              </div>
            </div>
          </>
        )}
        {id ? <details className="compare-recent compare-recent-disclosure"><summary>{t("Recent comparisons")}<Icon name="chevron-down" size={16} /></summary>{recentList}</details>
          : <section className="compare-recent" aria-labelledby="compare-recent-title"><h2 id="compare-recent-title">{t("Recent comparisons")}</h2>{recentList}</section>}
      </div>
    </div>
  );
}
