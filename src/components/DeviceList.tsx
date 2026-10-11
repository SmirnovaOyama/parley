import { useState } from "react";
import { Icon } from "../icons/Icon.tsx";
import type { Device } from "../lib/api.ts";
import { atOrOn } from "../lib/format.ts";
import { BusyButton } from "./BusyButton.tsx";

/** When and where a device was last used, and when it signed in, as a sentence. */
export function deviceText(d: Device): string {
  const from = d.address ? ` from ${d.address}` : "";
  if (d.current) return `In use now${from}. Signed in ${atOrOn(d.signedInAt)}`;
  if (!d.lastSeenAt) return `Signed in ${atOrOn(d.signedInAt)}`;
  if (d.lastSeenAt === d.signedInAt) return `Signed in ${atOrOn(d.signedInAt)}${from}`;
  return `Last used ${atOrOn(d.lastSeenAt)}${from}. Signed in ${atOrOn(d.signedInAt)}`;
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
              {d.current && <span className="tag is-accent">This device</span>}
              {!d.browser && <span className="tag is-warning">Not a browser</span>}
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
            Sign out
          </BusyButton>
        </div>
      ))}
    </div>
  );
}
