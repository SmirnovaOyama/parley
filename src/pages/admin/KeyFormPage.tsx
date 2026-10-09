import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { api } from "../../lib/api.ts";
import type { ApiKey, ProviderInfo } from "./KeysPage.tsx";

/** Add a key (/admin/keys/new) or edit one (/admin/keys/:id) on its own page. */
export function KeyFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const navigate = useNavigate();

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [existing, setExisting] = useState<ApiKey | null>(null);
  const [label, setLabel] = useState("");
  const [providerId, setProviderId] = useState<ProviderInfo["id"]>("anthropic");
  const [model, setModel] = useState("");
  // Every model of the provider but the most expensive, unless the admin ticks otherwise.
  const [models, setModels] = useState<string[]>([]);
  const [effort, setEffort] = useState("");
  const [secret, setSecret] = useState("");
  const [isDefault, setIsDefault] = useState(false);
  const [webSearch, setWebSearch] = useState(false);
  const [codeExecution, setCodeExecution] = useState(false);
  const [shared, setShared] = useState<"everyone" | "chosen">("everyone");
  const [fallback, setFallback] = useState("none");
  const [otherKeys, setOtherKeys] = useState<ApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ providers: ProviderInfo[] }>("/admin/catalog"),
      api.get<{ keys: ApiKey[] }>("/admin/keys"),
    ]).then(
      ([catalog, list]) => {
        setProviders(catalog.providers);
        setOtherKeys(list.keys.filter((k) => String(k.id) !== id));
        if (adding) {
          const p = catalog.providers[0];
          setProviderId(p.id);
          setModel(p.defaultModel);
          setModels(p.models.filter((m) => !m.offByDefault).map((m) => m.id));
          setEffort(p.models.find((m) => m.id === p.defaultModel)?.defaultEffort ?? "");
          setIsDefault(list.keys.length === 0);
          return;
        }
        const key = list.keys.find((k) => String(k.id) === id);
        if (!key) {
          setLoadError("This key doesn't exist any more");
          return;
        }
        setExisting(key);
        setLabel(key.label);
        setProviderId(key.provider);
        setModel(key.model);
        setModels(key.models);
        setEffort(key.effort);
        setIsDefault(key.isDefault);
        setWebSearch(key.webSearch);
        setCodeExecution(key.codeExecution);
        setShared(key.shared ? "everyone" : "chosen");
        setFallback(key.fallbackKeyId == null ? "none" : String(key.fallbackKeyId));
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const provider = providers?.find((p) => p.id === providerId);
  const modelInfo = provider?.models.find((m) => m.id === model);

  const pickModel = (nextModel: string, p = provider) => {
    const next = p?.models.find((m) => m.id === nextModel);
    setModel(nextModel);
    // Keep the thinking level when the new model supports it; otherwise use its default.
    if (next) setEffort((current) => (next.efforts.some((e) => e.id === current) ? current : next.defaultEffort));
  };

  const switchProvider = (next: ProviderInfo["id"]) => {
    const p = providers?.find((x) => x.id === next);
    setProviderId(next);
    if (p) {
      const m = p.models.find((x) => x.id === p.defaultModel);
      setModel(p.defaultModel);
      setModels(p.models.filter((x) => !x.offByDefault).map((x) => x.id));
      if (m) setEffort(m.defaultEffort);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (adding) {
        await api.post("/admin/keys", {
          label,
          provider: providerId,
          model,
          effort,
          apiKey: secret,
          isDefault,
          shared: isDefault || shared === "everyone",
          fallbackKeyId: fallback === "none" ? null : Number(fallback),
          models,
          webSearch: providerId === "anthropic" && webSearch,
          codeExecution: providerId === "anthropic" && codeExecution,
        });
      } else if (existing) {
        await api.patch(`/admin/keys/${existing.id}`, {
          label,
          model,
          effort,
          ...(secret ? { apiKey: secret } : {}),
          ...(isDefault && !existing.isDefault ? { isDefault: true } : {}),
          shared: isDefault || shared === "everyone",
          fallbackKeyId: fallback === "none" ? null : Number(fallback),
          models,
          webSearch: providerId === "anthropic" && webSearch,
          codeExecution: providerId === "anthropic" && codeExecution,
        });
      }
      navigate("/admin/keys");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const title = adding ? "New key" : existing?.label ?? "Key";

  return (
    <div className="admin-page">
      <PageHeader title={title} back={{ label: "API keys", to: "/admin/keys" }} />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !providers || !provider ? (
          <Spinner />
        ) : (
          <form className="form-page" onSubmit={save}>
            <LineField id="key-label" label="Name" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} autoComplete="off" />

            {adding && (
              <OptionList
                label="Provider"
                value={providerId}
                onChange={switchProvider}
                options={providers.map((p) => ({ id: p.id, label: p.label }))}
              />
            )}

            <CheckList
              label="Models people can pick"
              values={models}
              onChange={(next) => {
                if (next.length === 0) return;
                setModels(next);
                // Unticking the model chats start on moves the start to the first one still ticked.
                if (!next.includes(model)) pickModel(provider.models.find((m) => next.includes(m.id))!.id);
              }}
              options={provider.models.map((m) => ({
                id: m.id,
                label: m.label,
                detail: `$${m.price.input} in, $${m.price.output} out per million tokens${m.offByDefault ? ". Off unless you tick it" : ""}`,
              }))}
            />

            <OptionList
              label="New chats start on"
              value={model}
              onChange={(m) => pickModel(m)}
              options={provider.models.filter((m) => models.includes(m.id)).map((m) => ({ id: m.id, label: m.label }))}
            />

            {modelInfo && (
              <OptionList label="Thinking they start with" value={effort} onChange={setEffort} options={modelInfo.efforts} />
            )}
            <p className="panel-note">People can change the model and thinking for each chat, among the models ticked above</p>

            <div className="oy-section is-plain">
              <div className="oy-row">
                <div className="text">
                  <label className="title" htmlFor="key-default">
                    Default for everyone
                  </label>
                </div>
                <Switch id="key-default" checked={isDefault} onChange={setIsDefault} disabled={!adding && existing?.isDefault} />
              </div>
              {providerId === "anthropic" && (
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="key-web-search">
                      Web search
                    </label>
                    <div className="desc">
                      Claude can look things up and cite its sources. $10 per 1,000 searches, at most 5 per reply. Works in
                      chats started while some Claude key has it on
                    </div>
                  </div>
                  <Switch id="key-web-search" checked={webSearch} onChange={setWebSearch} />
                </div>
              )}
              {providerId === "anthropic" && (
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="key-code">
                      Make files
                    </label>
                    <div className="desc">
                      Claude can run code in Anthropic's sandbox to make files people download: spreadsheets, charts,
                      images, documents. Free alongside web search, otherwise $0.05 an hour after 1,550 free hours a month.
                      Works in chats started while some Claude key has it on
                    </div>
                  </div>
                  <Switch id="key-code" checked={codeExecution} onChange={setCodeExecution} />
                </div>
              )}
            </div>

            {/* The default key is everyone's, so who-can-use-it only matters for the others. */}
            {!isDefault && (
              <OptionList
                label="Who can pick it"
                value={shared}
                onChange={setShared}
                options={[
                  { id: "everyone", label: "Everyone" },
                  { id: "chosen", label: "Only people you choose", detail: "Choose them under People" },
                ]}
              />
            )}

            <OptionList
              label="If it fails, answer with"
              value={fallback}
              onChange={setFallback}
              options={[
                { id: "none", label: "Nothing, show the error" },
                ...otherKeys.map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel })),
              ]}
            />

            <LineField
              id="key-secret"
              label={adding ? "API key" : `New API key (now ends in ${existing?.last4})`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              error={error}
            />

            <div className="form-page-actions">
              <button type="submit" className="btn-primary" disabled={busy || !label.trim() || (adding && !secret.trim())}>
                {busy ? "Checking the key" : adding ? "Add key" : "Save"}
              </button>
              <Link to="/admin/keys" className="btn-secondary">
                Cancel
              </Link>
            </div>

            {existing && (
              <DangerRow
                label="Delete this key"
                confirmLabel={
                  existing.boundUsers > 0 ? "Delete it? Its people move to the default key" : "Delete this key for good?"
                }
                onConfirm={async () => {
                  await api.del(`/admin/keys/${existing.id}`);
                  navigate("/admin/keys");
                }}
              />
            )}
          </form>
        )}
      </div>
    </div>
  );
}
