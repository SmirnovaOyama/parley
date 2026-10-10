import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { EmptyState, Spinner } from "../components/Feedback.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { api, ApiError, type Message } from "../lib/api.ts";
import { APP_NAME } from "../lib/brand.ts";
import { longDate } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";

type Shared = { title: string; sharedAt: string; messages: Message[] };

/** A shared chat, read-only, at /share/:token. Depending on the site, no account is needed. */
export function SharePage() {
  const { token } = useParams();
  const { user, loading } = useSession();
  const [data, setData] = useState<Shared | null>(null);
  const [error, setError] = useState<{ message: string; signIn: boolean } | null>(null);

  // Links are private by nature: ask search engines not to list the page.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.append(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    if (loading) return;
    setError(null);
    api.get<Shared>(`/shared/${token}`).then(
      (shared) => {
        setData(shared);
        document.title = `${shared.title} on ${APP_NAME}`;
      },
      (err) => setError({ message: (err as Error).message, signIn: err instanceof ApiError && err.status === 401 }),
    );
    return () => {
      document.title = APP_NAME;
    };
  }, [token, loading, user]);

  return (
    <div className="share-page">
      <PageHeader title={data?.title ?? "Shared chat"} subtitle={data ? `Shared on ${longDate(data.sharedAt)}` : undefined} />
      <div className="oy-page-column page-body">
        {error ? (
          error.signIn ? (
            <EmptyState
              doodle="chat"
              title="Sign in to read this chat"
              action={
                <Link className="btn-primary" to={`/login?next=${encodeURIComponent(`/share/${token}`)}`}>
                  Sign in
                </Link>
              }
            >
              It was shared with people who have an account on {APP_NAME}
            </EmptyState>
          ) : (
            <EmptyState doodle="link" title="This link doesn't open">
              {error.message}
            </EmptyState>
          )
        ) : !data ? (
          <Spinner label="Loading the chat" />
        ) : (
          <>
            <Transcript messages={data.messages} fileUrl={(fileId) => `/api/shared/${token}/files/${fileId}`} />
            <div className="share-foot">
              <p className="text-muted">A read-only copy, as the chat was when it was shared</p>
              <Link className="btn-secondary" to="/chat">
                {user ? "Go to your chats" : "Start your own chat"}
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
