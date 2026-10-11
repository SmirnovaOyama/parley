import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { DangerRow } from "../components/DangerRow.tsx";
import { DeviceList } from "../components/DeviceList.tsx";
import { Advisory, Spinner } from "../components/Feedback.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { api, type Device } from "../lib/api.ts";
import { plural } from "../lib/format.ts";
import { useSession } from "../lib/session.tsx";

type Sessions = { sessions: Device[]; limit: number | null };

/** How many devices, as the Settings page and this page's header say it. */
export function devicesText(devices: Device[]): string {
  const programs = devices.filter((d) => !d.browser).length;
  const count = devices.length === 1 ? "Only on this device" : `On ${plural(devices.length, "device", "devices")}`;
  if (!programs) return count;
  return `${count}, ${programs === 1 ? "one of them a program, not a browser" : `${programs} of them programs, not browsers`}`;
}

/**
 * Settings › Where you're signed in (/settings/devices): every browser and program signed in to this
 * account, where each was last used from, and signing any of them out.
 */
export function DevicesPage() {
  const { signOut } = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<Sessions | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<Sessions>("/auth/sessions").then(setData, (err) => setError((err as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const signOutOf = async (d: Device) => {
    setError(null);
    if (d.current) {
      await signOut();
      navigate("/login", { replace: true });
      return;
    }
    try {
      await api.del(`/auth/sessions/${d.id}`);
      setData((was) => was && { ...was, sessions: was.sessions.filter((x) => x.id !== d.id) });
    } catch (err) {
      setError((err as Error).message);
      void load();
    }
  };

  const others = data?.sessions.some((d) => !d.current);
  return (
    <>
      <PageHeader title="Where you're signed in" subtitle={data ? devicesText(data.sessions) : undefined} back={{ label: "Settings", to: "/settings" }} />
      <div className="oy-page-column page-body">
        {error && <Advisory>{error}</Advisory>}
        {!data ? (
          !error && <Spinner />
        ) : (
          <>
            <p className="group-intro">
              Every browser and program signed in to your account, which admins can see too. If you don't know one, sign it out and
              change your password
              {data.limit != null &&
                `. This site lets an account be signed in on ${plural(data.limit, "device", "devices")} at once, and signing in on one more signs out the one used longest ago`}
            </p>
            <DeviceList devices={data.sessions} onSignOut={signOutOf} />
            {others && (
              <DangerRow
                label="Sign out everywhere else"
                confirmLabel="Sign out every device but this one?"
                action="Sign out"
                onConfirm={async () => {
                  try {
                    await api.del("/auth/sessions");
                    setData((was) => was && { ...was, sessions: was.sessions.filter((d) => d.current) });
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
