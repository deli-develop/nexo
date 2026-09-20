import { useEffect, useState } from "react";

/**
 * The three widths this app has, and the only place they are decided.
 *
 * ```
 *  < 768   phone     one pane at a time, bottom tab bar
 * >= 768   tablet    list and chat side by side, icon rail
 * >= 1280  desktop   and the 280px context panel as well
 * ```
 *
 * **Mobile-first, which is a change.** This used to read 860 and 1100 and to
 * describe a desktop shrinking: below 860 the conversation list turned into a
 * drawer that slid over the chat. That is a desktop pattern made narrow, not a
 * phone — on a phone the list *is* a screen and opening a conversation moves
 * you to another one. The numbers moved with the idea.
 *
 * They still cover Windows display scaling without a second mechanism: at 150%
 * a 1280px window reports about 853 CSS px, so a scaled-up display and a
 * narrow window take the same path through the layout.
 *
 * `matchMedia` rather than a resize listener. A resize handler runs on every
 * intermediate pixel while a window is being dragged and then compares two
 * booleans that changed once; a media query fires when the answer actually
 * changes. Same result, and none of the work in between.
 */
export interface Layout {
  /** One pane at a time, and the navigation is a bottom bar. */
  phone: boolean;
  /** The conversation list fits beside the conversation. */
  canShowList: boolean;
  /** And the 280px context panel fits beside that. */
  canShowContext: boolean;
}

/**
 * Where the layout changes, in one place.
 *
 * Content-driven rather than device-driven: 768 is where a 320px list and a
 * conversation both stop being usable side by side, and 1280 is where a third
 * 280px column stops squeezing the conversation below a readable measure.
 */
const LIST = "(min-width: 768px)";
const CONTEXT = "(min-width: 1280px)";

function read(): Layout {
  // SSR and the first paint of a test renderer: assume the roomiest case, so
  // nothing renders a phone shell and then jumps.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return { phone: false, canShowList: true, canShowContext: true };
  }
  const canShowList = window.matchMedia(LIST).matches;
  return {
    phone: !canShowList,
    canShowList,
    canShowContext: window.matchMedia(CONTEXT).matches,
  };
}

/**
 * The layout right now, for code that is not a component.
 *
 * `useShortcuts` needs it: a keyboard listener is not in a render pass and has
 * no hook to read. One synchronous `matchMedia` call is cheaper than putting
 * the layout into the store and keeping it in step.
 */
export function layoutNow(): Layout {
  return read();
}

export function useLayout(): Layout {
  const [layout, setLayout] = useState<Layout>(read);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;

    const queries = [window.matchMedia(LIST), window.matchMedia(CONTEXT)];
    const onChange = () => setLayout(read);

    for (const query of queries) query.addEventListener("change", onChange);
    // One read after mount, because the first render may have been the SSR
    // default above and the real width is only knowable here.
    onChange();

    return () => {
      for (const query of queries) query.removeEventListener("change", onChange);
    };
  }, []);

  return layout;
}
