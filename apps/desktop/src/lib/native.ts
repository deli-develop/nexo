/**
 * The native seam: file pickers, saving, clipboard, and the "not built yet"
 * notice, all in one place so components never touch a Tauri plugin directly.
 *
 * # One page, three hosts
 *
 * Everything here is wrapped the same way: a browser tab has no Tauri runtime,
 * so a missing plugin degrades to a no-op or to the web equivalent rather than
 * throwing. That was already true for the tray and the toasts — `vite dev` has
 * run in a plain browser all along — and wave 7 makes it true for the parts
 * that used to be genuinely native.
 *
 * The file picker is the one that could not be papered over. It used to answer
 * with a **path**, and a browser never learns one: the page is handed bytes by
 * the picker and that is all it will ever have. So `PickedFile` carries the
 * bytes, `path` is present only in the Tauri build, and nothing downstream may
 * require it.
 */
import { invoke } from "@tauri-apps/api/core";

import { requestDialog } from "./dialogs";
import { inTauri } from "./runtime";

export interface PickedFile {
  /** In the Tauri build only. A browser never learns a path, by design. */
  path?: string;
  name: string;
  /** What the picker said it is. Still sniffed again before it is trusted. */
  mime: string;
  bytes: Uint8Array;
  /**
   * An object URL this page can render.
   *
   * The caller revokes it. Not doing so keeps the whole file alive in memory
   * for as long as the tab is open, which for a video is exactly the sort of
   * leak nobody notices until an hour in.
   */
  url: string;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const MEDIA_ACCEPT = `${IMAGE_ACCEPT},video/mp4,video/quicktime,video/webm`;

/**
 * Asks for a file.
 *
 * One implementation for both hosts: a hidden `<input type="file">`, which the
 * Tauri WebView answers with the same OS dialog the plugin would have opened.
 * Two implementations would be two sets of filters to keep in step, and the
 * filters are exactly what drifted before — `media` rather than `images`,
 * because a story can be a video and a second call site that forgot would
 * refuse them for no reason anybody could see.
 */
export function pickFile(options?: {
  title?: string;
  images?: boolean;
  media?: boolean;
}): Promise<PickedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    if (options?.media) input.accept = MEDIA_ACCEPT;
    else if (options?.images) input.accept = IMAGE_ACCEPT;
    input.style.display = "none";
    document.body.append(input);

    // Cancelling is `null`, not an error. Nothing went wrong; the person
    // changed their mind, and an error message for a decision is noise.
    const finish = (picked: PickedFile | null) => {
      input.remove();
      resolve(picked);
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        finish(null);
        return;
      }
      void file.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        finish({
          name: file.name,
          mime: file.type || "application/octet-stream",
          bytes,
          url: URL.createObjectURL(file),
        });
      });
    });
    input.addEventListener("cancel", () => finish(null));
    input.click();
  });
}

/**
 * Writes bytes somewhere the person chose.
 *
 * The two hosts genuinely differ and neither can imitate the other: Tauri asks
 * where and writes the file; a browser hands the file to the download
 * mechanism and the person's own settings decide where it lands. Both end with
 * the file saved, which is the promise this makes — so it answers `true` or
 * `false` rather than a path nobody on the web would be given.
 */
export async function saveFile(name: string, bytes: Uint8Array): Promise<boolean> {
  if (inTauri()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ title: "Save attachment", defaultPath: name });
      if (!path) return false;
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      await writeFile(path, bytes);
      return true;
    } catch {
      return false;
    }
  }

  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart]));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  // Revoked on the next turn rather than immediately: the click is handled
  // asynchronously, and revoking first is a download of nothing.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}

/**
 * What version this is.
 *
 * The shell's, in the Tauri build; the bundle's, on the web, where there is no
 * shell to ask. `import.meta.env` is inlined at build time, so the web answer
 * is a literal rather than a call that could fail.
 */
export async function appVersion(): Promise<string> {
  if (!inTauri()) return import.meta.env["VITE_APP_VERSION"] ?? "web";
  try {
    return await invoke<string>("app_version");
  } catch {
    return "unknown";
  }
}

/** Says something inside the app, as a toast that leaves on its own. */
export async function notify(title: string, body: string): Promise<void> {
  await requestDialog("info", title, body);
}

