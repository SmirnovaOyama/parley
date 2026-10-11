import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { BusyButton } from "../../components/BusyButton.tsx";
import { CheckList } from "../../components/Controls.tsx";
import { DangerRow } from "../../components/DangerRow.tsx";
import { Advisory, EmptyState, Spinner } from "../../components/Feedback.tsx";
import { LineField } from "../../components/LineField.tsx";
import { PageHeader } from "../../components/PageHeader.tsx";
import { SlideLink } from "../../components/SlideLink.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { amountInput, amountText, formatCost, formatNumber, plural } from "../../lib/format.ts";
import { andText, t, tn } from "../../lib/i18n.ts";
import { useSlideNavigate } from "../../lib/slide.ts";
import type { ApiKey } from "./KeysPage.tsx";
import type { Person } from "./PeoplePage.tsx";
import type { McpServer } from "./ToolsPage.tsx";

export type Group = { id: number; name: string; spendLimit: number | null; memberIds: number[]; keyIds: number[]; serverIds: number[] };

/** What a group does, as a sentence for its row. */
function groupDesc(g: Group): string {
  const parts = [
    g.memberIds.length ? plural(g.memberIds.length, "person", "people") : t("Nobody yet"),
    g.keyIds.length ? tn(g.keyIds.length, "opens {count} key", "opens {count} keys", { count: formatNumber(g.keyIds.length) }) : "",
    g.serverIds.length ? tn(g.serverIds.length, "{count} MCP server", "{count} MCP servers", { count: formatNumber(g.serverIds.length) }) : "",
  ].filter(Boolean);
  const head = parts.length > 1 ? t("{parts}. It {parts2}", { parts: parts[0], parts2: andText(parts.slice(1)) }) : parts[0];
  return g.spendLimit != null ? t("{head}. Each member may spend {spendLimit} a month", { head, spendLimit: formatCost(g.spendLimit) }) : head;
}

