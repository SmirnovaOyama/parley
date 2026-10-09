import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { api } from "../../lib/api.ts";
import { amountInput, amountText, formatCost } from "../../lib/format.ts";
import { useSession } from "../../lib/session.tsx";
import type { ApiKey } from "./KeysPage.tsx";
import type { Person } from "./PeoplePage.tsx";

const ROLES = [
  { id: "user", label: "Member" },
  { id: "admin", label: "Admin", detail: "Manages keys and people, and can read every chat" },
] as const;

/** Add a person (/admin/people/new) or change one (/admin/people/:id) on its own page. */
export function PersonFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const navigate = useNavigate();
  const { user: me } = useSession();

  const [person, setPerson] = useState<Person | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Person["role"]>("user");
  const [keyId, setKeyId] = useState("default");
  const [granted, setGranted] = useState<string[]>([]);
  const [limit, setLimit] = useState("");
  const [spendMode, setSpendMode] = useState<Person["spendLimitMode"]>("site");
  const [ownSpend, setOwnSpend] = useState("");
  /** The site's monthly limit for members (Settings); null for none. */
  const [siteSpend, setSiteSpend] = useState<number | null>(null);
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ users: Person[] }>("/admin/users"),
      api.get<{ keys: ApiKey[] }>("/admin/keys"),
      api.get<{ settings: { spendLimit: number | null } }>("/admin/settings"),
    ]).then(
      ([u, k, s]) => {
        setKeys(k.keys);
        setSiteSpend(s.settings.spendLimit);
        if (adding) return;
        const p = u.users.find((x) => String(x.id) === id);
        if (!p) {
          setLoadError("This person doesn't exist any more");
          return;
        }
        setPerson(p);
        setRole(p.role);
        setKeyId(p.apiKeyId == null ? "default" : String(p.apiKeyId));
        setGranted(p.keyIds.map(String));
        setLimit(p.monthlyTokenLimit == null ? "" : String(p.monthlyTokenLimit));
        setSpendMode(p.spendLimitMode);
        setOwnSpend(amountText(p.monthlySpendLimit));
        setActive(!p.disabled);
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  const isSelf = person?.id === me?.id;
  const defaultKey = keys?.find((k) => k.isDefault);
  const restricted = keys?.filter((k) => !k.shared) ?? [];
  // Keys this person could start a chat with: shared ones plus the ones ticked above.
  const usable = keys?.filter((k) => k.shared || granted.includes(String(k.id))) ?? [];

  const setGrantedKeys = (next: string[]) => {
    setGranted(next);
    // Starting on a model they can no longer pick falls back to the site default.
    if (keyId !== "default" && !keys?.find((k) => String(k.id) === keyId && (k.shared || next.includes(keyId)))) {
      setKeyId("default");
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (adding) {
        await api.post("/admin/users", { email, password, role });
      } else if (person) {
        await api.patch(`/admin/users/${person.id}`, {
          role,
          disabled: !active,
          apiKeyId: keyId === "default" ? null : Number(keyId),
          keyIds: granted.map(Number),
          monthlyTokenLimit: limit.trim() === "" ? null : Number(limit),
          spendLimitMode: spendMode,
          monthlySpendLimit: ownSpend.trim() === "" ? null : ownSpend,
        });
      }
      navigate("/admin/people");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <PageHeader
        title={adding ? "New person" : person?.email ?? "Person"}
        subtitle={
          person?.bonusEmail
            ? `Verified ${person.bonusEmail}${person.bonusActive ? ", earns the email reward" : ", no longer rewarded"}`
            : undefined
        }
        back={{ label: "People", to: "/admin/people" }}
      />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !keys || (!adding && !person) ? (
          <Spinner />
        ) : (
          <form className="form-page" onSubmit={save}>
            {adding && (
              <>
                <LineField id="person-email" label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
                <LineField
                  id="person-password"
                  label="Temporary password"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}

            <OptionList label="Role" value={role} onChange={setRole} options={ROLES} />

            {!adding && (
              <>
                <CheckList
                  label="Extra models they can pick"
                  values={granted}
                  onChange={setGrantedKeys}
                  options={restricted.map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel }))}
                  empty="Every key is open to everyone. Set a key to “Only people you choose” to grant it here"
                />
                <OptionList
                  label="New chats start with"
                  value={keyId}
                  onChange={setKeyId}
                  options={[
                    { id: "default", label: "The default key", detail: defaultKey ? `${defaultKey.label}, which starts chats on ${defaultKey.modelLabel}` : "None set yet" },
                    ...usable.filter((k) => !k.isDefault).map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel })),
                  ]}
                />
                <OptionList
                  label={`Spending each month (${formatCost(person!.spentThisMonth)} so far)`}
                  value={spendMode}
                  onChange={setSpendMode}
                  options={[
                    {
                      id: "site",
                      label: "The site's limit",
                      detail:
                        role === "admin"
                          ? "Admins aren't held to it, so no limit"
                          : siteSpend == null
                            ? "None is set in Settings, so no limit"
                            : person!.bonusSpend
                              ? `${formatCost(siteSpend)} a month, set in Settings, and ${formatCost(person!.bonusSpend)} from their email reward`
                              : `${formatCost(siteSpend)} a month, set in Settings`,
                    },
                    { id: "own", label: "Their own limit", detail: "Higher or lower than everyone else's" },
                    { id: "none", label: "No limit" },
                  ]}
                />
                {spendMode === "own" && (
                  <LineField
                    id="person-spend"
                    label="Dollars a month"
                    inputMode="decimal"
                    autoComplete="off"
                    value={ownSpend}
                    onChange={(e) => setOwnSpend(amountInput(e.target.value))}
                    hint={
                      person!.bonusSpend
                        ? `Their email reward adds ${formatCost(person!.bonusSpend)}. Estimated from each model's price, counted from the 1st`
                        : "Estimated from each model's price, counted from the 1st"
                    }
                  />
                )}
                <LineField
                  id="person-limit"
                  label="Monthly token limit (empty for none)"
                  inputMode="numeric"
                  autoComplete="off"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
                />
                <div className="oy-section is-plain">
                  <div className="oy-row">
                    <div className="text">
                      <label className="title" htmlFor="person-active">
                        Account on
                      </label>
                    </div>
                    <Switch id="person-active" checked={active} onChange={setActive} disabled={isSelf} />
                  </div>
                </div>
              </>
            )}

            {error && <Advisory>{error}</Advisory>}

            <div className="form-page-actions">
              <button type="submit" className="btn-primary" disabled={busy || (adding && (!email || !password))}>
                {adding ? "Add person" : "Save"}
              </button>
              <Link to="/admin/people" className="btn-secondary">
                Cancel
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
