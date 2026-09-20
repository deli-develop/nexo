import { useEffect } from "react";

import { useApp } from "./store";
import { setWindowBackdrop } from "../lib/native";

/**
 * Everything the appearance preferences do to the document root.
 *
 * One hook rather than five effects inside the shell, for one reason: the
 * shell only exists once someone is signed in. The sign-in form and the lock
 * screen are drawn by `App` itself, and before this was lifted out they were
 * the two places the chosen theme, accent and transparency did not apply —
 * so the app changed appearance at the moment you logged in, which reads as
 * two different products.
 *
 * Everything here writes to `document.documentElement` and nothing here
 * renders. The stylesheet does the rest: one attribute or one variable on the
 * root moves every surface at once, which is the whole point of the token
 * layer (plan risk 9).
 */

/**
 * The surfaces N15's slider moves, darkest first.
 *
 * Each has a `-base` twin in the stylesheet holding the palette's own value,
 * because a `color-mix` that read the variable it is assigning to would be
 * circular and resolve to nothing.
 */
const SURFACE_TOKENS = [
  "--color-void",
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
] as const;

/**
 * How much of the app's own field survives, at a given blur strength.
 *
 * Pure, and exported, because it is the rule that decides how legible the app
 * is over a wallpaper nobody here has seen. The floor is what matters: a
 * slider that could reach zero would let someone make their own messenger
 * unreadable in one drag.
 *
 * The range was 90%-58% and the effect was reported as working but weak,
 * which it was: at full strength well over half the field was still painted,
 * and the panes on top of it kept another half again. It is now 62%-22%. What
 * carries legibility at the bottom end is not this number on its own -- it is
 * the pane the text actually sits on, which has its own fill *and* a 24px
 * `backdrop-filter`. Blurring is what makes a wallpaper safe to read over:
 * it destroys exactly the fine detail that competes with a glyph.
 */
export function fieldVeil(strength: number): string {
  const clamped = Math.min(1, Math.max(0, strength));
  return `${Math.round(62 - clamped * 40)}%`;
}

