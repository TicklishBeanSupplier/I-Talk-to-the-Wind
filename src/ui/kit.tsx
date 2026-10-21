// Small shared building blocks used by every screen.
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { PersonRef, PlatformId } from "../core/types";
import { PLATFORM_LABEL } from "../core/types";
import { errorMessage } from "../platforms/types";
import { dismissToast, toast, useApp } from "../app/store";

// ---------- Icons (inline, stroke-based, decorative) ----------

const paths = {
  pen: "M4 20h4L19 9l-4-4L4 16v4z",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  sliders: "M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4",
  back: "M15 6l-6 6 6 6",
  out: "M7 17L17 7M9 7h8v8",
  x: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  copy: "M9 9h10v10H9zM5 15V5h10",
  clock: "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  check: "M5 12l5 5L20 7",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

// ---------- Buttons ----------

type Variant = "primary" | "accent" | "soft" | "ghost" | "danger" | "on-panel" | "on-panel-soft";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  small?: boolean;
  busy?: boolean;
  icon?: IconName;
}

export function Btn({ variant = "soft", small, busy, icon, children, className, disabled, ...rest }: BtnProps) {
  return (
    <button type="button" className={`btn ${variant}${small ? " sm" : ""}${className ? ` ${className}` : ""}`} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <span className="spin" aria-hidden="true" /> : icon ? <Icon name={icon} size={small ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/**
 * Run an async action with a busy flag; errors become a toast.
 * Returns true if it succeeded, so callers can clear a text box only then.
 */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(key);
    try {
      await fn();
      if (success) toast(success, "success");
      return true;
    } catch (err) {
      toast(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, run };
}

// ---------- Display ----------

export function PlatformChip({ platform, children }: { platform: PlatformId; children?: ReactNode }) {
  return <span className={`chip ${platform}`}>{children ?? PLATFORM_LABEL[platform]}</span>;
}

export function initials(name: string): string {
  const parts = name.replace(/[@._-]+/g, " ").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Avatar({ person, url, size = 40 }: { person: Pick<PersonRef, "name">; url?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.36 }} aria-hidden="true">
      {url && !failed ? <img src={url} alt="" onError={() => setFailed(true)} /> : initials(person.name)}
    </span>
  );
}

/** An image that degrades to a quiet placeholder if it can't load. */
export function Thumb({ src, alt, size, width, height, className = "" }: { src?: string; alt: string; size?: number; width?: number | string; height?: number | string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const style = { width: width ?? size, height: height ?? size };
  if (!src || failed) return <span className={`thumb ph ${className}`} style={style} role="img" aria-label={alt} />;
  return <img className={`thumb ${className}`} src={src} alt={alt} style={style} loading="lazy" onError={() => setFailed(true)} />;
}

export function Progress({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label, tone }: {
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
  label: string;
  tone?: PlatformId;
}) {
  return (
    <div className={`seg${tone ? ` ${tone}` : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2 className="h1">{title}</h2>
      {children}
    </div>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <span style={{ flex: 1 }}>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Re-render every `ms` so relative times ("in 3 h") stay current. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export const fmtCount = (n?: number) =>
  n === undefined ? "–" : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}K` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
