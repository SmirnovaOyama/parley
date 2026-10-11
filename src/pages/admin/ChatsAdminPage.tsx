import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { Segmented } from "../../components/Controls.tsx";
import { Advisory, Callout, EmptyState, Spinner } from "../../components/Feedback.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { plural, shortDate } from "../../lib/format.ts";
import { declinedSummary, useReviewedLine, type Declined } from "../../lib/declined.ts";
import { t } from "../../lib/i18n.ts";
import { useSlideNavigate } from "../../lib/slide.ts";

type Row = { id: string; title: string; email: string; messageCount: number; updatedAt: string; deletedByUser: boolean; shared: boolean };

type View = "all" | "declined";

export function ChatsAdminPage() {
  const [params, setParams] = useSearchParams();
  const userId = params.get("user") ?? "";
  const view: View = params.get("view") === "declined" ? "declined" : "all";
  const [toReview, setToReview] = useState<number | null>(null);

  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <div className="admin-filters">
        <Segmented<View>
          aria-label={t("Which chats")}
          value={view}
          onChange={(v) => setFilter("view", v === "declined" ? "declined" : "")}
          options={[
            { id: "all", label: t("All chats") },
            {
              id: "declined",
              label: (
                <>
                  {t("Declined")}
                  {toReview ? <span className="seg-count tabular">{toReview}</span> : null}
                </>
              ),
            },
          ]}
        />
      </div>
      {view === "all" ? (
        <AllChats userId={userId} params={params} setFilter={setFilter} onToReview={setToReview} />
      ) : (
        <DeclinedList userId={userId} onToReview={setToReview} />
      )}
    </>
  );
}

type AllProps = {
  userId: string;
  params: URLSearchParams;
  setFilter: (key: string, value: string) => void;
  onToReview: (n: number) => void;
};

function AllChats({ userId, params, setFilter, onToReview }: AllProps) {
  const slideTo = useSlideNavigate();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [rows, setRows] = useState<Row[] | null>(null);

  // Search as the admin types, a moment after they stop.
  useEffect(() => {
    const q = query.trim();
    const timer = setTimeout(() => {
      const search = new URLSearchParams();
      if (userId) search.set("userId", userId);
      if (q) search.set("q", q);
      api.get<{ conversations: Row[]; declinedToReview: number }>(`/admin/conversations?${search}`).then(
        (r) => {
          setRows(r.conversations);
          onToReview(r.declinedToReview);
        },
        () => setRows([]),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [userId, query, onToReview]);

  return (
    <>
      <div className="admin-filters">
        <div className="search-field">
          <Icon name="search" size={18} />
          <input
            className="input-base"
            type="search"
            placeholder={t("Search by person, title or message")}
            aria-label={t("Search chats")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setFilter("q", e.target.value.trim());
            }}
          />
        </div>
      </div>

      <Callout icon="eye">{t("Opening a chat is recorded in the activity log under Settings")}</Callout>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState doodle="chat" title={query || userId ? t("No chats match") : t("No chats yet")}>
          {query || userId ? t("Try another search or person") : t("Chats show up here once people start talking")}
        </EmptyState>
      ) : (
        <div className="oy-section">
          {rows.map((r) => (
            <button key={r.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/chats/${r.id}`, "forward")}>
              <Icon name="chat" size={20} />
              <div className="text">
                <p className="title truncate">
                  {r.title}
                  {r.shared && <span className="tag">{t("Shared")}</span>}
                  {r.deletedByUser && <span className="tag">{t("Deleted by owner")}</span>}
                </p>
                <div className="desc truncate">
                  {t("{plural} with {email}", { plural: plural(r.messageCount, "message", "messages"), email: r.email })}
                </div>
              </div>
              <span className="trail tabular">{shortDate(r.updatedAt)}</span>
              <Icon name="chevron-right" size={18} className="chevron" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Messages the AI declined, waiting ones first, so admins can check them without reading every chat. */
function DeclinedList({ userId, onToReview }: { userId: string; onToReview: (n: number) => void }) {
  const slideTo = useSlideNavigate();
  const reviewedLine = useReviewedLine();
  const [rows, setRows] = useState<Declined[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRows(null);
    api.get<{ declined: Declined[] }>(`/admin/declined${userId ? `?userId=${userId}` : ""}`).then(
      (r) => setRows(r.declined),
      (err) => setError((err as Error).message),
    );
  }, [userId]);

  const waiting = rows?.filter((r) => !r.reviewedAt) ?? [];
  const reviewed = rows?.filter((r) => r.reviewedAt) ?? [];

  useEffect(() => {
    if (rows) onToReview(rows.filter((r) => !r.reviewedAt).length);
  }, [rows, onToReview]);

  const markAll = async () => {
    setBusy(true);
    setError(null);
    try {
      const ids = new Set(waiting.map((r) => r.id));
      const res = await api.post<{ reviewedAt: string; reviewer: string }>("/admin/declined/review", { ids: [...ids], reviewed: true });
      setRows((list) => list?.map((r) => (ids.has(r.id) ? { ...r, ...res } : r)) ?? list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (r: Declined) => (
    <button key={r.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/chats/${r.conversationId}?declined=${r.id}`, "forward")}>
      <Icon name={r.reviewedAt ? "check" : "alert"} size={20} />
      <div className="text">
        <p className="title truncate">
          {r.prompt.trim() || t("Empty message")}
          {r.deletedByUser && <span className="tag">{t("Deleted by owner")}</span>}
        </p>
        <div className="desc truncate">
          {t("{email} asked. {declinedSummary}", { email: r.email, declinedSummary: declinedSummary(r) })}
        </div>
        {r.reviewedAt && <div className="desc truncate">{reviewedLine(r)}</div>}
      </div>
      <span className="trail tabular">{shortDate(r.createdAt)}</span>
      <Icon name="chevron-right" size={18} className="chevron" />
    </button>
  );

  return (
    <>
      <Callout icon="eye">{t("Looking at this list is recorded in the activity log, like opening a chat")}</Callout>

      {error && <Advisory>{error}</Advisory>}
      {!rows ? (
        error ? null : <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState doodle="chat" title={t("Nothing declined")}>
          {t("Messages the AI refuses to answer show up here")}
        </EmptyState>
      ) : (
        <>
          <div className="oy-group">
            <div className="group-head">
              <p className="oy-overline">{t("To review")}</p>
              {/* Rests once all are done, so the heading keeps its height. */}
              <button
                type="button"
                className={`btn-ghost is-accent${waiting.length ? "" : " is-resting"}`}
                onClick={markAll}
                disabled={busy || !waiting.length}
                tabIndex={waiting.length ? undefined : -1}
              >
                <Icon name="check" size={16} />
                {t("Mark all reviewed")}
              </button>
            </div>
            {waiting.length === 0 ? <p className="group-empty">{t("All caught up")}</p> : <div className="oy-section">{waiting.map(row)}</div>}
          </div>
          {reviewed.length > 0 && (
            <div className="oy-group">
              <p className="oy-overline">{t("Reviewed")}</p>
              <div className="oy-section">{reviewed.map(row)}</div>
            </div>
          )}
        </>
      )}
    </>
  );
}
