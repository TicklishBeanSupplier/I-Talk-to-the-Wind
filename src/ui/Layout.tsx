import type { ReactNode } from "react";
import { navigate, useApp, type Route } from "../app/store";
import { Icon } from "./kit";

const TABS: { screen: Route["screen"]; label: string }[] = [
  { screen: "studio", label: "Studio" },
  { screen: "inbox", label: "Inbox" },
  { screen: "work", label: "Work" },
];

function Nav() {
  const screen = useApp((s) => s.route.screen);
  const open = useApp((s) => s.inbox.reduce((n, i) => n + (i.status === "open" ? 1 : 0), 0));
  // A person page belongs to the inbox flow.
  const active = screen === "person" ? "inbox" : screen;
  return (
    <nav className="nav" aria-label="Main">
      <span className="brand">CONDUIT</span>
      {TABS.map((t) => (
        <button key={t.screen} type="button" aria-current={active === t.screen ? "page" : undefined} onClick={() => navigate({ screen: t.screen } as Route)}>
          {t.label}
          {t.screen === "inbox" && open > 0 && <span className="count">{open}</span>}
        </button>
      ))}
      <button type="button" className="nav-icon" aria-label="Settings" title="Settings" aria-current={active === "settings" ? "page" : undefined} onClick={() => navigate({ screen: "settings" })}>
        <Icon name="sliders" size={18} />
      </button>
    </nav>
  );
}

/** The Rime split: blue rail on the left, snow stage on the right. */
export function Layout({ rail, children, label }: { rail: ReactNode; children: ReactNode; label: string }) {
  const preview = useApp((s) => s.rt?.kind === "preview");
  return (
    <div className="app">
      <aside className="rail" aria-label={`${label} list`}>
        <Nav />
        {preview && <p className="preview-banner">Preview mode · sample data, nothing is posted</p>}
        {rail}
      </aside>
      <main className="stage" aria-label={label}>
        {children}
      </main>
    </div>
  );
}
