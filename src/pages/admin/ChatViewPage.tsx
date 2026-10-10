import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Advisory, Callout, Spinner } from "../../components/Feedback.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { Transcript } from "../../components/Transcript.tsx";
import { api, type Message } from "../../lib/api.ts";
import { dateTime } from "../../lib/format.ts";
import { declinedSummary, useReviewedLine, type Declined } from "../../lib/declined.ts";
import { useSlideNavigate } from "../../lib/slide.ts";

type Loaded = {
  conversation: { id: string; title: string; email: string; createdAt: string; deletedByUser: boolean; shared: boolean };
  messages: Message[];
  /** Opened from the declined list (?declined=): that reply, with its review state. */
  declined: Declined | null;
};

/** Read-only transcript for admins. Opening it is logged on the server. */
export function ChatViewPage() {
  const { id } = useParams();
  const slideTo = useSlideNavigate();
  const [params] = useSearchParams();
  const declinedId = params.get("declined");
  const [data, setData] = useState<Loaded | null>(null);
  const [review, setReview] = useState<Declined | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrolledTo = useRef<string | null>(null);

  // From the declined list, open the chat on that reply's branch.
  useEffect(() => {
    api.get<Loaded>(`/admin/conversations/${id}${declinedId ? `?at=${declinedId}` : ""}`).then(
      (loaded) => {
        setData(loaded);
        setReview(loaded.declined);
      },
      (err) => setError((err as Error).message),
    );
  }, [id, declinedId]);

  // ...and bring that reply into view, once.
  useEffect(() => {
    if (!data || !declinedId || scrolledTo.current === declinedId) return;
    scrolledTo.current = declinedId;
    requestAnimationFrame(() => document.querySelector(`[data-message-id="${declinedId}"]`)?.scrollIntoView({ block: "center" }));
  }, [data, declinedId]);

  // Flip through versions read-only: the owner's own view doesn't change.
  const showVersion = (messageId: number) =>
    api.get<Loaded>(`/admin/conversations/${id}?via=${messageId}`).then(setData, (err) => setError((err as Error).message));

  const remove = async () => {
    await api.del(`/admin/conversations/${id}`);
    slideTo("/admin/chats", "back", { replace: true });
  };

  return (
    <>
      <PageHeader
        title={data?.conversation.title ?? "Chat"}
        subtitle={data ? `Started by ${data.conversation.email} on ${dateTime(data.conversation.createdAt)}` : undefined}
        back={declinedId ? { label: "Declined", to: "/admin/chats?view=declined" } : { label: "Chats", to: "/admin/chats" }}
        below={review ? <ReviewLine review={review} onChange={setReview} /> : undefined}
      />
      <div className="oy-page-column page-body">
        {error ? (
          <Advisory>{error}</Advisory>
        ) : !data ? (
          <Spinner />
        ) : (
          <>
            {data.conversation.deletedByUser && <Callout icon="eye">The owner deleted this chat. It's hidden from them</Callout>}
            {data.conversation.shared && <Callout icon="eye">The owner shared a read-only link to this chat</Callout>}
            <Transcript messages={data.messages} readOnly onSwitch={(messageId) => void showVersion(messageId)} />
            <DangerRow
              label="Delete this chat for everyone"
              confirmLabel="Delete it for everyone, including its owner? Usage numbers are kept"
              onConfirm={remove}
            />
          </>
        )}
      </div>
    </>
  );
}

/** Under the title when opened from the declined list: what happened, and marking it reviewed. */
function ReviewLine({ review, onChange }: { review: Declined; onChange: (next: Declined) => void }) {
  const reviewedLine = useReviewedLine();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mark = async (reviewed: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ reviewedAt: string | null; reviewer: string | null }>("/admin/declined/review", {
        ids: [review.id],
        reviewed,
      });
      onChange({ ...review, ...res });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Once reviewed, the reply itself says what happened; the line just says who checked it.
  const text = error ?? (review.reviewedAt ? reviewedLine(review) : declinedSummary(review));

  return (
    <div className="inline-confirm" role="group" aria-label="Review">
      {/* Marking it changes the words and the button but not the line's size: the summary holds its
          room under the "reviewed" words, and both buttons share one place. */}
      <span className={`swap${error ? " text-danger" : ""}`}>
        <span className="reserve" aria-hidden="true">
          {declinedSummary(review)}
        </span>
        <span>{text}</span>
      </span>
      <span className="inline-confirm-actions swap">
        <button
          type="button"
          className={`btn-secondary btn-sm${review.reviewedAt ? "" : " reserve"}`}
          disabled={busy}
          onClick={() => void mark(false)}
          aria-hidden={!review.reviewedAt || undefined}
          tabIndex={review.reviewedAt ? undefined : -1}
        >
          Undo
        </button>
        <button
          type="button"
          className={`btn-primary btn-sm${review.reviewedAt ? " reserve" : ""}`}
          disabled={busy}
          onClick={() => void mark(true)}
          aria-hidden={review.reviewedAt ? true : undefined}
          tabIndex={review.reviewedAt ? -1 : undefined}
        >
          Mark reviewed
        </button>
      </span>
    </div>
  );
}