/** Groups of people (Admin › Groups): a class or a team, with the models and servers it opens and its own spending limit. */
export function GroupsPage() {
  const slideTo = useSlideNavigate();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ groups: Group[] }>("/admin/groups").then((r) => setGroups(r.groups), (err) => setError((err as Error).message));
  }, []);

  if (error) return <Advisory>{error}</Advisory>;
  if (!groups) return <Spinner />;

  return (
    <>
      <div className="admin-toolbar">
        <p className="text-muted">{groups.length ? plural(groups.length, "group", "groups") : t("Groups of people, like a class or a team")}</p>
        <button type="button" className="btn-ghost is-accent" onClick={() => slideTo("/admin/groups/new", "forward")}>
          <Icon name="plus" size={16} />
          {t("Add a group")}
        </button>
      </div>
      {groups.length === 0 ? (
        <EmptyState doodle="people" title={t("No groups yet")}>
          {t("Put people in a group to open models and MCP servers to all of them at once, or give them a spending limit of their own")}
        </EmptyState>
      ) : (
        <div className="oy-section is-plain">
          {groups.map((g) => (
            <button key={g.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/groups/${g.id}`, "forward")}>
              <Icon name="users" size={20} />
              <div className="text">
                <p className="title truncate">{g.name}</p>
                <div className="desc">{groupDesc(g)}</div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Add a group (/admin/groups/new) or change one (/admin/groups/:id). */
export function GroupFormPage() {
  const { id } = useParams();
  const adding = id === "new";
  const slideTo = useSlideNavigate();
  const [group, setGroup] = useState<Group | null>(null);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [name, setName] = useState("");
  const [spend, setSpend] = useState("");
  const [members, setMembers] = useState<string[]>([]);
  const [keyIds, setKeyIds] = useState<string[]>([]);
  const [serverIds, setServerIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ groups: Group[] }>("/admin/groups"),
      api.get<{ users: Person[] }>("/admin/users"),
      api.get<{ keys: ApiKey[] }>("/admin/keys"),
      api.get<{ servers: McpServer[] }>("/admin/mcp"),
    ]).then(
      ([g, u, k, m]) => {
        setPeople(u.users);
        setKeys(k.keys);
        setServers(m.servers);
        if (adding) return;
        const found = g.groups.find((x) => String(x.id) === id);
        if (!found) {
          setLoadError(t("This group doesn't exist any more"));
          return;
        }
        setGroup(found);
        setName(found.name);
        setSpend(amountText(found.spendLimit));
        setMembers(found.memberIds.map(String));
        setKeyIds(found.keyIds.map(String));
        setServerIds(found.serverIds.map(String));
      },
      (err) => setLoadError((err as Error).message),
    );
  }, [id, adding]);

  // Only what isn't open to everyone already is worth opening to a group. One the group had when
  // it was saved stays listed after it's unticked, so the rows don't jump under the pointer.
  const restrictedKeys = keys.filter((k) => !k.shared || !!group?.keyIds.includes(k.id));
  const restrictedServers = servers.filter((s) => !s.shared || !!group?.serverIds.includes(s.id));

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name,
        spendLimit: spend.trim() === "" ? null : spend,
        memberIds: members.map(Number),
        keyIds: keyIds.map(Number),
        serverIds: serverIds.map(Number),
      };
      if (adding) await api.post("/admin/groups", body);
      else await api.patch(`/admin/groups/${id}`, body);
      slideTo("/admin/groups", "back");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="admin-page">
      <PageHeader title={adding ? t("New group") : (group?.name ?? t("Group"))} back={{ label: t("Groups"), to: "/admin/groups" }} />
      <div className="oy-page-column page-body">
        {loadError ? (
          <Advisory>{loadError}</Advisory>
        ) : !people || (!adding && !group) ? (
          <Spinner />
        ) : (
          <>
            <form className="form-page" onSubmit={save}>
              <LineField id="group-name" label={t("Name")} value={name} maxLength={60} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              <CheckList
                label={t("People in it")}
                values={members}
                onChange={setMembers}
                options={people.map((p) => ({ id: String(p.id), label: p.email, detail: p.role === "admin" ? t("Admin") : undefined }))}
              />
              <CheckList
                label={t("Models it opens")}
                values={keyIds}
                onChange={setKeyIds}
                options={restrictedKeys.map((k) => ({ id: String(k.id), label: k.label, detail: k.modelLabel }))}
                empty={t("Every key is open to everyone. Set a key to “Only people you choose” to open it to a group")}
              />
              <CheckList
                label={t("MCP servers it opens")}
                values={serverIds}
                onChange={setServerIds}
                options={restrictedServers.map((s) => ({ id: String(s.id), label: s.name, detail: plural(s.tools.length - s.offTools.length, "tool", "tools") }))}
                empty={t("Every MCP server is open to everyone, or there are none yet. Add them under Tools")}
              />
              <LineField
                id="group-spend"
                label={t("Each member's monthly limit, in dollars")}
                inputMode="decimal"
                autoComplete="off"
                value={spend}
                onChange={(e) => setSpend(amountInput(e.target.value))}
                hint={t("Leave empty to use the site's. It replaces the site's limit for members who follow it; someone in several groups gets the highest")}
              />
              {error && <Advisory>{error}</Advisory>}
              <div className="form-page-actions">
                <BusyButton type="submit" className="btn-primary" busy={busy} disabled={!name.trim()}>
                  {adding ? t("Add group") : t("Save")}
                </BusyButton>
                <SlideLink to="/admin/groups" direction="back" className="btn-secondary">
                  {t("Cancel")}
                </SlideLink>
              </div>
            </form>
            {!adding && (
              <div className="settings-danger">
                <DangerRow
                  label={t("Delete this group")}
                  confirmLabel={t("Delete this group? Its people stay, without what it opened")}
                  onConfirm={async () => {
                    await api.del(`/admin/groups/${id}`);
                    slideTo("/admin/groups", "back", { replace: true });
                  }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
