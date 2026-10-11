import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { CheckList, OptionList, Switch } from "../../components/Controls.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { DeviceList } from "../../components/DeviceList.tsx";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { api, type Device } from "../../lib/api.ts";
import { amountInput, amountText, formatCost, plural } from "../../lib/format.ts";
import { andText, t, tn } from "../../lib/i18n.ts";
import { useSession } from "../../lib/session.tsx";
import { useSlideNavigate } from "../../lib/slide.ts";
import type { ApiKey } from "./KeysPage.tsx";
import type { Group } from "./GroupsPage.tsx";
import type { Person } from "./PeoplePage.tsx";

const ROLES = [
  { id: "user", label: t("Member") },
  { id: "admin", label: t("Admin"), detail: t("Manages keys and people, and can read every chat") },
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
  /** Counts the times they were signed out everywhere here, so the devices are read again. */
  const [signedOut, setSignedOut] = useState(0);

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
          setLoadError(t("This person doesn't exist any more"));
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
        title={adding ? t("New person") : person?.email ?? t("Person")}
        subtitle={
          person?.bonusEmail
            ? person.bonusActive
              ? t("Verified {bonusEmail}, earns the email reward", { bonusEmail: person.bonusEmail })
              : t("Verified {bonusEmail}, no longer rewarded", { bonusEmail: person.bonusEmail })
            : undefined
        }
        back={{ label: t("People"), to: "/admin/people" }}
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
                <LineField id="person-email" label={t("Email")} type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />
                <LineField
                  id="person-password"
                  label={t("Temporary password")}
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            )}

            <OptionList label={t("Role")} value={role} onChange={setRole} options={ROLES} />

            {!adding && (
              <>
                {groups.length > 0 && (
                  <CheckList
                    label={t("Groups")}
                    values={groupIds}
                    onChange={setGroupIds}
                    options={groups.map((g) => ({ id: String(g.id), label: g.name }))}
                  />
                )}
                <CheckList
                  label={t("Extra models they can pick")}
                  values={granted}
                  onChange={setGrantedKeys}
                  options={restricted.map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel }))}
                  empty={t("Every key is open to everyone. Set a key to “Only people you choose” to grant it here")}
                />
                <OptionList
                  label={t("New chats start with")}
                  value={keyId}
                  onChange={setKeyId}
                  options={[
                    {
                      id: "default",
                      label: t("The default key"),
                      detail: defaultKey
                        ? t("{label}, which starts chats on {modelLabel}", { label: defaultKey.label, modelLabel: defaultKey.modelLabel })
                        : t("None set yet"),
                    },
                    // Every key is listed; the ones they can't pick yet rest, so granting one above
                    // doesn't add a row here.
                    ...(keys ?? [])
                      .filter((k) => !k.isDefault)
                      .map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel, disabled: !usable.includes(k) })),
                  ]}
                />
                <OptionList
                  label={t("Spending each month ({spentThisMonth} so far)", { spentThisMonth: formatCost(person!.spentThisMonth) })}
                  value={spendMode}
                  onChange={setSpendMode}
                  options={[
                    {
                      id: "site",
                      label: t("The site's limit"),
                      detail:
                        role === "admin"
                          ? t("Admins aren't held to it, so no limit")
                          : siteSpend == null
                            ? t("None is set in Settings, so no limit")
                            : person!.bonusSpend
                              ? t("{siteSpend} a month, set in Settings, and {bonusSpend} from their email reward", {
                                  siteSpend: formatCost(siteSpend),
                                  bonusSpend: formatCost(person!.bonusSpend),
                                })
                              : t("{siteSpend} a month, set in Settings", { siteSpend: formatCost(siteSpend) }),
                    },
                    { id: "own", label: t("Their own limit"), detail: t("Higher or lower than everyone else's") },
                    { id: "none", label: t("No limit") },
                  ]}
                />
                {spendMode === "own" && (
                  <LineField
                    id="person-spend"
                    label={t("Dollars a month")}
                    inputMode="decimal"
                    autoComplete="off"
                    value={ownSpend}
                    onChange={(e) => setOwnSpend(amountInput(e.target.value))}
                    hint={
                      person!.bonusSpend
                        ? t("Their email reward adds {bonusSpend}. Estimated from each model's price, counted from the 1st", {
                            bonusSpend: formatCost(person!.bonusSpend),
                          })
                        : t("Estimated from each model's price, counted from the 1st")
                    }
                  />
                )}
                <LineField
                  id="person-limit"
                  label={t("Monthly token limit (empty for none)")}
                  inputMode="numeric"
                  autoComplete="off"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value.replace(/[^\d]/g, ""))}
                />
                <div className="oy-section is-plain">
                  <div className="oy-row">
                    <div className="text">
                      <label className="title" htmlFor="person-active">
                        {t("Account on")}
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
                {adding ? t("Add person") : t("Save")}
              </BusyButton>
              <SlideLink to="/admin/people" direction="back" className="btn-secondary">
                {t("Cancel")}
              </SlideLink>
            </div>
          </form>
        )}

        {person && (
          <div className="oy-group settings-group">
            <p className="oy-overline">{t("Password")}</p>
            {isSelf ? (
              <div className="settings-panel">
                <p className="settings-text">{t("Yours is changed under Settings, which keeps you signed in here")}</p>
                <div className="form-page-actions">
                  <SlideLink to="/settings/password" direction="forward" className="btn-secondary">
                    {t("Change your password")}
                  </SlideLink>
                </div>
              </div>
            ) : (
              <NewPassword person={person} onSet={() => setSignedOut((n) => n + 1)} />
            )}
          </div>
        )}

        {person && (
          <div className="oy-group settings-group">
            <p className="oy-overline">{t("Devices")}</p>
            {isSelf ? (
              <div className="settings-panel">
                <p className="settings-text">{t("Yours are under Settings, which keeps you signed in here")}</p>
                <div className="form-page-actions">
                  <SlideLink to="/settings/devices" direction="forward" className="btn-secondary">
                    {t("See where you're signed in")}
                  </SlideLink>
                </div>
              </div>
            ) : (
              <PersonDevices key={signedOut} person={person} />
            )}
          </div>
        )}

        {person && (
          <div className="oy-group settings-group">
            <p className="oy-overline">{t("Two-step verification")}</p>
            {isSelf ? (
              <div className="settings-panel">
                <p className="settings-text">{t("Yours is under Settings, which asks for your password to change it")}</p>
                <div className="form-page-actions">
                  <SlideLink to="/settings/two-step" direction="forward" className="btn-secondary">
                    {t("Your two-step verification")}
                  </SlideLink>
                </div>
              </div>
            ) : (
              <PersonTwoStep person={person} />
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
function NewPassword({ person, onSet }: { person: Person; onSet: () => void }) {
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
      onSet();
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
          {done ? t("New password set. They were signed out everywhere") : t("If they can't sign in, set a new one and pass it on. It signs them out everywhere")}
        </p>
        <div className="form-page-actions">
          <button
            type="button"
            className="btn-secondary"
            aria-describedby="person-password-note"
            autoFocus={refolded}
            onClick={() => setOpen(true)}
          >
            {t("Set a new password")}
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
        label={t("New password")}
        type="text"
        autoComplete="off"
        spellCheck={false}
        autoFocus
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={t("At least 8 characters")}
        error={error}
      />
      {/* InlineConfirm's line, under the field it asks about: the field is the first step. */}
      <div className="inline-confirm" role="group" aria-label={t("Setting it signs them out everywhere")}>
        <span>{t("Setting it signs them out everywhere")}</span>
        <span className="inline-confirm-actions">
          <button type="button" className="btn-secondary btn-sm" onClick={() => fold(false)}>
            {t("Cancel")}
          </button>
          <BusyButton type="submit" className="btn-danger btn-sm" busy={busy} disabled={!password}>
            {t("Set password")}
          </BusyButton>
        </span>
      </div>
    </form>
  );
}

type Spread = { sessions: Device[]; devices: number; networks: number; programs: number };

/** Where they're signed in, as sentences: how many devices and networks, and any that aren't browsers. */
function spreadText(d: Spread): string {
  if (!d.devices) return t("Not signed in anywhere");
  const devices = plural(d.devices, "device", "devices");
  const parts = [
    d.networks
      ? t("On {devices}, used from {networks} this week", { devices, networks: plural(d.networks, "network", "networks") })
      : t("On {devices}", { devices }),
  ];
  if (d.programs) {
    parts.push(
      tn(
        d.programs,
        "One is a program, not a browser: their sign-in used by a script, which can pass this site's models on to other apps or people",
        "{programs} are programs, not browsers: their sign-in used by a script, which can pass this site's models on to other apps or people",
        { programs: d.programs },
      ),
    );
  }
  return parts.join(". ");
}

/**
 * The devices someone is signed in on, the address each was last used from, and signing them out of
 * one or all. Many devices or networks can mean an account passed around; a program, a relay.
 */
function PersonDevices({ person }: { person: Person }) {
  const [data, setData] = useState<Spread | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<Spread>(`/admin/users/${person.id}/sessions`).then(setData, (err) => setError((err as Error).message));
  useEffect(() => {
    void load();
  }, [person.id]);

  if (!data) return error ? <Advisory>{error}</Advisory> : <Spinner />;
  return (
    <>
      <p className="group-intro">{spreadText(data)}</p>
      {error && <Advisory>{error}</Advisory>}
      {data.sessions.length > 0 && (
        <>
          <DeviceList
            devices={data.sessions}
            onSignOut={async (d) => {
              setError(null);
              try {
                await api.del(`/admin/users/${person.id}/sessions/${d.id}`);
              } catch (err) {
                setError((err as Error).message);
              }
              void load();
            }}
          />
          <DangerRow
            label={t("Sign out everywhere")}
            confirmLabel={t("Sign {email} out of every device?", { email: person.email })}
            action={t("Sign out")}
            onConfirm={async () => {
              setError(null);
              try {
                await api.del(`/admin/users/${person.id}/sessions`);
              } catch (err) {
                setError((err as Error).message);
              }
              void load();
            }}
          />
        </>
      )}
    </>
  );
}

/**
 * Someone's two-step verification, and turning it off for them when they've lost both their phone
 * and their recovery codes: they then sign in with their password alone, and can set it up again.
 */
function PersonTwoStep({ person }: { person: Person }) {
  const [state, setState] = useState(person.twoStep);
  const [error, setError] = useState<string | null>(null);
  const ways = [state.totp && t("an authenticator app"), state.passkeys > 0 && plural(state.passkeys, "passkey", "passkeys")].filter((w) => typeof w === "string");
  return (
    <>
      <p className="group-intro">
        {state.on
          ? t("On, with {andText}. If they've lost their phone and their recovery codes, turn it off so they can sign in with their password, then set it up again", {
              andText: andText(ways),
            })
          : t("Off. They can turn it on under Settings")}
      </p>
      {error && <Advisory>{error}</Advisory>}
      {state.on && (
        <DangerRow
          label={t("Turn off two-step verification")}
          confirmLabel={t("Turn off {email}'s two-step verification?", { email: person.email })}
          action={t("Turn off")}
          onConfirm={async () => {
            setError(null);
            try {
              await api.post(`/admin/users/${person.id}/two-step/off`, {});
              setState({ on: false, totp: false, passkeys: 0 });
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </>
  );
}