/** Asks inside the app and waits for the answer. */
export async function confirm(title: string, body: string): Promise<boolean> {
  return requestDialog("confirm", title, body);
}

/** Opens a URL in the system's default browser, never inside the WebView. */
export async function openUrl(url: string): Promise<void> {
  try {
    const { openUrl: open } = await import("@tauri-apps/plugin-opener");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/** How much a Windows toast is allowed to say (§8). Applied in Rust. */
export type NotificationDetail = "full" | "sender" | "none";

/**
 * Shows a Windows toast for an incoming message.
 *
 * The WebView asks; Rust decides what the toast actually says, by applying
 * `detail` in `toast_text` before anything reaches the OS. A toast is drawn on
 * the lock screen and over screen shares, so "the notification respects the
 * privacy setting" has to be true of the process that builds the string.
 */
export async function toastMessage(
  sender: string,
  body: string,
  detail: NotificationDetail,
): Promise<void> {
  try {
    await invoke("notify_message", { sender, body, detail });
  } catch {
    // A browser preview has no toasts, and a toast that could not be shown is
    // not worth interrupting a sync over.
  }
}

/** Updates the tray tooltip's unread count (§8). */
export async function setTrayUnread(unread: number): Promise<void> {
  try {
    await invoke("set_unread", { unread });
  } catch {
    // No tray in a browser preview.
  }
}

/**
 * Forgets what the shell knows about the account that just signed out.
 *
 * The tray tooltip and the startup entry, neither of which is the page's to
 * change. Nothing on the web, where there is neither.
 *
 * Infallible from here. The store is already wiped by the time this runs, so
 * a tray that will not update must not turn into a sign-out that appears to
 * have failed.
 */
export async function forgetAccount(): Promise<void> {
  try {
    await invoke("forget_account");
  } catch {
    // No tray and no startup entry to forget.
  }
}

/** Pushes the close-to-tray preference to Rust, where the close handler lives. */
export async function setCloseToTray(enabled: boolean): Promise<void> {
  try {
    await invoke("set_close_to_tray", { enabled });
  } catch {
    // No window chrome to configure in a browser preview.
  }
}

export type BackdropKind = "off" | "acrylic" | "mica" | "tabbed" | "blur";

/** What came back from asking Windows for a backdrop. */
export interface BackdropReport {
  requested: BackdropKind;
  /**
   * The call went through and was not refused.
   *
   * Deliberately **not** a promise that the desktop is now visible through the
   * window. From Windows 11 build 22523 on, the API that sets the backdrop
   * does not report whether it took, so this is the most that can honestly be
   * claimed — and why Settings shows it next to a chooser rather than the app
   * deciding on its own.
   */
  applied: boolean;
  /** Plain words for the Settings panel. Empty when there is nothing to add. */
  note: string;
}

/**
 * Asks Windows for a blurred backdrop behind the window.
 *
 * The one thing CSS cannot do. `backdrop-filter` blurs what is behind an
 * element *in this document*; the desktop is not in this document, so the
 * wallpaper and the windows underneath can only be reached by the desktop
 * window manager.
 */
export async function setWindowBackdrop(
  kind: BackdropKind,
): Promise<BackdropReport> {
  try {
    return await invoke<BackdropReport>("set_window_backdrop", { kind });
  } catch {
    // No window to composite behind in a browser preview.
    return { requested: kind, applied: false, note: "No desktop window here." };
  }
}

/**
 * Whether the app starts with Windows, read from the registry.
 *
 * `null` when there is no runtime to ask — the Settings toggle shows itself
 * as unavailable rather than claiming a state it cannot know.
 */
export async function getAutostart(): Promise<boolean | null> {
  try {
    return await invoke<boolean>("get_autostart");
  } catch {
    return null;
  }
}

/** Turns start-with-Windows on or off. Resolves false when it could not. */
export async function setAutostart(enabled: boolean): Promise<boolean> {
  try {
    await invoke("set_autostart", { enabled });
    return true;
  } catch {
    return false;
  }
}

/** A link preview, fetched by this machine (§4.5). */
export interface LinkPreviewData {
  url: string;
  title: string;
  description: string;
  source: string;
}

/**
 * Fetches a preview for one URL.
 *
 * Only call this when the `linkPreviews` preference is on: fetching a link
 * reveals this machine's IP and rough activity to whoever controls it, which
 * is why the setting exists and why it is off by default. Rust enforces the
 * rest — https only, no private addresses, no redirects, byte and time
 * ceilings — regardless of who asked.
 *
 * Resolves `null` for anything that could not be previewed. A link with no
 * preview stays a link, which is the same thing the setting-off path renders.
 */
export async function previewLink(
  url: string,
): Promise<LinkPreviewData | null> {
  try {
    return await invoke<LinkPreviewData>("preview_link", { url });
  } catch {
    return null;
  }
}

/** What Nexo is keeping on this machine (§6.4). */
export interface StorageInfo {
  /**
   * Where it is kept, in words rather than as a path.
   *
   * There is no path to show any more: the store is IndexedDB, and the
   * browser decides where that lives. Printing an invented one would be worse
   * than saying which browser profile it belongs to.
   */
  storePath: string;
  /** Everything the app is holding — messages, keys, drafts, cached objects. */
  storeBytes: number;
  /** What the page cached: the shell, which is re-fetchable and safe to clear. */
  cacheBytes: number;
}

/**
 * Measures what this origin is using.
 *
 * `navigator.storage.estimate()` rather than a Rust directory walk, which is
 * what this used to be. It reports one number for the whole origin, so the
 * split between the store and the cache is measured rather than guessed: the
 * cache is the one thing here that can be counted on its own.
 *
 * `null` when the browser will not say — Firefox in a private window, for
 * one — so the panel can say "unavailable" rather than print a zero that
 * reads as "nothing is stored".
 */
export async function storageInfo(): Promise<StorageInfo | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const estimate = await navigator.storage.estimate();
    if (estimate.usage === undefined) return null;
    let cacheBytes = 0;
    if ("caches" in globalThis) {
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          const response = await cache.match(request);
          const length = response?.headers.get("content-length");
          if (length) cacheBytes += Number(length);
        }
      }
    }
    return {
      storePath: inTauri() ? "This app's data folder" : "This browser profile",
      storeBytes: Math.max(0, estimate.usage - cacheBytes),
      cacheBytes,
    };
  } catch {
    return null;
  }
}

