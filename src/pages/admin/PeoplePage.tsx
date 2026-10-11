import { useEffect, useState } from "react";
import { Advisory, Spinner } from "../../components/Feedback.tsx";
import { Icon } from "../../icons/Icon.tsx";
import { api } from "../../lib/api.ts";
import { compactNumber, formatCost, formatNumber, plural } from "../../lib/format.ts";
import { t, tn } from "../../lib/i18n.ts";
import { useSession } from "../../lib/session.tsx";
import { useSlideNavigate } from "../../lib/slide.ts";

export type Person = {
  id: number;
  email: string;
  role: "admin" | "user";
  apiKeyId: number | null;
  keyIds: number[];
  /** The groups they're in. */
  groupIds?: number[];
  keyLabel: string | null;
  monthlyTokenLimit: number | null;
  /** Whose spending limit they follow; their own amount is kept while they follow another. */
  spendLimitMode: "site" | "own" | "none";
  monthlySpendLimit: number | null;
  /** The dollars they may spend this month before any reward; null for no limit. */
  spendLimit: number | null;
  spentThisMonth: number;
  disabled: boolean;
  tokensThisMonth: number;
  conversations: number;
  /** An address they proved they own, and whether it still earns the email reward. */
  bonusEmail: string | null;
  bonusActive: boolean;
  bonusTokens: number | null;
  bonusSpend: number | null;
  /** How many devices they're signed in on, the networks this week's were used from, and how many are programs, not browsers. */
  devices: number;
  networks: number;
  programs: number;
  /** Their two-step verification: on or off, with an app, and how many passkeys. */
  twoStep: { on: boolean; totp: boolean; passkeys: number };
};

/** From this many devices on, the list says how many: more than one person has, say a phone and a laptop. */
const MANY_DEVICES = 3;

/** The limit they're held to this month with the reward added, or null for none. */
const spendCap = (p: Person) => (p.spendLimit == null ? null : p.spendLimit + (p.bonusSpend ?? 0));
const tokenCap = (p: Person) => (p.monthlyTokenLimit == null ? null : p.monthlyTokenLimit + (p.bonusTokens ?? 0));

export function PeoplePage() {
  const { user: me } = useSession();
  const slideTo = useSlideNavigate();
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ users: Person[] }>("/admin/users").then(
      (r) => setPeople(r.users),
      (err) => setError((err as Error).message),
    );
  }, []);

  if (error) return <Advisory>{error}</Advisory>;
  if (!people) return <Spinner />;

  return (
    <>
      <div className="admin-toolbar">
        <p className="text-muted">{plural(people.length, "person", "people")}</p>
        <button type="button" className="btn-ghost is-accent" onClick={() => slideTo("/admin/people/new", "forward")}>
          <Icon name="plus" size={16} />
          {t("Add a person")}
        </button>
      </div>
      <div className="oy-section is-plain">
        {people.map((p) => {
          const spendLimit = spendCap(p);
          const tokenLimit = tokenCap(p);
          const atLimit = (spendLimit != null && p.spentThisMonth >= spendLimit) || (tokenLimit != null && p.tokensThisMonth >= tokenLimit);
          return (
            <button key={p.id} type="button" className="oy-row" onClick={() => slideTo(`/admin/people/${p.id}`, "forward")}>
              <div className="text">
                <p className="title truncate">
                  {p.email}
                  {p.id === me?.id && <span className="tag">{t("You")}</span>}
                  {p.role === "admin" && <span className="tag is-accent">{t("Admin")}</span>}
                  {p.disabled && <span className="tag is-warning">{t("Off")}</span>}
                  {!p.disabled && atLimit && <span className="tag is-warning">{t("At limit")}</span>}
                  {p.bonusActive && <span className="tag">{t("Verified")}</span>}
                  {p.devices >= MANY_DEVICES && <span className="tag">{plural(p.devices, "device", "devices")}</span>}
                  {p.programs > 0 && <span className="tag is-warning">{t("Not a browser")}</span>}
                </p>
                <div className="desc">
                  {t("Spent {spentThisMonth}", { spentThisMonth: formatCost(p.spentThisMonth) })}
                  {spendLimit != null && ` ${t("of {spendLimit}", { spendLimit: formatCost(spendLimit) })}`}
                  {tokenLimit != null &&
                    ` ${t("and {tokensThisMonth} of {tokenLimit} tokens", { tokensThisMonth: compactNumber(p.tokensThisMonth), tokenLimit: compactNumber(tokenLimit) })}`}{" "}
                  {t("this month and has")}{" "}
                  {p.conversations === 0
                    ? t("no chats yet")
                    : tn(p.conversations, "{conversations} chat in all", "{conversations} chats in all", { conversations: formatNumber(p.conversations) })}
                </div>
              </div>
              <Icon name="chevron-right" size={18} className="chevron" />
            </button>
          );
        })}
      </div>
    </>
  );
}
