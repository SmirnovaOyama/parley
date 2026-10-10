import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { api } from "../../lib/api.ts";
import { amountInput, amountText, formatCost } from "../../lib/format.ts";
import { useSession } from "../../lib/session.tsx";
import { useSlideNavigate } from "../../lib/slide.ts";
import type { ApiKey } from "./KeysPage.tsx";
import type { Group } from "./GroupsPage.tsx";
import type { Person } from "./PeoplePage.tsx";

const ROLES = [
  { id: "user", label: "Member" },
  { id: "admin", label: "Admin", detail: "Manages keys and people, and can read every chat" },
] as const;

/** Add a person (/admin/people/new) or change one (/admin/people/:id) on its own page. */
export function PersonFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const { user: me } = useSession();

  const [person, setPerson] = useState<Person | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Person["role"]>("user");
  const [keyId, setKeyId] = useState("default");
  const [granted, setGranted] = useState<string[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
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
      api.get<{ groups: Group[] }>("/admin/groups"),
    ]).then(
      ([u, k, s, g]) => {
        setKeys(k.keys);
        setGroups(g.groups);
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
        setGroupIds((p.groupIds ?? []).map(String));
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
          groupIds: groupIds.map(Number),
          monthlyTokenLimit: limit.trim() === "" ? null : Number(limit),
          spendLimitMode: spendMode,
          monthlySpendLimit: ownSpend.trim() === "" ? null : ownSpend,
        });
      }
      slideTo("/admin/people", "back");
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
                {groups.length > 0 && (
                  <CheckList
                    label="Groups"
                    values={groupIds}
                    onChange={setGroupIds}
                    options={groups.map((g) => ({ id: String(g.id), label: g.name }))}
                  />
                )}
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
                    // Every key is listed; the ones they can't pick yet rest, so granting one above
                    // doesn't add a row here.
                    ...(keys ?? [])
                      .filter((k) => !k.isDefault)
                      .map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel, disabled: !usable.includes(k) })),
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
              <BusyButton type="submit" className="btn-primary" busy={busy} disabled={adding && (!email || !password)}>
                {adding ? "Add person" : "Save"}
              </BusyButton>
              <SlideLink to="/admin/people" direction="back" className="btn-secondary">
                Cancel
              </SlideLink>
            </div>
          </form>
        )}

        {person && (
          <div className="oy-group settings-group">
            <p className="oy-overline">Password</p>
            {isSelf ? (
              <div className="settings-panel">
                <p className="settings-text">Yours is changed under Account, which keeps you signed in here</p>
                <div className="form-page-actions">
                  <SlideLink to="/account/password" direction="forward" className="btn-secondary">
                    Change your password
                  </SlideLink>
                </div>
              </div>
            ) : (
              <NewPassword person={person} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A new password for someone who can't sign in (when the site can't email them a link, say), set
 * apart from the form above. It unfolds in place into a field and the line that says what it does.
 */
function NewPassword({ person }: { person: Person }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  /** Folded again by the admin: the button that opened it takes focus back. */
  const [refolded, setRefolded] = useState(false);

  const fold = (saved: boolean) => {
    setOpen(false);
    setPassword("");
    setError(null);
    setDone(saved);
    setRefolded(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/admin/users/${person.id}/password`, { password });
      fold(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="settings-panel">
        <p id="person-password-note" className="settings-text">
          {done ? "New password set. They were signed out everywhere" : "If they can't sign in, set a new one and pass it on. It signs them out everywhere"}
        </p>
        <div className="form-page-actions">
          <button
            type="button"
            className="btn-secondary"
            aria-describedby="person-password-note"
            autoFocus={refolded}
            onClick={() => setOpen(true)}
          >
            Set a new password
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="settings-panel"
      onSubmit={save}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.nativeEvent.isComposing) fold(false);
      }}
    >
      <LineField
        id="person-new-password"
        label="New password"
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint="At least 8 characters"
        error={error}
      />
      {/* InlineConfirm's line, under the field it asks about: the field is the first step. */}
      <div className="inline-confirm" role="group" aria-label="Setting it signs them out everywhere">
        <span>Setting it signs them out everywhere</span>
        <span className="inline-confirm-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => fold(false)}>
            Cancel
          </button>
          <BusyButton type="submit" className="btn-danger btn-sm" busy={busy} disabled={!password}>
            Set password
          </BusyButton>
        </span>
      </div>
    </form>
  );
}
