import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { BusyButton } from "../components/BusyButton.tsx";
import { DangerRow, InlineConfirm } from "../components/DangerRow.tsx";
import { Advisory, Spinner } from "../components/Feedback.tsx";
import { LineField } from "../components/LineField.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SlideLink } from "../components/SlideLink.tsx";
import { Icon } from "../icons/Icon.tsx";
import { api, type Connection } from "../lib/api.ts";
import { atOrOn } from "../lib/format.ts";
import { useSlideNavigate } from "../lib/slide.ts";

/** How a sign-in came back (the server's sign-in page returns through /api/mcp/callback). */
const RESULTS: Record<string, string> = {
  connected: "Connected. Its tools work as you now",
  denied: "You didn't allow it on its sign-in page, so it isn't connected",
  failed: "The sign-in didn't finish. Try again",
};

/** Where you stand with a server, as a sentence. */
function statusText(c: Connection): string {
  if (c.status === "connected") return `Connected ${atOrOn(c.connectedAt!)}${c.usedAt ? `, last used ${atOrOn(c.usedAt)}` : ""}`;
  if (c.mode === "oauth") return c.status === "expired" ? "Your sign-in stopped working. Sign in again" : `Not connected. You'll sign in at ${c.host}`;
  return c.status === "expired" ? "Your token stopped working. Add a new one" : "Not connected. Add a token of yours";
}

/**
 * Account › Connected services (/account/connections): the MCP servers whose tools act with your
 * own account, and connecting each. One you sign in to has its button here, which goes to its
 * sign-in page and back; one that takes a token opens a page for it.
 */
export function ConnectionsPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Back from a sign-in page: how it went, read once from the address, and said until that row changes.
  const [result, setResult] = useState(() => {
    const q = new URLSearchParams(location.search);
    return { server: Number(q.get("server")) || null, result: q.get("result") };
  });
  const [busy, setBusy] = useState<number | null>(null);
  const [leaving, setLeaving] = useState<number | null>(null);

  useEffect(() => {
    if (location.search) navigate(location.pathname, { replace: true });
    api.get<{ connections: Connection[] }>("/mcp/connections").then((r) => setConnections(r.connections), (err) => setError((err as Error).message));
  }, []);

  const replace = (next: Connection) => {
    setConnections((list) => list?.map((c) => (c.id === next.id ? next : c)) ?? null);
    if (result.server === next.id) setResult({ server: null, result: null });
  };

  const signIn = async (c: Connection) => {
    setBusy(c.id);
    setError(null);
    try {
      const { url } = await api.post<{ url: string }>(`/mcp/connections/${c.id}/sign-in`);
      // The whole page goes there and comes back, as signing in anywhere does.
      window.location.assign(url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Connected services" subtitle="Tools that act with your own account" back={{ label: "Account", to: "/account" }} />
      <div className="oy-page-column page-body">
        {result.result === "expired" && <Advisory>That sign-in ran out, or was started somewhere else. Try again</Advisory>}
        {error && <Advisory>{error}</Advisory>}
        {!connections ? (
          !error && <Spinner />
        ) : connections.length === 0 ? (
          <p className="group-empty">None of this site's tools need your own account</p>
        ) : (
          <>
            <p className="group-intro">
              These services' tools act as you, with your own account there, so they can do only what you could. Until you connect one,
              chats can't use its tools
            </p>
            <div className="oy-section">
              {connections.map((c) => {
                const said = result.server === c.id && result.result ? RESULTS[result.result] : null;
                const desc = <div className={`desc${said && result.result !== "connected" ? " text-warning" : ""}`}>{said ?? statusText(c)}</div>;
                if (c.mode === "token") {
                  return (
                    <SlideLink key={c.id} className="oy-row" to={`/account/connections/${c.id}`} direction="forward">
                      <Icon name="plug" size={20} />
                      <div className="text">
                        <p className="title">{c.name}</p>
                        {desc}
                      </div>
                      <Icon name="chevron-right" size={18} className="chevron" />
                    </SlideLink>
                  );
                }
                return (
                  <div key={c.id} className={`oy-row${leaving === c.id ? " is-confirming" : ""}`}>
                    <Icon name="plug" size={20} />
                    <div className="text">
                      <p className="title">{c.name}</p>
                      {desc}
                    </div>
                    {c.status === "connected" ? (
                      <button type="button" className="btn-secondary btn-sm" onClick={() => setLeaving(c.id)}>
                        Disconnect
                      </button>
                    ) : (
                      <BusyButton type="button" className="btn-tonal btn-sm" busy={busy === c.id} disabled={busy !== null} onClick={() => void signIn(c)}>
                        {c.status === "expired" ? "Sign in again" : "Connect"}
                      </BusyButton>
                    )}
                    {leaving === c.id && (
                      <InlineConfirm
                        overlay
                        message={`Disconnect ${c.name}?`}
                        action="Disconnect"
                        onCancel={() => setLeaving(null)}
                        onConfirm={async () => {
                          try {
                            const r = await api.del<{ connection: Connection | null }>(`/mcp/connections/${c.id}`);
                            if (r.connection) replace(r.connection);
                          } catch (err) {
                            setError((err as Error).message);
                          }
                          setLeaving(null);
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}

/** Your token for a server that takes one (/account/connections/:id): adding or replacing it, and disconnecting. */
export function ConnectionTokenPage() {
  const { id } = useParams();
  const slideTo = useSlideNavigate();
  const [connection, setConnection] = useState<Connection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ connections: Connection[] }>("/mcp/connections").then(
      (r) => {
        const found = r.connections.find((c) => String(c.id) === id && c.mode === "token");
        if (found) setConnection(found);
        else setLoadError("This service isn't here any more");
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.put(`/mcp/connections/${id}`, { token });
      slideTo("/account/connections", "back");
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const connected = connection?.status === "connected";
  return (
    <>
      <PageHeader
        title={connection?.name ?? "Connected service"}
        subtitle={connection ? statusText(connection) : undefined}
        back={{ label: "Connected services", to: "/account/connections" }}
      />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !connection ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              {connection.hint && <p className="group-intro">{connection.hint}</p>}
              <LineField
                id="connection-token"
                label={connected ? "A new token (yours is kept until you save one)" : "Your token"}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                hint="Sent as a bearer token, or write a header like X-Api-Key: abc123. It's tried with the service first, then kept encrypted"
              />
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!token.trim()}>
                  {connected ? "Save" : "Connect"}
                </BusyButton>
                <SlideLink to="/account/connections" direction="back" className="btn-secondary">
                  Cancel
                </SlideLink>
              </div>
            </form>
            {connected && (
              <div className="settings-danger">
                <DangerRow
                  label="Disconnect"
                  confirmLabel={`Disconnect ${connection.name}? Parley forgets your token, which still works at ${connection.host} until you withdraw it there`}
                  action="Disconnect"
                  onConfirm={async () => {
                    await api.del(`/mcp/connections/${id}`);
                    slideTo("/account/connections", "back", { replace: true });
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
