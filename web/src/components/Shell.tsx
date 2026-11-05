// Pieces of the window frame: the bar along the top of each page, and toasts.

import { useEffect, useState, type ReactNode } from "react";
import { ChevronDown, Menu as MenuIcon, SquarePen, WifiOff } from "lucide-react";
import { go, useStore } from "../store";
import { cx } from "../util";
import { Logo } from "./Sidebar";
import { IconButton, Menu, type MenuItem } from "./ui";

export function TopBar({
  title,
  menu,
  onRename,
  center,
  right,
  pageTitle,
  brand,
}: {
  title?: string;
  menu?: MenuItem[];
  onRename?: (title: string) => void;
  center?: ReactNode;
  right?: ReactNode;
  /** Phones: the page's name, shown small in the bar once its big title scrolls away. */
  pageTitle?: string;
  /** Phones: the Liquid Agent logo in the middle of the bar. */
  brand?: boolean;
}) {
  const connected = useStore((s) => s.connected);
  const loaded = useStore((s) => s.loaded);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? "");
  useEffect(() => setValue(title ?? ""), [title]);

  const save = () => {
    setEditing(false);
    if (value.trim() && value !== title) onRename?.(value.trim());
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        <IconButton label="Open sidebar" className="mobile-only" onClick={() => useStore.setState({ sidebarOpen: true })}>
          <MenuIcon size={20} />
        </IconButton>
        {editing ? (
          <input
            className="topbar-rename"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : title && menu ? (
          <Menu
            trigger={(open, toggle) => (
              <button className={cx("topbar-title", "clickable", open && "active")} onClick={toggle}>
                <span>{title}</span>
                <ChevronDown size={14} />
              </button>
            )}
            items={[
              ...(onRename ? [{ label: "Rename", onClick: () => setEditing(true) } as MenuItem] : []),
              ...menu,
            ]}
          />
        ) : (
          title && <div className="topbar-title">{title}</div>
        )}
      </div>
      <div className="topbar-center">
        {center}
        {pageTitle && <div className="topbar-page-title phone-only">{pageTitle}</div>}
        {brand && (
          <div className="topbar-brand phone-only">
            <Logo size={21} />
          </div>
        )}
      </div>
      <div className="topbar-right">
        {loaded && !connected && (
          <span className="pill pill-bad">
            <WifiOff size={12} /> Reconnecting…
          </span>
        )}
        {right}
        <IconButton label="New chat" className="mobile-only" onClick={() => go("#/")}>
          <SquarePen size={20} />
        </IconButton>
      </div>
    </header>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx("toast", t.tone === "error" && "error")}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** A page with a top bar and a centered, scrolling column. */
export function Page({ title, right, children, wide }: { title: string; right?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className="page">
      <TopBar pageTitle={title} />
      <div className="page-scroll">
        <div className={cx("page-body", wide && "wide")}>
          <div className="page-head">
            <h1>{title}</h1>
            {right && <div className="page-actions">{right}</div>}
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}
