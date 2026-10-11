import { useEffect, useState } from "react";
import { Advisory, EmptyState, Spinner } from "../../components/Feedback.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { formatNumber, plural } from "../../lib/format.ts";
import { t, tn } from "../../lib/i18n.ts";
import { useSlideNavigate } from "../../lib/slide.ts";

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
  id: string;
  label: string;
  /** A short line under its name where admins pick a provider. */
  detail?: string;
  /** What its models can do: "Images", "PDFs", "Web search". */
  features: string[];
  /** Its models come from each key: an address and the model names the admin types. */
  custom: boolean;
  models: ModelOption[];
  defaultModel: string;
};

/** A service that speaks OpenAI's chat format, offered as a starting point for its address. */
export type Service = { id: string; label: string; baseUrl: string; example: string };

/** Another service's key: where it is, the models it serves (dollars per million tokens), and whether they see pictures. */
export type Endpoint = { baseUrl: string; models: { id: string; input: number | null; output: number | null }[]; images: boolean };

export type ApiKey = {
  id: number;
  label: string;
  provider: ProviderInfo["id"];
  /** The provider, or for another service the service: "OpenRouter", "llm.example.com". */
  providerLabel: string;
  endpoint: Endpoint | null;
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
  const slideTo = useSlideNavigate();
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
        title={t("No API keys yet")}
        action={
          <button type="button" className="btn-primary" onClick={() => slideTo("/admin/keys/new", "forward")}>
            {t("Add a key")}
          </button>
        }
      >
        {t("Add a key for Claude, OpenAI, Gemini, Grok, DeepSeek or another service so people can start chatting")}
      </EmptyState>
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <p className="text-muted">{plural(keys.length, "key", "keys")}</p>
        <button type="button" className="btn-ghost is-accent" onClick={() => slideTo("/admin/keys/new", "forward")}>
          <Icon name="plus" size={16} />
          {t("Add a key")}
        </button>
      </div>
      <div className="oy-section is-plain">
        {keys.map((k) => (
          <button key={k.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/keys/${k.id}`, "forward")}>
            <div className="text">
              <p className="title">
                {k.label}
                {k.isDefault && <span className="tag is-accent">{t("Default")}</span>}
                {k.webSearch && <span className="tag">{t("Web search")}</span>}
                {k.codeExecution && <span className="tag">{t("Makes files")}</span>}
              </p>
              <div className="desc">
                {k.endpoint
                  ? tn(k.models.length, "Offers {count} model on {providerLabel} and starts new chats on {modelLabel}", "Offers {count} models on {providerLabel} and starts new chats on {modelLabel}", {
                      count: formatNumber(k.models.length),
                      providerLabel: k.providerLabel,
                      modelLabel: k.modelLabel,
                    })
                  : tn(k.models.length, "Offers {count} model and starts new chats on {modelLabel} with thinking set to {effortLabel}", "Offers {count} models and starts new chats on {modelLabel} with thinking set to {effortLabel}", {
                      count: formatNumber(k.models.length),
                      modelLabel: k.modelLabel,
                      effortLabel: k.effortLabel.toLowerCase(),
                    })}
                {k.last4 ? t(". The key ends in {last4}", { last4: k.last4 }) : t(". It has no API key")}
              </div>
              <div className="desc">
                {k.shared ? t("Everyone can pick it") : tn(k.grantedUsers, "{grantedUsers} person can pick it", "{grantedUsers} people can pick it", { grantedUsers: formatNumber(k.grantedUsers) })}
                {k.fallbackLabel ? t(". If it fails, {fallbackLabel} answers instead", { fallbackLabel: k.fallbackLabel }) : ""}
              </div>
            </div>
            <Icon name="chevron-right" size={18} className="chevron" />
          </button>
        ))}
      </div>
    </>
  );
}
