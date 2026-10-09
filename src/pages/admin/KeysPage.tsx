import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { Advisory, EmptyState, Spinner } from "../../components/Feedback.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { plural } from "../../lib/format.ts";

export type ModelOption = {
  id: string;
  label: string;
  defaultEffort: string;
  /** Thinking levels this model accepts. */
  efforts: { id: string; label: string }[];
  /** Left unticked on a new key (the most expensive models). */
  offByDefault: boolean;
  /** Dollars per million tokens. */
  price: { input: number; output: number };
};

export type ProviderInfo = {
  id: "anthropic" | "deepseek";
  label: string;
  models: ModelOption[];
  defaultModel: string;
};

export type ApiKey = {
  id: number;
  label: string;
  provider: ProviderInfo["id"];
  model: string;
  modelLabel: string;
  /** The models people may pick with this key. */
  models: string[];
  effort: string;
  effortLabel: string;
  last4: string;
  isDefault: boolean;
  shared: boolean;
  fallbackKeyId: number | null;
  fallbackLabel: string | null;
  fallbackModelLabel: string | null;
  webSearch: boolean;
  codeExecution: boolean;
  boundUsers: number;
  grantedUsers: number;
};

export function KeysPage() {
  const navigate = useNavigate();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ keys: ApiKey[] }>("/admin/keys").then(
      (r) => setKeys(r.keys),
      (err) => setError((err as Error).message),
    );
  }, []);

  if (error) return <Advisory>{error}</Advisory>;
  if (!keys) return <Spinner />;

  if (keys.length === 0) {
    return (
      <EmptyState
        title="No API keys yet"
        action={
          <button type="button" className="btn-primary" onClick={() => navigate("/admin/keys/new")}>
            Add a key
          </button>
        }
      >
        Add a Claude or DeepSeek key so people can start chatting
      </EmptyState>
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <p className="text-muted">{plural(keys.length, "key", "keys")}</p>
        <button type="button" className="btn-ghost is-accent" onClick={() => navigate("/admin/keys/new")}>
          <Icon name="plus" size={16} />
          Add a key
        </button>
      </div>
      <div className="oy-section is-plain">
        {keys.map((k) => (
          <button key={k.id} type="button" className="oy-row" onClick={() => navigate(`/admin/keys/${k.id}`)}>
            <div className="text">
              <p className="title">
                {k.label}
                {k.isDefault && <span className="tag is-accent">Default</span>}
                {k.webSearch && <span className="tag">Web search</span>}
                {k.codeExecution && <span className="tag">Makes files</span>}
              </p>
              <div className="desc">
                Offers {plural(k.models.length, "model", "models")} and starts new chats on {k.modelLabel} with thinking set to {k.effortLabel.toLowerCase()}. The key ends in {k.last4}
              </div>
              <div className="desc">
                {k.shared ? "Everyone can pick it" : `${plural(k.grantedUsers, "person", "people")} can pick it`}
                {k.fallbackLabel ? `. If it fails, ${k.fallbackLabel} answers instead` : ""}
              </div>
            </div>
            <Icon name="chevron-right" size={18} className="chevron" />
          </button>
        ))}
      </div>
    </>
  );
}
