import type { InputHTMLAttributes, Ref, ReactNode, TextareaHTMLAttributes } from "react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";
import { MENU_SURFACE } from "./ContextMenu";
import { Icon, type IconName } from "./Icon";

const control =
  "w-full rounded-control border border-line bg-fill px-3 text-body " +
  "text-text-hi placeholder:text-text-lo transition-colors duration-[var(--motion-fast)] " +
  "ease-[var(--ease-state)] hover:border-line-strong focus:border-accent/60";

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  /**
   * Handed to the `input` itself, so a caller can focus the box.
   *
   * Declared rather than inherited: React 19 passes `ref` to a function
   * component as an ordinary prop, but `InputHTMLAttributes` does not carry
   * it, so without this the spread below would drop it silently.
   */
  ref?: Ref<HTMLInputElement>;
  /** §7.1 component rules: the label sits above the input, never floating. */
  label: string;
  hint?: string;
  error?: string;
  icon?: IconName;
  /**
   * Hides the label visually but keeps it for screen readers. For search boxes
   * in chrome, where a printed label is noise and the placeholder plus the
   * magnifier already say what the control is.
   */
  hideLabel?: boolean;
}

export function Field({
  label,
  hint,
  error,
  icon,
  hideLabel = false,
  className,
  ...rest
}: FieldProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className={cn(
          "text-text-mid text-meta font-medium",
          hideLabel && "sr-only",
        )}
      >
        {label}
      </label>
      <div className="relative">
        {icon ? (
          <Icon
            name={icon}
            size={16}
            className="text-text-lo pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
          />
        ) : null}
        <input
          id={id}
          className={cn(control, "h-9", icon && "pl-9", error && "border-danger/60", className)}
          aria-invalid={error ? true : undefined}
          {...rest}
        />
      </div>
      {error ? (
        <p className="text-danger text-meta">{error}</p>
      ) : hint ? (
        <p className="text-text-lo text-meta">{hint}</p>
      ) : null}
    </div>
  );
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: string;
}

export function TextArea({ label, hint, className, ...rest }: TextAreaProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-text-mid text-meta font-medium">
        {label}
      </label>
      <textarea id={id} className={cn(control, "resize-none py-2.5", className)} {...rest} />
      {hint ? <p className="text-text-lo text-meta">{hint}</p> : null}
    </div>
  );
}

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, description, disabled }: ToggleProps) {
  return (
    <label
      className={cn(
        "flex items-start justify-between gap-6 py-2.5",
        disabled && "opacity-45",
      )}
    >
      <span className="flex flex-col gap-0.5">
        <span className="text-text-hi text-body">{label}</span>
        {description ? (
          <span className="text-text-mid text-meta leading-relaxed">{description}</span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
          checked ? "bg-accent" : "bg-surface-3 border border-line",
        )}
      >
        <span
          className={cn(
            // The knob slides on `transform`, not on `left`. Both look the
            // same at rest; only one of them animates without asking the
            // browser to lay the page out again on every frame, which is
            // what made this particular switch judder.
            "absolute top-1/2 left-[3px] size-4.5 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-line-strong transition-transform duration-[var(--motion-fast)] ease-[var(--ease-state)]",
            checked ? "translate-x-[19px]" : "translate-x-0",
          )}
        />
      </button>
    </label>
  );
}

