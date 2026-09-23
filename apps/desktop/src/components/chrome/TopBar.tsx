import type { ReactNode } from "react";
import { useLayout } from "../../app/useLayout";
import { windowAction } from "../../app/useWindow";
import { cn } from "../../lib/cn";
import { inTauri } from "../../lib/runtime";
import { BrandMark } from "../ui/BrandMark";
import { Icon, type IconName } from "../ui/Icon";

/**
 * One top row across the whole app (§7.3).
 *
 * The references put the wordmark, the account, the conversation header and
 * the panel actions on a single line, with the column hairlines running
 * straight through it. That is what makes the window read as one surface
 * rather than as three stacked panels, so the titlebar is not a separate strip
 * above the app — it *is* this row, with the Windows caption buttons at its
 * right end.
 *
 * Everything but the caption buttons is drag region.
 *
 * **The caption buttons exist only in the Tauri build.** A browser tab already
 * has a titlebar, drawn by the browser, and a second set of minimise and close
 * buttons underneath it is three controls that cannot do what they say — the
 * window is not this page's to move or close. The bar itself stays: it is the
 * app's top row, not a titlebar, and the wordmark and the page header live in
 * it on every host.
 */
// `children` is optional: before there is an account there is no page header
// to put in the bar, but the bar itself still has to exist, because a
// frameless window with no titlebar cannot be moved or closed.
export function TopBar({
  children,
  maximized,
}: {
  children?: ReactNode;
  maximized: boolean;
}) {
  const layout = useLayout();
  // The mark's cell is the rail's width, and its hairline is the rail's edge
  // carried up into this row. A phone has no rail, so the cell had nothing to
  // line up with and cost a sixth of the row — the conversation's title was
  // what paid for it. Before there is an account there is nothing else in
  // the row, so it stays there.
  const mark = !(layout.phone && children);

  return (
    <header className="drag-region glass-1 flex h-[60px] shrink-0 items-stretch border-b border-[var(--hairline)]">
      {mark ? (
        <div className="flex w-16 shrink-0 items-center justify-center border-r border-[var(--hairline)]">
          {/* The mark, not a logo lockup: one letter and a full stop. Drawn as
              paths rather than typeset, because no font is bundled and the
              display face fell through to whatever the OS had — see
              `BrandMark`. */}
          <BrandMark className="text-text-hi" />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 items-stretch">{children}</div>

      {inTauri() ? (
        <div className="no-drag flex shrink-0 items-stretch">
          <CaptionButton
            name="minus"
            label="Minimise"
            onClick={() => void windowAction("minimize")}
          />
          <CaptionButton
            name={maximized ? "restore" : "maximize"}
            label={maximized ? "Restore down" : "Maximise"}
            onClick={() => void windowAction("toggleMaximize")}
          />
          <CaptionButton
            name="close"
            label="Close"
            danger
            onClick={() => void windowAction("close")}
          />
        </div>
      ) : null}
    </header>
  );
}

function CaptionButton({
  name,
  label,
  onClick,
  danger = false,
}: {
  name: IconName;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "text-text-mid flex w-[46px] items-center justify-center transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
        danger ? "hover:bg-danger hover:text-white" : "hover:bg-fill-active hover:text-text-hi",
      )}
    >
      <Icon name={name} size={name === "close" ? 15 : 13} />
    </button>
  );
}

/** The plain header a page without its own chrome gets: just a title. */
export function PageTitleCell({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-between px-6">
      <h1 className="font-display text-text-hi text-title font-semibold tracking-[-0.01em]">
        {title}
      </h1>
      {actions ? <div className="no-drag flex items-center gap-0.5">{actions}</div> : null}
    </div>
  );
}
