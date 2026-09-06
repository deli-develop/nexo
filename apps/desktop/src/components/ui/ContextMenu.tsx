import type { ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/cn";
import { Icon, type IconName } from "./Icon";

/**
 * The floating surface every menu in the app is drawn on.
 *
 * Shared with `Select` rather than copied, because the one thing it must never
 * lose is its **opaque** background. The window is transparent
 * (`tauri.conf.json`), and anything the operating system draws on top of it --
 * a native `<select>` list, for one -- comes out with no background at all and
 * its text unreadable over whatever is behind. Every menu the app opens is
 * therefore its own element with its own fill, and this is that fill.
 */
export const MENU_SURFACE =
  "rounded-panel bg-surface-2 ring-line-strong p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.5)] ring-1";

/** One line in a menu. `separator` draws a rule and takes no action. */
export interface MenuItem {
  label: string;
  icon?: IconName;
  /** Destructive entries are red, and always sit last. */
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  separator?: boolean;
  /**
   * Entries that only appear once this one is chosen.
   *
   * For a choice that belongs to an action rather than beside it. Mute is the
   * case that asked for this: the four durations used to sit in the menu at
   * all times, which turned a two-line decision into a six-line one and put
   * the answer above the question. An item with a submenu still runs its own
   * `onSelect` if it has one, so "Mute" can mean "mute now" on click and
   * "mute for how long" on the arrow.
   */
  submenu?: MenuItem[];
}

/**
 * The app's own right-click menu.
 *
 * The browser's menu offers Reload, Inspect and Save image as — three things
 * that make a frameless app look like a web page in a frame. It is suppressed
 * globally in `main.tsx`; this is what takes its place where there is something
 * worth offering. Where there is not, nothing appears, which is the honest
 * outcome rather than a menu of greyed-out entries.
 *
 * Portalled, because `fixed` resolves against the nearest transformed ancestor
 * and the message list sits inside several. Flipped when it would fall off the
 * edge: a menu opened near the bottom right otherwise renders half off-screen.
 */
export function ContextMenu({
  items,
  at,
  onClose,
}: {
  items: MenuItem[];
  /** Where the pointer was, in viewport coordinates. */
  at: { x: number; y: number };
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(at);

  // Measured before paint, so it never appears in the wrong place first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.min(at.x, window.innerWidth - width - margin),
      y: Math.min(at.y, window.innerHeight - height - margin),
    });
  }, [at]);

  // Which entry has its submenu open, by index. One at a time: two flyouts
  // over each other is a puzzle, not a menu.
  const [openSub, setOpenSub] = useState<number | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Escape backs out one level at a time, which is what it does everywhere
      // else. Closing the whole menu from inside a submenu would throw away
      // the choice the person was halfway through making.
      if (openSub !== null) setOpenSub(null);
      else onClose();
    };
    // `pointerdown` rather than `click`: the menu should be gone by the time
    // the button is released, not after.
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose, openSub]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      style={{ left: position.x, top: position.y, zIndex: 400 }}
      className={cn(MENU_SURFACE, "fixed min-w-[176px]")}
    >
      {items.map((item, index) =>
        item.separator ? (
          <div
            key={`sep-${index}`}
            role="separator"
            className="my-1 h-px bg-[var(--hairline)]"
          />
        ) : (
          <MenuRow
            key={item.label}
            item={item}
            open={openSub === index}
            onOpenChange={(open) => setOpenSub(open ? index : null)}
            onClose={onClose}
          />
        ),
      )}
    </div>,
    document.body,
  );
}

const ROW_CLASS =
  "rounded-control flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-meta transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] disabled:cursor-not-allowed disabled:text-text-disabled";

function toneClass(danger: boolean | undefined): string {
  return danger
    ? "text-danger hover:bg-danger/12"
    : "text-text-mid hover:bg-fill-hover hover:text-text-hi";
}

/**
 * One entry, and its flyout if it has one.
 *
 * The flyout is a child of the menu rather than its own portal, so the
 * outside-click check in `ContextMenu` — `ref.current.contains(target)` —
 * keeps working without knowing submenus exist. It is `absolute` inside the
 * `fixed` menu, which is already a containing block.
 */
function MenuRow({
  item,
  open,
  onOpenChange,
  onClose,
}: {
  item: MenuItem;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
}) {
  const sub = item.submenu;
  const flyout = useRef<HTMLDivElement>(null);
  // Right of the entry, unless there is no room -- then left. Measured rather
  // than guessed: a menu opened near the right edge would otherwise put its
  // submenu off-screen, which is where the durations were needed most.
  const [side, setSide] = useState<"right" | "left">("right");

  useLayoutEffect(() => {
    if (!open) return;
    const el = flyout.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth - 8) setSide("left");
  }, [open]);

  if (!sub || sub.length === 0) {
    return (
      <button
        type="button"
        role="menuitem"
        disabled={item.disabled}
        onClick={() => {
          item.onSelect?.();
          onClose();
        }}
        className={cn(ROW_CLASS, toneClass(item.danger))}
      >
        {item.icon ? <Icon name={item.icon} size={14} /> : <span className="w-3.5" />}
        {item.label}
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={item.disabled}
        onClick={() => onOpenChange(!open)}
        className={cn(ROW_CLASS, toneClass(item.danger), open && "bg-fill-hover")}
      >
        {item.icon ? <Icon name={item.icon} size={14} /> : <span className="w-3.5" />}
        <span className="flex-1">{item.label}</span>
        <Icon name="chevron-right" size={13} className="text-text-lo -mr-1" />
      </button>
      {open ? (
        <div
          ref={flyout}
          role="menu"
          className={cn(
            MENU_SURFACE,
            "absolute top-0 z-10 min-w-[176px]",
            side === "right" ? "left-full ml-1" : "right-full mr-1",
          )}
        >
          {sub.map((entry) => (
            <button
              key={entry.label}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              onClick={() => {
                entry.onSelect?.();
                onClose();
              }}
              className={cn(ROW_CLASS, toneClass(entry.danger))}
            >
              {entry.icon ? (
                <Icon name={entry.icon} size={14} />
              ) : (
                <span className="w-3.5" />
              )}
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Wires a right-click on whatever it wraps to a menu of the given entries.
 *
 * Returning an empty list means "nothing to offer here", and nothing opens —
 * so a place with no actions falls back to no menu rather than an empty box.
 */
export function useContextMenu(build: () => MenuItem[]) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);

  const onContextMenu = useCallback(
    (event: React.MouseEvent) => {
      const next = build();
      if (next.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setItems(next);
      setAt({ x: event.clientX, y: event.clientY });
    },
    [build],
  );

  const menu: ReactNode =
    at === null ? null : <ContextMenu items={items} at={at} onClose={() => setAt(null)} />;

  return { onContextMenu, menu };
}