export function useChrome(): void {
  const glass = useApp((s) => s.preferences.glass);
  const glassStrength = useApp((s) => s.preferences.glassStrength);
  const backdrop = useApp((s) => s.preferences.backdrop);
  // Into the store rather than returned: Settings is the only reader and it is
  // nowhere near this call site.
  const setReport = useApp((s) => s.setBackdropReport);
  const accentHue = useApp((s) => s.preferences.accentHue);
  const contrast = useApp((s) => s.preferences.contrast);
  const theme = useApp((s) => s.preferences.theme);

  // One attribute on the root drives every glass surface at once (plan risk
  // 9), and the same switch asks the OS for the window backdrop.
  //
  // N16: zero strength is the same "off" the switch always meant, not a blur
  // of zero pixels. `backdrop-filter` costs the GPU whatever its radius, so a
  // slider at the bottom has to drop the property rather than set it small --
  // which is exactly what `[data-glass="off"]` already does.
  useEffect(() => {
    const root = document.documentElement;
    const on = glass && glassStrength > 0;
    root.dataset["glass"] = on ? "on" : "off";
    if (on) root.style.setProperty("--glass-blur", `${Math.round(glassStrength * 24)}px`);
    else root.style.removeProperty("--glass-blur");

    // The window itself, which is a different effect with a different owner:
    // the panes' blur happens in the WebView, the desktop's happens in DWM.
    //
    // `data-backdrop` follows the *answer*, never the request. Getting that
    // backwards is what produced the fake glass: the field went translucent on
    // the strength of a call that had not been refused, which on Windows 11 is
    // not the same as one that worked.
    let cancelled = false;
    void setWindowBackdrop(on ? backdrop : "off").then((answer) => {
      if (cancelled) return;
      setReport(answer);
      if (answer.applied) {
        root.dataset["backdrop"] = "on";
        root.style.setProperty("--field-veil", fieldVeil(glassStrength));
      } else {
        delete root.dataset["backdrop"];
        root.style.removeProperty("--field-veil");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [glass, glassStrength, backdrop, setReport]);

  // N14: only the hue moves. Saturation and lightness stay where the palette
  // put them -- but that alone does *not* keep a chosen accent legible, and
  // the palette claimed for a long time that it did.
  //
  // Hue is not contrast-neutral. At one fixed HSL lightness, white on the
  // accent measures 4.69:1 at blue, 8.52:1 at violet, 3.31:1 at orange and
  // **1.67:1 at green** -- so anybody who picked green got their own message
  // bubbles at a ratio where the text is effectively not there. Measured in a
  // browser across the picker's range, not estimated.
  //
  // So the ink on the accent is computed from the accent rather than assumed
  // to be white: whichever of white or near-black has more contrast against
  // the fill wins. `--color-on-accent` is the one token every accent-filled
  // surface reads for its text -- the outgoing bubble, the primary button,
  // the unread badge -- so one value fixes all of them.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--accent-hue", String(accentHue));
    root.style.setProperty("--color-on-accent", inkFor(accentHue));
  }, [accentHue]);

  // N15: the surface scale slides toward black in dark mode and toward white
  // in light. Every step moves together and by the same proportion, so the
  // panels stay distinguishable from each other at the far end -- a scale that
  // collapsed to one colour would take the layout's edges with it.
  useEffect(() => {
    const root = document.documentElement;
    if (contrast <= 0) {
      for (const name of SURFACE_TOKENS) root.style.removeProperty(name);
      return;
    }
    const dark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const target = dark ? "black" : "white";
    const computed = window.getComputedStyle(root);
    for (const name of SURFACE_TOKENS) {
      // Never write a mix that cannot resolve.
      //
      // `color-mix` with an undefined `var()` in it is invalid at
      // computed-value time, and a custom property that lands there takes
      // every declaration reading it down to `initial` -- which for a
      // background is `transparent`. That is not a slider doing too little;
      // it is menus, the modal dialog and every glass pane losing their fill
      // at once, which is exactly what happened when Tailwind pruned these
      // `-base` twins out of `@theme`. The twins are in a plain `:root` now,
      // so this should never fire -- and if it ever does, a depth slider that
      // quietly does nothing is the right way to fail.
      if (computed.getPropertyValue(`${name}-base`).trim() === "") continue;
      // Mixed against the token's own value, so this rides on top of whichever
      // palette is in force rather than replacing it.
      root.style.setProperty(
        name,
        `color-mix(in srgb, var(${name}-base) ${Math.round((1 - contrast) * 100)}%, ${target})`,
      );
    }
  }, [contrast, theme]);

  // "System" is the *absence* of the attribute: the stylesheet then answers to
  // prefers-color-scheme, which means the OS switching at sunset switches the
  // app with it and nothing here has to listen for it.
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") delete root.dataset["theme"];
    else root.dataset["theme"] = theme;
  }, [theme]);

}

/**
 * White or near-black, whichever is readable on the accent at this hue.
 *
 * The saturation and lightness are read from the stylesheet rather than
 * repeated here, so the palette stays the one place they are decided: a copy
 * in this file would drift the first time the ramp moved.
 */
function inkFor(hue: number): string {
  const probe = document.createElement("span");
  probe.style.color = `hsl(${hue} var(--accent-s, 88%) var(--accent-l, 48%))`;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();

  const parts = resolved.match(/\d+(\.\d+)?/g);
  // A browser that cannot resolve the probe keeps the palette's own value.
  if (!parts || parts.length < 3) return "#ffffff";

  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const [r = 0, g = 0, b = 0] = parts.slice(0, 3).map(Number);
  const luminance =
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

  // Against white (1.0) versus against the app's darkest ink.
  const againstWhite = 1.05 / (luminance + 0.05);
  const againstInk = (luminance + 0.05) / (0.0114 + 0.05);
  return againstWhite >= againstInk ? "#ffffff" : "#0b1220";
}
