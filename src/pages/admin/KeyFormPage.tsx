import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { amountInput, amountText } from "../../lib/format.ts";
import type { ApiKey, ProviderInfo, Service } from "./KeysPage.tsx";

/** One model of another service as it's typed: its name, and its prices per million tokens. */
type ModelRow = { key: number; id: string; input: string; output: string };

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** The providers whose keys can search the web and make files, and what each switch says there. */
const TOOL_COPY: Record<string, { search: string; code: string }> = {
  anthropic: {
    search: "Claude can look things up and cite its sources. $10 per 1,000 searches, at most 5 per reply.",
    code:
      "Claude can run code in Anthropic's sandbox to make files people download: spreadsheets, charts, images, documents. " +
      "Free alongside web search, otherwise $0.05 an hour after 1,550 free hours a month.",
  },
  openai: {
    search: "GPT can look things up and cite its sources. $10 per 1,000 searches, and the pages it reads count as input.",
    code:
      "GPT can run code in OpenAI's sandbox to make files people download: spreadsheets, charts, images, documents. " +
      "$0.03 per 20-minute sandbox session.",
  },
};

/** Add a key (/admin/keys/new) or edit one (/admin/keys/:id) on its own page. */
export function KeyFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const navigate = useNavigate();

  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [services, setServices] = useState<Service[]>([]);
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
  // Another service: its address, the models typed for it, and whether they look at pictures.
  const [baseUrl, setBaseUrl] = useState("");
  const [rows, setRows] = useState<ModelRow[]>([{ key: 0, id: "", input: "", output: "" }]);
  const [images, setImages] = useState(false);
  const nextRow = useRef(1);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ providers: ProviderInfo[]; services: Service[] }>("/admin/catalog"),
      api.get<{ keys: ApiKey[] }>("/admin/keys"),
    ]).then(
      ([catalog, list]) => {
        setProviders(catalog.providers);
        setServices(catalog.services);
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
        if (key.endpoint) {
          setBaseUrl(key.endpoint.baseUrl);
          setImages(key.endpoint.images);
          setRows(key.endpoint.models.map((m, i) => ({ key: i, id: m.id, input: amountText(m.input), output: amountText(m.output) })));
          nextRow.current = key.endpoint.models.length;
        }
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const provider = providers?.find((p) => p.id === providerId);
  const custom = !!provider?.custom;
  const tools = TOOL_COPY[providerId];
  const modelInfo = provider?.models.find((m) => m.id === model);
  // Another service's models are the names typed for it; new chats start on the chosen one, or the first.
  const typed = [...new Set(rows.map((r) => r.id.trim()).filter(Boolean))];
  const start = custom ? (typed.includes(model) ? model : (typed[0] ?? "")) : model;
  const service = services.find((s) => s.baseUrl === trimUrl(baseUrl));

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
      setEffort(m?.defaultEffort ?? "default");
    }
  };

  const pickService = (serviceId: string) => {
    const s = services.find((x) => x.id === serviceId);
    // "Somewhere else" clears a known address so a new one can be typed.
    if (s) setBaseUrl(s.baseUrl);
    else if (service) setBaseUrl("");
  };

  const editRow = (key: number, change: Partial<ModelRow>) => setRows((all) => all.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const addRow = () => setRows((all) => [...all, { key: nextRow.current++, id: "", input: "", output: "" }]);
  const removeRow = (key: number) => setRows((all) => all.filter((r) => r.key !== key));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const endpoint = custom
      ? {
          baseUrl: trimUrl(baseUrl),
          models: rows.filter((r) => r.id.trim()).map((r) => ({ id: r.id.trim(), input: r.input, output: r.output })),
          images,
        }
      : undefined;
    const choice = { model: start, effort: custom ? "default" : effort, models: custom ? typed : models, endpoint };
    try {
      if (adding) {
        await api.post("/admin/keys", {
          label,
          provider: providerId,
          ...choice,
          apiKey: secret,
          isDefault,
          shared: isDefault || shared === "everyone",
          fallbackKeyId: fallback === "none" ? null : Number(fallback),
          webSearch: !!tools && webSearch,
          codeExecution: !!tools && codeExecution,
        });
      } else if (existing) {
        await api.patch(`/admin/keys/${existing.id}`, {
          label,
          ...choice,
          ...(secret ? { apiKey: secret } : {}),
          ...(isDefault && !existing.isDefault ? { isDefault: true } : {}),
          shared: isDefault || shared === "everyone",
          fallbackKeyId: fallback === "none" ? null : Number(fallback),
          webSearch: !!tools && webSearch,
          codeExecution: !!tools && codeExecution,
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
  // A service on the server itself (Ollama, say) may need no key.
  const secretLabel = !adding && existing?.last4
    ? `New API key (now ends in ${existing.last4})`
    : custom
      ? "API key, if the service needs one"
      : "API key";
  const ready = !!label.trim() && (custom ? !!trimUrl(baseUrl) && typed.length > 0 : !(adding && !secret.trim()));

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
                options={providers.map((p) => ({ id: p.id, label: p.label, detail: p.detail, features: p.features }))}
              />
            )}

            {custom ? (
              <>
                <OptionList
                  label="Service"
                  value={service?.id ?? "elsewhere"}
                  onChange={pickService}
                  options={[
                    ...services.map((s) => ({ id: s.id, label: s.label, detail: new URL(s.baseUrl).host })),
                    { id: "elsewhere", label: "Somewhere else", detail: "Type its address below" },
                  ]}
                />
                <LineField
                  id="key-base-url"
                  label="Address"
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />

                <div className="oy-group" role="group" aria-label="Models it serves">
                  <p className="oy-overline">Models it serves</p>
                  <div className="endpoint-models">
                    {rows.map((r, i) => (
                      <div className="endpoint-model" key={r.key}>
                        <LineField
                          id={`key-model-${r.key}`}
                          label="Model name"
                          autoComplete="off"
                          spellCheck={false}
                          maxLength={200}
                          value={r.id}
                          onChange={(e) => editRow(r.key, { id: e.target.value })}
                          hint={i === 0 && !r.id && service ? `Like ${service.example}` : undefined}
                        />
                        <LineField
                          id={`key-model-${r.key}-in`}
                          label="$ in"
                          inputMode="decimal"
                          autoComplete="off"
                          value={r.input}
                          onChange={(e) => editRow(r.key, { input: amountInput(e.target.value) })}
                        />
                        <LineField
                          id={`key-model-${r.key}-out`}
                          label="$ out"
                          inputMode="decimal"
                          autoComplete="off"
                          value={r.output}
                          onChange={(e) => editRow(r.key, { output: amountInput(e.target.value) })}
                        />
                        <button
                          type="button"
                          className="btn-ghost icon-button"
                          aria-label={`Remove ${r.id.trim() || "this model"}`}
                          disabled={rows.length === 1}
                          onClick={() => removeRow(r.key)}
                        >
                          <Icon name="close" size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button type="button" className="btn-ghost is-accent endpoint-add" onClick={addRow}>
                    <Icon name="plus" size={16} />
                    Add a model
                  </button>
                  <p className="panel-note endpoint-note">
                    Prices are dollars per million tokens, in and out. They feed the cost estimates and spending limits;
                    a model without them counts as free
                  </p>
                </div>

                {typed.length > 1 && (
                  <OptionList label="New chats start on" value={start} onChange={setModel} options={typed.map((m) => ({ id: m, label: m }))} />
                )}
              </>
            ) : (
              <>
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

                {modelInfo && modelInfo.efforts.length > 1 && (
                  <OptionList label="Thinking they start with" value={effort} onChange={setEffort} options={modelInfo.efforts} />
                )}
                <p className="panel-note">People can change the model and thinking for each chat, among the models ticked above</p>
              </>
            )}

            <div className="oy-section is-plain">
              <div className="oy-row">
                <div className="text">
                  <label className="title" htmlFor="key-default">
                    Default for everyone
                  </label>
                </div>
                <Switch id="key-default" checked={isDefault} onChange={setIsDefault} disabled={!adding && existing?.isDefault} />
              </div>
              {custom && (
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="key-images">
                      Reads images
                    </label>
                    <div className="desc">Turn on when these models look at pictures, so people can attach them</div>
                  </div>
                  <Switch id="key-images" checked={images} onChange={setImages} />
                </div>
              )}
              {tools && (
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="key-web-search">
                      Web search
                    </label>
                    <div className="desc">
                      {tools.search} Works in chats started while some Claude or OpenAI key has it on
                    </div>
                  </div>
                  <Switch id="key-web-search" checked={webSearch} onChange={setWebSearch} />
                </div>
              )}
              {tools && (
                <div className="oy-row">
                  <div className="text">
                    <label className="title" htmlFor="key-code">
                      Make files
                    </label>
                    <div className="desc">
                      {tools.code} Works in chats started while some Claude or OpenAI key has it on
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
              label={secretLabel}
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              error={error}
            />

            <div className="form-page-actions">
              <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!ready}>
                {busy ? "Checking the key" : adding ? "Add key" : "Save"}
              </BusyButton>
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
