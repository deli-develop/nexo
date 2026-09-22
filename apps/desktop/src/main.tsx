import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TextContextMenu } from "./components/ui/TextContextMenu";
import { inTauri } from "./lib/runtime";
import "@nexo/design-tokens/tokens.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// The service worker is a web-only thing, and deliberately so: the Tauri
// build ships its own assets, so a worker caching them would be a second copy
// of files that are already on the disk — and one the installer cannot clear.
//
// Registered after `load` rather than immediately: it competes with the wasm
// module and the first render for the same connection, and none of what it
// does matters on a first visit.
if (!inTauri() && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A page that will not cache still works. Nothing here is load-bearing,
      // and a console error on a private window nobody can act on is noise.
    });
  });
}

// D12: the browser's own context menu never appears. Anywhere.
//
// A frameless app with its own chrome that answers a right-click with Chromium's
// "Reload / Inspect / Save image as" menu stops looking like an application. It
// is suppressed here rather than per component so nothing can forget, and the
// app's own menu (N7) replaces it where there is something worth offering.
//
// Text inputs used to keep theirs, on the grounds that cut, copy and paste are
// real functionality worth more than tidiness. That held until the window
// became transparent: a menu the operating system draws is not in the document,
// takes no background from it, and over a transparent window it arrives as
// unreadable text floating on the desktop. `TextContextMenu` now offers the
// same actions on the app's own opaque surface, so the exception is gone and
// this listener has no exceptions left.
document.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

createRoot(root).render(
  <StrictMode>
    <App />
    {/* Beside the app rather than inside it. `App` returns one of five trees
        depending on whether there is an account, a lock and a PIN, and a menu
        mounted in one of them is a menu missing from four. It portals to
        `document.body`, so where it sits in the tree costs nothing. */}
    <TextContextMenu />
  </StrictMode>,
);
