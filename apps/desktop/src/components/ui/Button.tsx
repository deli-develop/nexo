import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Icon, type IconName } from "./Icon";

type Variant = "primary" | "secondary" | "ghost" | "danger";

/**
 * Three states, not two, and `enabled:` on every one of them.
 *
 * A control needs a resting state, a state that says the pointer is on it, and
 * a state that says it is being pressed. This had two: rest, and a hover that
 * jumped straight to the strongest fill in the ladder, leaving the press with
 * nowhere to go and a 1px nudge doing all the work on its own. The nudge was
 * on every variant including `ghost`, which is a text label with no body to
 * depress -- so pressing it made the words slide.
 *
 * `enabled:` rather than `pointer-events-none`. Killing pointer events was how
 * a disabled button avoided its own hover styles, and it also killed the
 * cursor, so the one control that most needs to say "not now" showed a plain
 * arrow. Guarding each interactive state instead leaves the button pointing at
 * `not-allowed` and still able to carry a `title`.
 */
const base =
  "inline-flex items-center justify-center gap-2 rounded-control font-medium " +
  "transition-[background-color,border-color,color,box-shadow,transform] " +
  "duration-[var(--motion-fast)] ease-[var(--ease-state)] " +
  "disabled:cursor-not-allowed disabled:shadow-none disabled:text-text-disabled";

const variants: Record<Variant, string> = {
  // §7.1: the accent is the outgoing bubble and the primary action. It is used
  // sparingly enough that it still means "this one".
  //
  // The glow arrives with the pointer and leaves under the press. At rest this
  // button is a flat block of accent, which is what the token file means by a
  // screen with nothing happening on it having no colour to spare; the light
  // underneath is the answer to being touched, and it going out is what makes
  // the press read as the button moving *into* the surface rather than just
  // down a pixel.
  primary:
    "bg-accent text-on-accent " +
    "enabled:hover:bg-accent-soft enabled:hover:shadow-[var(--shadow-accent)] " +
    "enabled:active:translate-y-px enabled:active:shadow-none " +
    "disabled:bg-fill-disabled",
  // The full ladder of the neutral fills: 4% at rest, 7% under the pointer,
  // 11% under the press. It used to spend 11% on the hover and had nothing
  // left to say afterwards.
  secondary:
    "border border-line-strong bg-fill text-text-hi " +
    "enabled:hover:bg-fill-hover enabled:active:bg-fill-active " +
    "enabled:active:translate-y-px " +
    "disabled:border-line disabled:bg-fill-disabled",
  // No border, no fill, no body -- so no movement on press either. What it has
  // to give is its own text: mid at rest, full strength once the pointer
  // arrives, which is the whole gesture.
  ghost:
    "text-text-mid " +
    "enabled:hover:bg-fill-hover enabled:hover:text-text-hi " +
    "enabled:active:bg-fill-active",
  // The one place a border earns a response of its own: a destructive action
  // should firm up as you approach it, not merely tint.
  danger:
    "border border-danger/40 text-danger " +
    "enabled:hover:border-danger/70 enabled:hover:bg-danger/12 " +
    "enabled:active:bg-danger/20 enabled:active:translate-y-px " +
    "disabled:border-line disabled:bg-fill-disabled",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  icon?: IconName;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  icon,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cn(base, variants[variant], "h-9 px-3.5 text-body", className)}
      {...rest}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  name: IconName;
  /**
   * Required, not optional. §7.4 puts screen-reader labels on icon-only
   * buttons in the quality floor, and a required prop is the only way that
   * survives contact with a deadline.
   */
  label: string;
  size?: number;
  variant?: Variant;
  active?: boolean;
}

/**
 * A pressed toggle keeps its accent while the pointer is on it.
 *
 * The active tint used to be appended after the variant, so the variant's own
 * hover -- a neutral fill -- overrode it: hovering an *on* toggle turned it
 * grey, which reads as switching off. An engaged control deepens when you
 * touch it; it does not let go.
 */
export function IconButton({
  name,
  label,
  size = 18,
  variant = "ghost",
  active = false,
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={cn(
        base,
        active
          ? "bg-accent/16 text-accent-soft enabled:hover:bg-accent/24 enabled:active:bg-accent/32"
          : variants[variant],
        "size-9 shrink-0",
        className,
      )}
      {...rest}
    >
      <Icon name={name} size={size} />
    </button>
  );
}
