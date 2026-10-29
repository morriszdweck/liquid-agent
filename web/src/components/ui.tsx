// Small building blocks shared by every screen.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cx } from "../util";

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Working" />;
}

export function IconButton({
  label,
  onClick,
  children,
  active,
  className,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button type="button" className={cx("icon-btn", active && "active", className)} onClick={onClick} title={label} aria-label={label} disabled={disabled}>
      {children}
    </button>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={cx("toggle", checked && "on")} onClick={() => onChange(!checked)}>
      <span />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size,
}: {
  value: T;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  onChange: (v: T) => void;
  size?: "sm";
}) {
  return (
    <div className={cx("segmented", size)} role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={cx(o.value === value && "selected")} onClick={() => onChange(o.value)}>
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export type MenuItem = { label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hint?: string; detail?: string; checked?: boolean } | "divider";

/** A dropdown that opens from its trigger and closes on outside click or Escape. */
export function Menu({
  trigger,
  items,
  align = "left",
  side = "bottom",
  width,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  items: MenuItem[] | ((close: () => void) => ReactNode);
  align?: "left" | "right";
  side?: "bottom" | "top";
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const close = () => setOpen(false);
  return (
    <div className="menu-anchor" ref={ref}>
      {trigger(open, () => setOpen(!open))}
      {open && (
        <div className={cx("menu", `align-${align}`, `side-${side}`)} style={width ? { width } : undefined} role="menu">
          {typeof items === "function"
            ? items(close)
            : items.map((item, i) =>
                item === "divider" ? (
                  <div key={i} className="menu-divider" />
                ) : (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    className={cx("menu-item", item.danger && "danger")}
                    onClick={() => {
                      close();
                      item.onClick();
                    }}
                  >
                    {item.icon}
                    <span className="menu-text">
                      <span className="menu-label">{item.label}</span>
                      {item.detail && <span className="menu-detail">{item.detail}</span>}
                    </span>
                    {item.hint && <span className="menu-hint">{item.hint}</span>}
                    {item.checked && <span className="menu-check">✓</span>}
                  </button>
                ),
              )}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, footer }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean; footer?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx("modal", wide && "wide")} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Progress({ value }: { value?: number }) {
  return (
    <div className={cx("progress", value === undefined && "indeterminate")}>
      <span style={value === undefined ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "busy" | "off" | "bad" }) {
  return <span className={cx("status-dot", tone)} />;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}
