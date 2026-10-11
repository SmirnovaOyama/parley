import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { OptionList } from "../components/Controls.tsx";
import { DangerRow, InlineConfirm } from "../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, uploadRaw, type KnowledgeBase, type KnowledgeDoc } from "../lib/api.ts";
import { atOrOn, fileSize, formatNumber, plural, shortDate } from "../lib/format.ts";
import { t, tn } from "../lib/i18n.ts";
import { useSession } from "../lib/session.tsx";
import { useSlideNavigate } from "../lib/slide.ts";

/** What a knowledge base holds, as a sentence for its row. */
function baseDesc(k: KnowledgeBase): string {
  const docs = k.docs ? tn(k.docs, "{docs} document, {bytes} in all", "{docs} documents, {bytes} in all", { docs: formatNumber(k.docs), bytes: fileSize(k.bytes) }) : t("No documents yet");
  return k.description ? `${k.description}. ${docs}` : docs;
}

/** Every knowledge base you can use (/knowledge): your own, and the ones admins share with everyone. */
export function KnowledgePage() {
  const slideTo = useSlideNavigate();
  const [bases, setBases] = useState<KnowledgeBase[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ knowledge: KnowledgeBase[] }>("/knowledge").then((r) => setBases(r.knowledge), (err) => setError((err as Error).message));
  }, []);

  const mine = bases?.filter((k) => k.mine) ?? [];
  const shared = bases?.filter((k) => !k.mine) ?? [];
  const row = (k: KnowledgeBase) => (
    <SlideLink key={k.id} className="oy-row" to={`/knowledge/${k.id}`} direction="forward">
      <Icon name="book" size={20} />
      <div className="text">
        <p className="title truncate">
          {k.name}
          {k.mine && k.shared && <span className="tag is-accent">{t("Everyone")}</span>}
        </p>
        <div className="desc">{baseDesc(k)}</div>
      </div>
      <span className="trail tabular">{shortDate(k.updatedAt)}</span>
      <Icon name="chevron-right" size={18} className="chevron" />
    </SlideLink>
  );

  return (
    <>
      <PageHeader
        title={t("Knowledge")}
        subtitle={t("Documents your chats can search")}
        back={{ label: t("Chats"), to: "/chats", mobileOnly: true }}
        trailing={
          <button type="button" className="btn-primary" onClick={() => slideTo("/knowledge/new", "forward")}>
            <Icon name="plus" size={20} />
            {t("New")}
          </button>
        }
      />
      <div className="oy-page-column page-body">
        {error ? (
          <Advisory>{error}</Advisory>
        ) : !bases ? (
          <Spinner />
        ) : bases.length === 0 ? (
          <EmptyState
            doodle="book"
            title={t("No knowledge yet")}
            action={
              <button type="button" className="btn-primary" onClick={() => slideTo("/knowledge/new", "forward")}>
                {t("Make a knowledge base")}
              </button>
            }
          >
            {t("Put handbooks, notes or papers in a knowledge base, connect it to a chat or a project, and the AI looks things up in them")}
          </EmptyState>
        ) : (
          <>
            <div className="oy-group">
              <p className="oy-overline">{t("Yours")}</p>
              {mine.length ? <div className="oy-section">{mine.map(row)}</div> : <p className="group-empty">{t("You haven't made one yet")}</p>}
            </div>
            {shared.length > 0 && (
              <div className="oy-group">
                <p className="oy-overline">{t("Shared by your admins")}</p>
                <div className="oy-section">{shared.map(row)}</div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

type Upload = { key: number; name: string; progress: number; error?: string };

/** One knowledge base (/knowledge/:id): its documents, and adding more. */
export function KnowledgeBasePage() {
  const { id = "" } = useParams();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [missing, setMissing] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropping, setDropping] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const nextKey = useRef(0);

  const load = useCallback(
    () =>
      api.get<{ knowledge: KnowledgeBase; docs: KnowledgeDoc[] }>(`/knowledge/${id}`).then(
        (r) => {
          setKb(r.knowledge);
          setDocs(r.docs);
        },
        () => setMissing(true),
      ),
    [id],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Documents go up one at a time, each with its own line while it does.
  const add = useCallback(
    async (files: File[]) => {
      const queue = files.map((f) => ({ key: nextKey.current++, name: f.name, progress: 0, file: f }));
      setUploads((list) => [...list, ...queue.map(({ file: _file, ...u }) => u)]);
      for (const item of queue) {
        const set = (patch: Partial<Upload>) => setUploads((list) => list.map((u) => (u.key === item.key ? { ...u, ...patch } : u)));
        try {
          const { doc } = await uploadRaw<{ doc: KnowledgeDoc }>(`/knowledge/${id}/docs`, item.file, item.name, (p) => set({ progress: p })).promise;
          setDocs((list) => [doc, ...list]);
          setUploads((list) => list.filter((u) => u.key !== item.key));
        } catch (err) {
          set({ error: (err as Error).message });
        }
      }
      void load();
    },
    [id, load],
  );

  // Files dropped anywhere on the page are added.
  useEffect(() => {
    if (!kb?.canEdit) return;
    let depth = 0;
    const carries = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!carries(e)) return;
      depth++;
      setDropping(true);
    };
    const over = (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!carries(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const drop = (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      depth = 0;
      setDropping(false);
      void add([...e.dataTransfer!.files]);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [kb?.canEdit, add]);

  if (missing) {
    return (
      <>
        <PageHeader title={t("Knowledge")} back={{ label: t("Knowledge"), to: "/knowledge" }} />
        <div className="oy-page-column page-body">
          <EmptyState doodle="book" title={t("This knowledge base isn't here")}>
            {t("It may have been deleted, or it's no longer shared with you")}
          </EmptyState>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={kb?.name ?? t("Knowledge")}
        subtitle={kb ? (kb.mine ? (kb.shared ? t("Shared with everyone on this site") : kb.description || undefined) : t("Shared by {owner}", { owner: kb.owner ?? t("an admin") })) : undefined}
        back={{ label: t("Knowledge"), to: "/knowledge" }}
        trailing={
          kb?.canEdit ? (
            <SlideLink className="btn-ghost icon-button" to={`/knowledge/${id}/settings`} direction="forward" aria-label={t("Knowledge base settings")}>
              <Icon name="gear" size={20} />
            </SlideLink>
          ) : undefined
        }
      />
      <div className="oy-page-column page-body">
        {!kb ? (
          <Spinner />
        ) : (
          <>
            {kb.canEdit && (
              <div className={`doc-drop${dropping ? " is-dropping" : ""}`}>
                {/* While files are dragged over, the words change and the button rests, but both
                    keep their room, so the box and the list under it hold still. */}
                <p className="swap">
                  <span className={dropping ? "reserve" : undefined} aria-hidden={dropping || undefined}>
                    {t("PDFs, Word documents and text files, up to 30 MB each. Drop them here or")}
                  </span>
                  {dropping && <span>{t("Drop the files to add them")}</span>}
                </p>
                <button
                  type="button"
                  className={`btn-secondary btn-sm${dropping ? " is-resting" : ""}`}
                  onClick={() => pickerRef.current?.click()}
                  tabIndex={dropping ? -1 : undefined}
                >
                  <Icon name="plus" size={16} />
                  {t("Add documents")}
                </button>
                <input
                  ref={pickerRef}
                  type="file"
                  multiple
                  hidden
                  accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.js,.ts,.tsx,.jsx,.py,.java,.go,.rs,.rb,.php,.c,.cpp,.h,.cs,.swift,.kt,.sql,.sh,.tex,.rst,.log"
                  onChange={(e) => {
                    void add([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </div>
            )}
            {uploads.length > 0 && (
              <div className="oy-section is-plain">
                {uploads.map((u) => (
                  <div key={u.key} className="oy-row doc-upload">
                    <Icon name="file" size={20} />
                    <div className="text">
                      <p className="title truncate">{u.name}</p>
                      <div className={`desc${u.error ? " text-danger" : ""}`}>{u.error ?? (u.progress < 1 ? t("Adding") : t("Reading it"))}</div>
                      {!u.error && (
                        <span className="allowance-meter">
                          <span style={{ width: `${Math.round(u.progress * 100)}%` }} />
                        </span>
                      )}
                    </div>
                    {u.error && (
                      <button type="button" className="btn-ghost icon-button" aria-label={t("Dismiss")} onClick={() => setUploads((list) => list.filter((x) => x.key !== u.key))}>
                        <Icon name="close" size={16} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="oy-group settings-group">
              <p className="oy-overline">{docs.length ? plural(docs.length, "document", "documents") : t("Documents")}</p>
              {docs.length === 0 ? (
                <p className="group-empty">{kb.canEdit ? t("Nothing here yet. Add the documents chats should search") : t("Nothing here yet")}</p>
              ) : (
                <div className="oy-section is-plain">
                  {docs.map((d) => (
                    <div key={d.id} className={`oy-row${removing === d.id ? " is-confirming" : ""}`}>
                      <Icon name="file" size={20} />
                      <div className="text">
                        <a className="title truncate doc-link" href={`/api/knowledge/${id}/docs/${d.id}`} download>
                          {d.name}
                        </a>
                        <div className="desc">
                          {t("{size}, searchable in {plural}. Added {createdAt}", { size: fileSize(d.size), plural: plural(d.parts, "part", "parts"), createdAt: atOrOn(d.createdAt) })}
                        </div>
                      </div>
                      {kb.canEdit && (
                        <button type="button" className="btn-ghost icon-button" aria-label={t("Remove {name}", { name: d.name })} title={t("Remove")} onClick={() => setRemoving(d.id)}>
                          <Icon name="trash" size={18} />
                        </button>
                      )}
                      {removing === d.id && (
                        <InlineConfirm
                          overlay
                          message={t("Remove {name}?", { name: d.name })}
                          onCancel={() => setRemoving(null)}
                          onConfirm={async () => {
                            await api.del(`/knowledge/${id}/docs/${d.id}`);
                            setRemoving(null);
                            setDocs((list) => list.filter((x) => x.id !== d.id));
                            void load();
                          }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <p className="panel-note page-note">{t("Connect it to a chat in the chat's settings, or to a project, and the AI searches it when it helps")}</p>
          </>
        )}
      </div>
    </>
  );
}

/** A new knowledge base (/knowledge/new), or one's name, description and who can use it (/knowledge/:id/settings). */
export function KnowledgeFormPage() {
  const { id = "new" } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const { user } = useSession();
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [shared, setShared] = useState<"me" | "everyone">("me");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (adding) return;
    api.get<{ knowledge: KnowledgeBase }>(`/knowledge/${id}`).then(
      (r) => {
        setKb(r.knowledge);
        setName(r.knowledge.name);
        setDescription(r.knowledge.description);
        setShared(r.knowledge.shared ? "everyone" : "me");
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const back = adding ? "/knowledge" : `/knowledge/${id}`;
  const admin = user?.role === "admin";

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, ...(admin ? { shared: shared === "everyone" } : {}) };
      const { knowledge } = adding
        ? await api.post<{ knowledge: KnowledgeBase }>("/knowledge", body)
        : await api.patch<{ knowledge: KnowledgeBase }>(`/knowledge/${id}`, body);
      // A new knowledge base opens on from the form; saved settings slide back to it.
      slideTo(`/knowledge/${knowledge.id}`, adding ? "forward" : "back", { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await api.del(`/knowledge/${id}`);
    slideTo("/knowledge", "back", { replace: true });
  };

  return (
    <>
      <PageHeader title={adding ? t("New knowledge base") : t("Knowledge base settings")} back={{ label: adding ? t("Knowledge") : (kb?.name ?? t("Knowledge")), to: back }} />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !adding && !kb ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              <LineField id="kb-name" label={t("Name")} value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              <LineField
                id="kb-description"
                label={t("What's in it (optional)")}
                value={description}
                maxLength={300}
                autoComplete="off"
                onChange={(e) => setDescription(e.target.value)}
              />
              {admin && (
                <OptionList
                  label={t("Who can use it")}
                  value={shared}
                  onChange={setShared}
                  options={[
                    { id: "me", label: t("Only you") },
                    { id: "everyone", label: t("Everyone on this site"), detail: t("People can connect it to their chats and projects, but only admins change it") },
                  ]}
                />
              )}
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!name.trim()}>
                  {adding ? t("Make it") : t("Save")}
                </BusyButton>
                <SlideLink to={back} direction="back" className="btn-secondary">
                  {t("Cancel")}
                </SlideLink>
              </div>
            </form>
            {!adding && (
              <div className="settings-danger">
                <DangerRow
                  label={t("Delete this knowledge base")}
                  confirmLabel={t("Delete it and its documents? Chats and projects stop searching it")}
                  onConfirm={remove}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
