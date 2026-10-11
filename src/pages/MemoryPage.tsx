import { useEffect, useState, type FormEvent } from "react";
import { BusyButton } from "../components/BusyButton.tsx";
import { Switch } from "../components/Controls.tsx";
import { DangerRow, InlineConfirm } from "../components/DangerRow.tsx";
import { Advisory, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api } from "../lib/api.ts";
import { atOrOn, formatNumber } from "../lib/format.ts";
import { t, tn, tx } from "../lib/i18n.ts";

export type MemoryState = {
  site: boolean;
  on: boolean;
  personOff: boolean;
  memories: { id: number; text: string; createdAt: string; chat: { id: string; title: string } | null }[];
};

/** What the AI remembers about you (/settings/memory): on or off, each note, and adding or forgetting them. */
export function MemoryPage() {
  const [state, setState] = useState<MemoryState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: number; text: string } | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);

  useEffect(() => {
    api.get<MemoryState>("/memory").then(setState, (err) => setError((err as Error).message));
  }, []);

  const run = async (call: () => Promise<MemoryState>) => {
    setError(null);
    try {
      setState(await call());
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!adding.trim()) return;
    setBusy(true);
    if (await run(() => api.post<MemoryState>("/memory", { text: adding }))) setAdding("");
    setBusy(false);
  };

  return (
    <>
      <PageHeader title={t("Memory")} subtitle={t("What the AI keeps about you between chats")} back={{ label: t("Settings"), to: "/settings" }} />
      <div className="oy-page-column page-body">
        {!state ? (
          error ? <Advisory>{error}</Advisory> : <Spinner />
        ) : (
          <>
            <div className="oy-section">
              <div className="oy-row">
                <Icon name="note" size={20} />
                <div className="text">
                  <label className="title" htmlFor="memory-on">
                    {t("Let the AI remember things about you")}
                  </label>
                  {!state.site ? (
                    <div className="desc">{t("Your admins have turned memory off for this site")}</div>
                  ) : (
                    // Both lines sit in one place and the row keeps the taller one's size, so flipping
                    // the switch changes the words, never the spacing.
                    <div className="desc swap">
                      <span className={state.on ? undefined : "reserve"} aria-hidden={!state.on || undefined}>
                        {t("New chats start with these notes, and the AI adds to them when you tell it something worth keeping")}
                      </span>
                      <span className={state.on ? "reserve" : undefined} aria-hidden={state.on || undefined}>
                        {t("New chats start without them, and nothing new is saved. Your notes stay until you delete them")}
                      </span>
                    </div>
                  )}
                </div>
                <Switch
                  id="memory-on"
                  checked={state.site && !state.personOff}
                  disabled={!state.site}
                  onChange={(on) => void run(() => api.put<MemoryState>("/memory/settings", { on }))}
                />
              </div>
            </div>

            <form className="form-page memory-add" onSubmit={add}>
              <LineField
                id="memory-new"
                label={t("Add something for it to remember")}
                value={adding}
                maxLength={500}
                autoComplete="off"
                onChange={(e) => setAdding(e.target.value)}
                hint={t("Like “I teach chemistry to 14-year-olds” or “Answer in British English”")}
              />
              {/* Always there (resting while the field is empty), so typing never pushes the notes down. */}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!adding.trim()}>
                  {t("Remember it")}
                </BusyButton>
              </div>
            </form>

            {error && <Advisory>{error}</Advisory>}

            <div className="oy-group settings-group">
              <p className="oy-overline">
                {state.memories.length ? tn(state.memories.length, "{count} note", "{count} notes", { count: formatNumber(state.memories.length) }) : t("Notes")}
              </p>
              {state.memories.length === 0 ? (
                <p className="group-empty">{t("Nothing yet. Tell the AI something about yourself in a chat, or add it here")}</p>
              ) : (
                <div className="oy-section is-plain">
                  {state.memories.map((m) =>
                    editing?.id === m.id ? (
                      <form
                        key={m.id}
                        className="memory-edit"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (await run(() => api.patch<MemoryState>(`/memory/${m.id}`, { text: editing.text }))) setEditing(null);
                        }}
                      >
                        <LineField
                          id={`memory-${m.id}`}
                          label={t("Note")}
                          value={editing.text}
                          maxLength={500}
                          autoFocus
                          onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        />
                        <div className="form-page-actions">
                          <button type="submit" className="btn-primary btn-sm" disabled={!editing.text.trim()}>
                            {t("Save")}
                          </button>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => setEditing(null)}>
                            {t("Cancel")}
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div key={m.id} className={`oy-row memory-row${removing === m.id ? " is-confirming" : ""}`}>
                        <div className="text">
                          <p className="title">{m.text}</p>
                          <div className="desc">
                            {m.chat
                              ? tx("Learnt in <a>{title}</a> {createdAt}", {
                                  a: () => (
                                    <SlideLink to={`/chat/${m.chat!.id}`} direction="forward">
                                      {m.chat!.title}
                                    </SlideLink>
                                  ),
                                  createdAt: atOrOn(m.createdAt),
                                })
                              : t("Added {createdAt}", { createdAt: atOrOn(m.createdAt) })}
                          </div>
                        </div>
                        <button type="button" className="btn-ghost icon-button" aria-label={t("Edit this note")} title={t("Edit")} onClick={() => setEditing({ id: m.id, text: m.text })}>
                          <Icon name="pencil" size={16} />
                        </button>
                        <button type="button" className="btn-ghost icon-button" aria-label={t("Forget this note")} title={t("Forget")} onClick={() => setRemoving(m.id)}>
                          <Icon name="trash" size={16} />
                        </button>
                        {removing === m.id && (
                          <InlineConfirm
                            overlay
                            message={t("Forget this?")}
                            onCancel={() => setRemoving(null)}
                            onConfirm={async () => {
                              await run(() => api.del<MemoryState>(`/memory/${m.id}`));
                              setRemoving(null);
                            }}
                          />
                        )}
                      </div>
                    ),
                  )}
                </div>
              )}
            </div>

            {state.memories.length > 0 && (
              <div className="settings-danger">
                <DangerRow
                  label={t("Forget everything")}
                  confirmLabel={t("Forget every note? Chats already started keep what they were told")}
                  onConfirm={async () => {
                    await run(() => api.del<MemoryState>("/memory"));
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