export interface TabsProps<T extends string> {
  tabs: { id: T; label: string; icon?: IconName }[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A one-of-many chooser, drawn by the app rather than by Windows.
 *
 * # Why this exists instead of `<select>`
 *
 * The window is transparent, so the desktop can show through it. A native
 * `<select>` does not draw its own list -- the browser hands that to the
 * platform, and on a transparent window the list arrives with **no background
 * at all**: four lines of text floating over whatever happens to be behind the
 * app, unreadable. It is the one control in the app whose appearance was never
 * ours to decide, and the transparency took it away.
 *
 * So the list is an element like any other, on the same opaque surface every
 * other menu uses (`MENU_SURFACE`), and the tokens decide how it looks.
 *
 * # What it keeps from the native one
 *
 * A `<select>` is a real widget, not a button: it can be opened from the
 * keyboard, walked with the arrow keys, closed with Escape, and it tells a
 * screen reader what it is. Replacing it means owning all of that -- otherwise
 * the fix trades an unreadable control for an unusable one. Hence
 * `role="listbox"`, roving `aria-selected`, and Home/End.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (next: T) => void;
  /** Read by screen readers. The visible label is the caller's business. */
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState({ left: 0, top: 0, minWidth: 0 });
  const listId = useId();

  const current = options.find((option) => option.value === value);

  // Positioned against the button, in viewport coordinates, because the list is
  // portalled out of whatever transformed ancestor the caller sits in. Measured
  // before paint so it never flashes in the wrong place, and flipped above the
  // button when it would fall off the bottom.
  useLayoutEffect(() => {
    if (!open) return;
    const anchor = button.current?.getBoundingClientRect();
    if (!anchor) return;
    const height = list.current?.getBoundingClientRect().height ?? 0;
    const below = anchor.bottom + 6;
    const fits = below + height + 8 <= window.innerHeight;
    setAt({
      left: anchor.left,
      top: fits ? below : Math.max(8, anchor.top - height - 6),
      minWidth: anchor.width,
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.findIndex((option) => option.value === value)));
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (list.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    // Both removed on close. An anonymous handler here cannot be, and every
    // open would leave one more behind.
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
    button.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      // The keys that open a native select, doing what they do there.
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(options.length - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const picked = options[active];
      if (picked) choose(picked.value);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={label}
        onClick={() => setOpen((was) => !was)}
        onKeyDown={onKeyDown}
        className={cn(
          "rounded-control text-text-hi flex h-9 items-center gap-2 border border-line bg-fill px-3 text-body",
          "transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:border-line-strong",
          className,
        )}
      >
        <span className="flex-1 text-left">{current?.label ?? value}</span>
        <Icon
          name="chevronLeft"
          size={14}
          className={cn(
            "text-text-lo shrink-0 transition-transform duration-[var(--motion-fast)] ease-[var(--ease-state)]",
            open ? "rotate-90" : "-rotate-90",
          )}
        />
      </button>

      {open
        ? createPortal(
            <div
              ref={list}
              role="listbox"
              id={listId}
              aria-label={label}
              // Focus stays on the button while this is open, which is what
              // keeps one keydown handler responsible for the whole widget.
              style={{ left: at.left, top: at.top, minWidth: at.minWidth, zIndex: 400 }}
              className={cn(MENU_SURFACE, "fixed")}
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => choose(option.value)}
                  className={cn(
                    "rounded-control flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left text-meta transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                    index === active ? "bg-fill-hover text-text-hi" : "text-text-mid",
                  )}
                >
                  {/* The tick holds its column whether or not it is drawn, so
                      the labels do not shift as the selection moves. */}
                  <Icon
                    name="check"
                    size={14}
                    className={cn("shrink-0", option.value === value ? "text-accent" : "opacity-0")}
                  />
                  {option.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

export function Tabs<T extends string>({ tabs, active, onChange, className }: TabsProps<T>) {
  return (
    <div role="tablist" className={cn("flex items-center gap-1", className)}>
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            role="tab"
            type="button"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className={cn(
              "group rounded-control relative flex items-center gap-2 px-3 py-2 text-body outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)] focus-visible:ring-1 focus-visible:ring-accent",
              selected ? "text-text-hi font-medium" : "text-text-mid hover:text-text-hi",
            )}
          >
            {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
            {tab.label}
            {/* One underline in three states rather than a filled box on hover
                and a line when selected. Hovering previews where the indicator
                will land; the old version promised a rounded shape that never
                appeared, which is why it read as wrong. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-x-3 -bottom-px h-0.5 rounded-full transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                selected ? "bg-accent" : "bg-transparent group-hover:bg-accent/40",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** A row of static, read-only facts — join date, numeric ID, epoch. */
export function FactRow({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <Icon name={icon} size={16} className="text-text-lo shrink-0" />
      <span className="text-text-mid text-meta w-28 shrink-0">{label}</span>
      <span className="text-text-hi text-meta">{children}</span>
    </div>
  );
}
