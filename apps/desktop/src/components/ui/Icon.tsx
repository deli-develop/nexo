/**
 * The icon set.
 *
 * Hand-drawn on a 24px grid in the Lucide idiom: 1.75px strokes, round caps,
 * `currentColor`. Three reasons it lives here rather than in a package:
 *
 * - Rule 3 wants everything bundled and nothing fetched. Inline SVG is the
 *   strongest form of that — there is no request to make.
 * - Emoji are not an icon system. They render differently per platform and
 *   carry a tone the product does not want in its chrome.
 * - The set is small enough to read in one screen, which keeps it small.
 *
 * Icons are decorative: they are `aria-hidden`, and every icon-only control
 * carries its own label.
 */

import type { SVGProps } from "react";
import type { JSX } from "react";

const glyphs = {
  home: <path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />,
  messages: (
    <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.6 9.6 0 0 1-3.9-.8L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  // A globe, not a map pin. The pin is what a person places; the destination is
  // the world they place it on -- and a pin in the rail would promise that
  // something here knows where you are, which is the one thing this feature
  // is built not to do.
  meet: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18z" />
    </>
  ),
  userPlus: (
    <>
      <circle cx="10" cy="8" r="3.6" />
      <path d="M3.5 20.5a6.5 6.5 0 0 1 13 0M18.5 7.5v6M21.5 10.5h-6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.1 14.6a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.2a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.2a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7h.2a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  "chevron-right": <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="2" />,
  restore: (
    <>
      <rect x="4" y="8" width="12" height="12" rx="2" />
      <path d="M8 8V6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.1" />
      <circle cx="12" cy="12" r="1.1" />
      <circle cx="19" cy="12" r="1.1" />
    </>
  ),
  paperclip: (
    <path d="M20.4 11.6 12 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 1 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
  ),
  emoji: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 14.5a4.4 4.4 0 0 0 7 0" />
      <path d="M9 9.5h.01M15 9.5h.01" />
    </>
  ),
  send: <path d="m21 3-9.5 19-2.6-8.4L1 11z M21 3 8.9 13.6" />,
  bell: (
    <>
      <path d="M18 8.5a6 6 0 1 0-12 0c0 6-2.5 7.5-2.5 7.5h17S18 14.5 18 8.5z" />
      <path d="M13.7 19.5a2 2 0 0 1-3.4 0" />
    </>
  ),
  /* Muted. A struck-through bell rather than the same bell the Mute entry
     uses: a row marked with the icon of the action that would undo it reads as
     a button, and there was no way to tell a muted row from a loud one. */
  "bell-off": (
    <>
      <path d="M18 8.5a6 6 0 0 0-9.3-5M6.2 6.8A6 6 0 0 0 6 8.5c0 6-2.5 7.5-2.5 7.5h13" />
      <path d="M13.7 19.5a2 2 0 0 1-3.4 0" />
      <path d="M3.5 3.5l17 17" />
    </>
  ),
  shield: (
    <path d="m12 3 7.5 3v5.6c0 4.5-3.1 8.3-7.5 9.4-4.4-1.1-7.5-4.9-7.5-9.4V6z" />
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  logout: <path d="M15 3.5h3.5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H15M10 16.5 14.5 12 10 7.5M14.5 12H3.5" />,
  check: <path d="m5 12.5 4.5 4.5L19 6.5" />,
  checks: <path d="m1.5 12.5 4.5 4.5L15.5 7M10 17l1.6 1.6L21 8.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5M12 17.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11.5V16M12 8h.01" />
    </>
  ),
  download: <path d="M12 3.5v11.5M7.5 10.5 12 15l4.5-4.5M4 20.5h16" />,
  file: (
    <>
      <path d="M14 3H7.5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h4.5" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="2.5" />
      <circle cx="8.5" cy="9" r="1.6" />
      <path d="m21 15.5-5.2-5-9.8 10" />
    </>
  ),
  link: (
    <path d="M10.5 13.5a4.5 4.5 0 0 0 6.6.4l2.4-2.4a4.5 4.5 0 0 0-6.4-6.4l-1.4 1.4M13.5 10.5a4.5 4.5 0 0 0-6.6-.4l-2.4 2.4a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4" />
  ),
  external: <path d="M14.5 3.5H20v5.5M20 3.5 11 12.5M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17 13 13 0 0 1 0-17z" />
    </>
  ),
  hash: <path d="M4.5 9h15M4.5 15h15M10.5 3.5 8.5 20.5M15.5 3.5l-2 17" />,
  /* A pushpin, seen from the side: head, shaft, point. It used to be a map
     marker, which is what `location` is now -- the same glyph was standing for
     "pinned to the top" and "this is where I live", and the first is the one
     people scan a list for. */
  pin: (
    <>
      <path d="M9 3.5h6M10 3.5v6.2a2 2 0 0 1-1.1 1.8l-2 1A2 2 0 0 0 5.8 14h12.4a2 2 0 0 0-1.1-1.5l-2-1a2 2 0 0 1-1.1-1.8V3.5" />
      <path d="M12 14v6.5" />
    </>
  ),
  location: (
    <>
      <path d="M19.5 10.5c0 5.5-7.5 11-7.5 11s-7.5-5.5-7.5-11a7.5 7.5 0 0 1 15 0z" />
      <circle cx="12" cy="10.5" r="2.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  comment: <path d="M21 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4.5 4V5.5A2.5 2.5 0 0 1 6 3h12.5A2.5 2.5 0 0 1 21 5.5z" />,
  panel: (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="2.5" />
      <path d="M14.5 3.5v17" />
    </>
  ),
  chevronLeft: <path d="m14.5 5-7 7 7 7" />,
  chevronUp: <path d="m5 14.5 7-7 7 7" />,
  chevronDown: <path d="m5 9.5 7 7 7-7" />,
  trash: <path d="M4.5 6.5h15M9.5 6.5v-2a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 6.5l.9 13a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13" />,
  pencil: <path d="M4 20h4L20.2 7.8a2.7 2.7 0 0 0-4-4L4 16z" />,
  /* The three the app's own text-field menu needs. Cut used to borrow the
     close cross and Copy the file sheet, which is close enough to read wrong
     at a glance -- and this menu exists precisely so the app draws its own. */
  scissors: (
    <>
      <circle cx="6.5" cy="6.5" r="2.8" />
      <circle cx="6.5" cy="17.5" r="2.8" />
      <path d="M20 4 8.6 15.4M14.2 14.2 20 20M8.6 8.6l3.4 3.4" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="12" height="12" rx="2.5" />
      <path d="M5 15.5A2 2 0 0 1 3.5 13.5v-9A2 2 0 0 1 5.5 3h8a2 2 0 0 1 2 1.9" />
    </>
  ),
  clipboard: (
    <>
      <rect x="8.5" y="2.5" width="7" height="4" rx="1.2" />
      <path d="M15.5 4.5H17a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h1.5" />
    </>
  ),
  camera: (
    <>
      <path d="M3.5 8.5H7l1.6-2.4h6.8L17 8.5h3.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18v-8a1.5 1.5 0 0 1 1.5-1.5z" />
      <circle cx="12" cy="13.5" r="3.4" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="4.5" />
      <path d="m11.4 12.4 8.6-8.6M17 6.5l2.5 2.5M14.5 9 17 11.5" />
    </>
  ),
  refresh: <path d="M20 12a8 8 0 1 1-2.4-5.7M20.5 4v5h-5" />,
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="11.5" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" />
    </>
  ),
  /* The same microphone with a stroke through it. Drawn rather than reused
     with a CSS rotation, because a muted control has to read as muted at 16px
     and a rotated overlay does not survive that size. */
  "mic-off": (
    <>
      <path d="M15 4.2A3 3 0 0 0 9 5.5v5.2M9 14v-1.4" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 10.2 5.3M18.5 11.5v-.6" />
      <path d="M12 18v3.5M8.5 21.5h7" />
      <path d="M3.5 3.5 20.5 20.5" />
    </>
  ),
  phone: (
    <path d="M7.2 3.5H4.6a1.6 1.6 0 0 0-1.6 1.7c.3 4 2 7.8 4.8 10.6s6.6 4.5 10.6 4.8a1.6 1.6 0 0 0 1.7-1.6v-2.6a1.6 1.6 0 0 0-1.4-1.6 10 10 0 0 1-2.2-.5 1.6 1.6 0 0 0-1.7.4L13.7 16a13 13 0 0 1-5.7-5.7l1.1-1.1a1.6 1.6 0 0 0 .4-1.7 10 10 0 0 1-.5-2.2 1.6 1.6 0 0 0-1.6-1.4z" />
  ),
  /* The handset turned down, which is what "hang up" has meant since before
     anybody reading this used a telephone with a cradle. */
  "phone-off": (
    <>
      <path d="M2.5 14.6c3-3 6.8-4.6 9.5-4.6s6.5 1.6 9.5 4.6" />
      <path d="M8.4 12.2 6.6 9.9a1.4 1.4 0 0 0-2 -.2l-1.7 1.5a1.4 1.4 0 0 0-.1 2l1.4 1.5M15.6 12.2l1.8-2.3a1.4 1.4 0 0 1 2-.2l1.7 1.5a1.4 1.4 0 0 1 .1 2l-1.4 1.5" />
      <path d="M3.5 20.5 20.5 3.5" />
    </>
  ),
  /* A stroked triangle rather than a filled one, so it sits in the same
     weight as everything else here. Marks a video where there is no room for
     a control -- a gallery tile's poster frame, not a player. */
  play: <path d="M8.5 5.8 18.5 12l-10 6.2z" />,
  music: (
    <>
      <path d="M9 18V5.5l10-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  moon: <path d="M20.8 13.6A9 9 0 1 1 10.4 3.2a7 7 0 0 0 10.4 10.4z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>
  ),
} satisfies Record<string, JSX.Element>;

export type IconName = keyof typeof glyphs;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Rendered size in px. 18 in dense chrome, 20 in the rail, 16 inline. */
  size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {glyphs[name]}
    </svg>
  );
}

export const iconNames = Object.keys(glyphs) as IconName[];
