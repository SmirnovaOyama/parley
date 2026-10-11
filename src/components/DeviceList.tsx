import { useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Device } from "../lib/api.ts";
import { atOrOn } from "../lib/format.ts";
import { t } from "../lib/i18n.ts";
import { BusyButton } from "./BusyButton.tsx";

/** When and where a device was last used, and when it signed in, as a sentence. */
export function deviceText(d: Device): string {
  // Whole sentences with and without the address, so each reads right translated.
  const vars = { address: d.address ?? "", signedInAt: atOrOn(d.signedInAt), lastSeenAt: d.lastSeenAt ? atOrOn(d.lastSeenAt) : "" };
  if (d.current) return d.address ? t("In use now from {address}. Signed in {signedInAt}", vars) : t("In use now. Signed in {signedInAt}", vars);
  if (!d.lastSeenAt) return t("Signed in {signedInAt}", vars);
  if (d.lastSeenAt === d.signedInAt) return d.address ? t("Signed in {signedInAt} from {address}", vars) : t("Signed in {signedInAt}", vars);
  return d.address ? t("Last used {lastSeenAt} from {address}. Signed in {signedInAt}", vars) : t("Last used {lastSeenAt}. Signed in {signedInAt}", vars);
}

/**
 * The devices someone is signed in on, each with a button that signs it out. One used by a program
 * rather than a browser says so: someone's sign-in in a script, which can pass the site's keys on.
 */
export function DeviceList({ devices, onSignOut }: { devices: Device[]; onSignOut: (d: Device) => Promise<void> }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="oy-section">
      {devices.map((d) => (
        <div key={d.id} className="oy-row">
          <Icon name="devices" size={20} />
          <div className="text">
            <p className="title truncate">
              {d.device}
              {d.current && <span className="tag is-accent">{t("This device")}</span>}
              {!d.browser && <span className="tag is-warning">{t("Not a browser")}</span>}
            </p>
            <div className="desc">{deviceText(d)}</div>
          </div>
          <BusyButton
            type="button"
            className="btn-secondary btn-sm"
            busy={busy === d.id}
            disabled={busy !== null && busy !== d.id}
            onClick={async () => {
              setBusy(d.id);
              try {
                await onSignOut(d);
              } finally {
                setBusy(null);
              }
            }}
          >
            {t("Sign out")}
          </BusyButton>
        </div>
      ))}
    </div>
  );
}
