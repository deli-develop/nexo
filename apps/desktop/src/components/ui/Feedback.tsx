import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { Icon, type IconName } from "./Icon";

/**
 * §6.2: an empty state invites the first action rather than apologising for
 * the emptiness. Icon, one line of what this place is for, one action.
 */
export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-8 py-16 text-center">
      <span className="text-accent-soft flex size-12 items-center justify-center rounded-full bg-fill-hover ring-1 ring-line-strong">
        <Icon name={icon} size={22} />
      </span>
      <h3 className="font-display text-text-hi text-title font-semibold">{title}</h3>
      <p className="text-text-mid max-w-[42ch] text-body leading-relaxed">{body}</p>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/** Shimmer at the size of the thing that is coming. No circular spinners. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-control", className)} />;
}

export function Pill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  className?: string;
}) {
  const tones = {
    neutral: "bg-fill-hover text-text-mid",
    accent: "bg-accent text-on-accent",
    success: "bg-success/16 text-success",
    warning: "bg-warning/16 text-warning",
    danger: "bg-danger/16 text-danger",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * The honesty banner. Rule 5 and §4.4 need one component that says what is and
 * is not protected, in plain language, wherever it applies — and it is the same
 * component every time so the wording cannot drift between screens.
 */
export function Callout({
  icon = "info",
  tone = "neutral",
  title,
  children,
  className,
}: {
  icon?: IconName;
  tone?: "neutral" | "warning" | "danger";
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "border-line bg-fill text-text-mid",
    warning: "border-warning/30 bg-warning/8 text-warning",
    danger: "border-danger/35 bg-danger/8 text-danger",
  } as const;
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-meta leading-relaxed",
        tones[tone],
        className,
      )}
    >
      <Icon name={icon} size={16} className="mt-0.5 shrink-0" />
      <span>
        {title ? <strong className="text-text-hi font-medium">{title} </strong> : null}
        {children}
      </span>
    </div>
  );
}
