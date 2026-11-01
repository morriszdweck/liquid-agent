// "Choose project" in the message box's bottom row: ties the chat to one folder, and the
// agent then works only inside it. Uses the system's folder picker, or a simple
// folder browser when there isn't one (Linux without zenity or kdialog).

import { useEffect, useState } from "react";
import { ChevronLeft, Folder, FolderOpen, FolderPlus, LogOut, X } from "lucide-react";
import { api } from "../api";
import { errorToast, useStore } from "../store";
import type { Chat } from "../types";
import { cx } from "../util";
import { Menu, Modal, Spinner } from "./ui";

const baseName = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const tilde = (p: string, home: string) => (home && p.startsWith(home) ? "~" + p.slice(home.length) : p);

type Listing = { path: string; display: string; parent: string | null; folders: string[] };

export function ProjectPicker({ chat }: { chat?: Chat }) {
  const draft = useStore((s) => s.draftProject);
  const busy = useStore((s) => (chat ? s.running.includes(chat.id) : false));
  const project = chat ? chat.project : draft;
  const [recent, setRecent] = useState<string[]>([]);
  const [home, setHome] = useState("");
  const [picking, setPicking] = useState(false);
  const [browse, setBrowse] = useState(false);

  async function loadRecent() {
    try {
      const r = await api<{ recent: string[] }>("GET", "/api/projects");
      setRecent(r.recent);
    } catch {
      // The list is only a shortcut.
    }
  }

  useEffect(() => {
    loadRecent();
    api<Listing>("GET", "/api/folders?path=~")
      .then((l) => setHome(l.path))
      .catch(() => {});
  }, []);

  async function use(path: string | null) {
    try {
      if (chat) await api("PATCH", `/api/chats/${chat.id}`, { project: path });
      else {
        if (path) await api("POST", "/api/projects/check", { path });
        useStore.setState({ draftProject: path });
      }
      loadRecent();
    } catch (e) {
      errorToast(e);
    }
  }

  async function choose() {
    if (picking) return;
    setPicking(true);
    try {
      const r = await api<{ path?: string | null; noPicker?: boolean }>("POST", "/api/projects/pick");
      if (r.noPicker) setBrowse(true);
      else if (r.path) await use(r.path);
    } catch (e) {
      errorToast(e);
    } finally {
      setPicking(false);
    }
  }

  const others = recent.filter((p) => p !== project).slice(0, 5);
  const label = project ? baseName(project) : "Choose project";

  return (
    <div className="project-pick">
      <Menu
        side="top"
        width={300}
        trigger={(open, toggle) => (
          <button
            type="button"
            className={cx("tray-btn", open && "active", project && "on")}
            onClick={() => (project || others.length ? toggle() : choose())}
            disabled={busy}
            title={project ? `The agent can only work in ${tilde(project, home)}` : "Limit the agent to one folder"}
          >
            {picking ? <Spinner size={14} /> : project ? <FolderOpen size={16} /> : <Folder size={16} />}
            <span>{label}</span>
          </button>
        )}
        items={[
          ...(project
            ? [
                {
                  label: baseName(project),
                  detail: `Only works in ${tilde(project, home)}`,
                  icon: <FolderOpen size={15} />,
                  checked: true,
                  onClick: () => {},
                },
                "divider" as const,
              ]
            : []),
          ...others.map((p) => ({ label: baseName(p), detail: tilde(p, home), icon: <Folder size={15} />, onClick: () => use(p) })),
          { label: project ? "Choose another folder…" : "Choose a folder…", icon: <FolderPlus size={15} />, onClick: choose },
          ...(project ? ["divider" as const, { label: "Leave project", detail: "Work anywhere again", icon: <LogOut size={15} />, onClick: () => use(null) }] : []),
        ]}
      />
      {project && (
        <button type="button" className="tray-x" onClick={() => use(null)} disabled={busy} aria-label="Leave project" title="Leave project">
          <X size={13} />
        </button>
      )}
      {browse && (
        <FolderBrowser
          start={project ?? "~"}
          onClose={() => setBrowse(false)}
          onPick={(p) => {
            setBrowse(false);
            use(p);
          }}
        />
      )}
    </div>
  );
}

function FolderBrowser({ start, onPick, onClose }: { start: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");

  async function open(path: string) {
    try {
      const l = await api<Listing>("GET", `/api/folders?path=${encodeURIComponent(path)}`);
      setListing(l);
      setTyped(l.display);
    } catch (e) {
      errorToast(e);
    }
  }
  useEffect(() => {
    open(start);
  }, [start]);

  return (
    <Modal
      title="Choose a project folder"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!listing} onClick={() => listing && onPick(listing.path)}>
            Use this folder
          </button>
        </>
      }
    >
      <form
        className="folder-path"
        onSubmit={(e) => {
          e.preventDefault();
          open(typed);
        }}
      >
        <button type="button" className="round-btn ghost" disabled={!listing?.parent} onClick={() => listing?.parent && open(listing.parent)} aria-label="Up one folder">
          <ChevronLeft size={16} />
        </button>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} aria-label="Folder path" />
      </form>
      <div className="folder-list">
        {!listing ? (
          <Spinner />
        ) : listing.folders.length ? (
          listing.folders.map((name) => (
            <button key={name} type="button" className="folder-row" onClick={() => open(`${listing.path}/${name}`)}>
              <Folder size={15} />
              <span>{name}</span>
            </button>
          ))
        ) : (
          <div className="folder-empty">No folders inside.</div>
        )}
      </div>
    </Modal>
  );
}
