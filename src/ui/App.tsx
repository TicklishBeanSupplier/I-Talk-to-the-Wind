import { useEffect, useState } from "react";
import { init, scanOutboxNow, tick, updateSettings, useApp } from "../app/store";
import { errorMessage } from "../platforms/types";
import type { Runtime } from "../runtime/types";
import { Toasts } from "./kit";
import { InboxScreen } from "./screens/Inbox";
import { PersonScreen } from "./screens/Person";
import { SettingsScreen } from "./screens/Settings";
import { StudioScreen } from "./screens/Studio";
import { WorkScreen } from "./screens/Work";

const OUTBOX_SCAN_MS = 5_000;

export function App({ createRuntime }: { createRuntime: () => Promise<Runtime> }) {
  const ready = useApp((s) => s.ready);
  const route = useApp((s) => s.route);
  const season = useApp((s) => s.settings.season);
  const [fatal, setFatal] = useState<string | null>(null);

  // Start once. (StrictMode runs effects twice in development; the guard keeps it single.)
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    if (useApp.getState().rt) return;
    createRuntime()
      .then(async (rt) => {
        if (cancelled) return;
        await init(rt);
        if (rt.kind === "preview" && !useApp.getState().settings.outboxPath) {
          updateSettings({ outboxPath: (await import("../runtime/preview")).PREVIEW_OUTBOX });
        }
        const onWake = () => {
          void tick();
          void scanOutboxNow();
        };
        const offResume = rt.onResume(onWake);
        // New exports should appear quickly while the window is in use.
        const scan = setInterval(() => document.visibilityState === "visible" && void scanOutboxNow(), OUTBOX_SCAN_MS);
        onWake();
        stop = () => {
          offResume();
          clearInterval(scan);
        };
      })
      .catch((err) => setFatal(errorMessage(err)));
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [createRuntime]);

  useEffect(() => {
    document.documentElement.dataset.season = season;
  }, [season]);

  if (fatal) {
    return (
      <div className="app" style={{ display: "grid", placeItems: "center", color: "var(--on-panel)" }}>
        <div className="col" style={{ maxWidth: 460, textAlign: "center" }}>
          <h1 className="h1">Conduit couldn't start</h1>
          <p>{fatal}</p>
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="app" style={{ display: "grid", placeItems: "center", color: "var(--on-panel)" }}>
        <span className="spin" aria-label="Loading" />
      </div>
    );
  }

  return (
    <>
      {route.screen === "studio" && <StudioScreen draftId={route.draftId} />}
      {route.screen === "inbox" && <InboxScreen itemId={route.itemId} />}
      {route.screen === "work" && <WorkScreen selectedKey={route.key} />}
      {route.screen === "person" && <PersonScreen person={route.person} />}
      {route.screen === "settings" && <SettingsScreen />}
      <Toasts />
    </>
  );
}