/**
 * Clears the cached shell. Messages are untouched.
 *
 * The one thing here that is safe to delete: the shell re-downloads, and
 * everything else in this origin *is* the only copy — the server deletes
 * ciphertext on acknowledgement, so there is nothing to re-fetch it from.
 */
export async function clearMediaCache(): Promise<boolean> {
  if (!("caches" in globalThis)) return false;
  try {
    for (const name of await caches.keys()) await caches.delete(name);
    return true;
  } catch {
    return false;
  }
}

/** What an update check found. */
export interface UpdateInfo {
  version: string;
}

/**
 * Asks the update server for a newer build. Resolves `null` when this build is
 * current. Throws with a human-readable message when the check itself failed —
 * including in a dev build, which has no update key configured, and says so.
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  return await invoke<UpdateInfo | null>("check_update");
}

/** Downloads and installs a waiting update, then restarts the app. */
export async function installUpdate(): Promise<void> {
  await invoke("install_update");
}

/**
 * What is on the clipboard, as text, or `null` if it cannot be read.
 *
 * # Why this exists at all
 *
 * The capability set is deliberately small and the clipboard was write-only
 * (`capabilities/default.json` said so in as many words). Reading it back is
 * a real widening, and it is here for exactly one reason: the app draws its
 * own right-click menu in text fields now, and a text field's menu without
 * Paste is not a text field's menu.
 *
 * # What it costs, stated plainly
 *
 * Clipboard text already reaches the WebView every time somebody presses
 * Ctrl+V — the browser inserts it into the DOM, where the page can read it.
 * What changes is who starts it: code running in the WebView can now ask
 * without being asked. In an app whose WebView already sees decrypted
 * messages that is a small step, but it is a step, and `docs/THREAT-MODEL.md`
 * records it rather than leaving it in a JSON file nobody reads.
 */
export async function pasteText(): Promise<string | null> {
  try {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return await readText();
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
