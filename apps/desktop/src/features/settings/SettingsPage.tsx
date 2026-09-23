import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useApp, type LockTimeout, type Preferences, type Theme } from "../../app/store";
import { cn } from "../../lib/cn";
import { fileSize } from "../../lib/format";
import {
  appVersion,
  checkUpdate,
  clearMediaCache,
  confirm,
  getAutostart,
  installUpdate,
  notify,
  openUrl,
  setAutostart,
  storageInfo,
  type StorageInfo,
} from "../../lib/native";
import { inTauri } from "../../lib/runtime";
import { Button } from "../../components/ui/Button";
import { FactRow, Select, Toggle, type SelectOption } from "../../components/ui/Controls";
import { Callout } from "../../components/ui/Feedback";
import { Icon, type IconName } from "../../components/ui/Icon";
import { Divider, Panel, SectionHeader } from "../../components/ui/Surface";
import { ChangePassword } from "./ChangePassword";
import { DeleteAccount } from "./DeleteAccount";
import { useSignOut } from "../auth/useSignOut";
import { UnlockPin } from "./UnlockPin";
import { BlockedList } from "./BlockedList";
import { PrivacyTable } from "./PrivacyTable";
import { RunRelay, ViaRelay } from "./Relay";

type Section =
  | "appearance"
  | "notifications"
  | "system"
  | "connection"
  | "privacy"
  | "security"
  | "storage"
  | "about";

/** Whether the OS is currently asking for a dark interface. */
function useSystemDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? true);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return dark;
}

/**
 * The icon for a settings section, given the theme in force.
 *
 * Only Appearance changes: a fixed moon claims the app is dark whatever it is
 * actually showing. "System" has no icon of its own — it means whichever of the
 * two the OS is currently asking for, so it resolves to that.
 */
function iconFor(section: Section, theme: Theme, systemIsDark: boolean): IconName {
  if (section !== "appearance") {
    return sections.find((s) => s.id === section)?.icon ?? "settings";
  }
  const dark = theme === "dark" || (theme === "system" && systemIsDark);
  return dark ? "moon" : "sun";
}

const sections: { id: Section; label: string; icon: IconName }[] = [
  // `appearance` carries a placeholder: its real icon depends on the theme in
  // force and is chosen at render, below.
  { id: "appearance", label: "Appearance", icon: "moon" },
  { id: "notifications", label: "Notifications", icon: "bell" },
  { id: "system", label: "System", icon: "panel" },
  { id: "connection", label: "Connection", icon: "globe" },
  { id: "privacy", label: "Privacy", icon: "eye" },
  { id: "security", label: "Security", icon: "shield" },
  { id: "storage", label: "Storage", icon: "database" },
  { id: "about", label: "About", icon: "info" },
];

export function SettingsPage({ now }: { now: Date }) {
  const [section, setSection] = useState<Section>("appearance");
  const theme = useApp((s) => s.preferences.theme);
  // "System" resolves to whatever the OS is asking for right now, and follows
  // it if that changes while Settings is open.
  const systemIsDark = useSystemDark();

  return (
    <Panel tone="content" edge={false} className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings sections"
          className="w-[212px] shrink-0 space-y-0.5 overflow-y-auto border-r border-[var(--hairline)] p-3"
        >
          {sections.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
              className={cn(
                "rounded-control flex w-full items-center gap-2.5 px-3 py-2 text-left text-body transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                section === item.id
                  ? "bg-accent/16 text-accent-soft font-medium"
                  : "text-text-mid hover:bg-fill-hover hover:text-text-hi",
              )}
            >
              <Icon name={iconFor(item.id, theme, systemIsDark)} size={16} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[720px] px-6 py-6">
            {section === "appearance" ? <Appearance /> : null}
            {section === "notifications" ? <Notifications /> : null}
            {section === "system" ? <System /> : null}
            {section === "connection" ? <Connection /> : null}
            {section === "privacy" ? <Privacy now={now} /> : null}
            {section === "security" ? <Security /> : null}
            {section === "storage" ? <Storage /> : null}
            {section === "about" ? <About /> : null}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Group({
  title,
  description,
  bare = false,
  children,
}: {
  title: string;
  description?: string;
  /** For content that already carries its own frame. */
  bare?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="mb-8 flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <SectionHeader>{title}</SectionHeader>
        {description ? (
          <p className="text-text-mid max-w-[68ch] text-meta leading-relaxed">{description}</p>
        ) : null}
      </div>
      {bare ? (
        children
      ) : (
        <div className="rounded-panel border border-line bg-fill px-4 py-1">
          {children}
        </div>
      )}
    </section>
  );
}

function Appearance() {
  const glass = useApp((s) => s.preferences.glass);
  const glassStrength = useApp((s) => s.preferences.glassStrength);
  const backdrop = useApp((s) => s.preferences.backdrop);
  const accentHue = useApp((s) => s.preferences.accentHue);
  const contrast = useApp((s) => s.preferences.contrast);
  const theme = useApp((s) => s.preferences.theme);
  const set = useApp((s) => s.setPreference);

  const themes: { id: Theme; label: string; description: string; icon: IconName }[] = [
    {
      id: "system",
      label: "System",
      description: "Follow Windows. Switches with it, including on a schedule.",
      icon: "refresh",
    },
    { id: "light", label: "Light", description: "Always light.", icon: "sun" },
    { id: "dark", label: "Dark", description: "Always dark.", icon: "moon" },
  ];

  return (
    <>
      <Group
        title="Theme"
        description="One accent and one grey scale, in two sets of values. Colour in this interface means the accent or a status — never decoration."
      >
        <div className="grid grid-cols-3 gap-2 py-3">
          {themes.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={theme === option.id}
              onClick={() => set("theme", option.id)}
              className={cn(
                "rounded-control flex flex-col items-start gap-1 border px-3 py-2.5 text-left transition-colors duration-[var(--motion-fast)] ease-[var(--ease-state)]",
                theme === option.id
                  ? "border-accent/60 bg-accent/10"
                  : "border-line hover:bg-fill-hover",
              )}
            >
              <span
                className={cn(
                  "flex items-center gap-2 text-body",
                  theme === option.id ? "text-accent-soft font-medium" : "text-text-hi",
                )}
              >
                <Icon name={option.icon} size={15} />
                {option.label}
              </span>
              <span className="text-text-mid text-[11px] leading-relaxed">
                {option.description}
              </span>
            </button>
          ))}
        </div>
      </Group>

      <Group
        title="Accent"
        description="One colour marks the active destination, your own messages, the primary action and the focus ring. Only the hue is yours to choose — how light and how saturated it is stays fixed, because that is what keeps it readable against every surface."
      >
        <div className="py-3">
          <input
            type="range"
            min={0}
            max={359}
            value={accentHue}
            onChange={(e) => set("accentHue", Number(e.target.value))}
            aria-label="Accent hue"
            className="h-2 w-full cursor-pointer appearance-none rounded-full"
            style={{
              background:
                "linear-gradient(to right, hsl(0 93% 67%), hsl(60 93% 67%), hsl(120 93% 67%), hsl(180 93% 67%), hsl(240 93% 67%), hsl(300 93% 67%), hsl(359 93% 67%))",
            }}
          />
          <div className="mt-3 flex items-center gap-3">
            <span
              className="size-8 rounded-full ring-1 ring-line-strong"
              style={{ background: "var(--color-accent)" }}
              aria-hidden="true"
            />
            <span className="text-text-lo font-mono text-[11px]">{accentHue}°</span>
            <button
              type="button"
              onClick={() => set("accentHue", 255)}
              className="text-text-lo hover:text-text-hi ml-auto text-[11px] underline decoration-line-strong underline-offset-2"
            >
              Reset
            </button>
          </div>
        </div>
      </Group>

      <Group
        title="Background"
        description="How dark the surfaces go. All the way down is pure black, which some screens draw with the pixels switched off; the panels still step apart from each other at either end."
      >
        <div className="py-3">
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(contrast * 100)}
            onChange={(e) => set("contrast", Number(e.target.value) / 100)}
            aria-label="Background depth"
            className="accent-accent h-2 w-full cursor-pointer"
          />
          <div className="text-text-lo mt-2 flex justify-between text-[11px]">
            <span>As designed</span>
            <span>Deepest</span>
          </div>
        </div>
      </Group>

      <Group
        title="Transparency"
        description="Panels are translucent, and the window can be: Windows draws the desktop behind it. Which effect works depends on your Windows build and your graphics, and Windows does not report back whether it took — so pick one below and look at the window. Blur costs the graphics chip either way; at zero it is switched off rather than merely small. Turn this off if dragging the window feels heavy. Windows’ own Transparency effects switch outranks everything here."
      >
        <Toggle
          checked={glass}
          onChange={(next) => set("glass", next)}
          label="Frosted panels"
          description="Off: solid surfaces, an opaque window, no blur of any kind."
        />
        {glass ? (
          <>
            <div className="py-3">
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(glassStrength * 100)}
                onChange={(e) => set("glassStrength", Number(e.target.value) / 100)}
                aria-label="Blur strength"
                className="accent-accent h-2 w-full cursor-pointer"
              />
              <div className="text-text-lo mt-2 flex justify-between text-[11px]">
                <span>Off</span>
                <span>{Math.round(glassStrength * 24)}px</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-6 py-3">
              <span className="text-text-hi text-body">Desktop behind the window</span>
              <Select
                value={backdrop}
                options={BACKDROPS}
                onChange={(next) => set("backdrop", next)}
                label="Desktop backdrop"
                className="min-w-[168px]"
              />
            </div>
            <BackdropStatus />
          </>
        ) : null}
      </Group>
    </>
  );
}

/**
 * The idle timeouts on offer.
 *
 * "Never" is here because someone on a machine nobody else can reach should be
 * able to say so, rather than dismissing a lock screen all day until they find
 * a way to defeat it -- which is the worse outcome for the same wish.
 */
const LOCK_TIMEOUTS: readonly SelectOption<LockTimeout>[] = [
  { value: "5", label: "5 minutes idle" },
  { value: "15", label: "15 minutes idle" },
  { value: "60", label: "1 hour idle" },
  { value: "never", label: "Never" },
];

/**
 * The backdrops on offer, in the order they are worth trying.
 *
 * Named by what they *do* rather than by their Windows names, because "Mica"
 * tells nobody that it will not change when a window moves behind the app —
 * and that difference is the one people write bug reports about.
 */
const BACKDROPS: readonly SelectOption<Preferences["backdrop"]>[] = [
  { value: "acrylic", label: "Blur what is behind" },
  { value: "mica", label: "Tint from the wallpaper" },
  { value: "tabbed", label: "Tint, stronger" },
  { value: "blur", label: "Blur (older Windows)" },
  { value: "off", label: "None" },
];

/**
 * What Windows actually did with the last request.
 *
 * This exists because the app cannot find out. From Windows 11 build 22523 on,
 * setting a backdrop returns nothing to check — so the app used to assume it
 * had worked and make its own surface translucent on the strength of that
 * assumption, which is how a window ends up looking like glass with nothing
 * behind it. Now the assumption is on the screen, where the one person who can
 * see the window can judge it.
 */
function BackdropStatus() {
  const report = useApp((s) => s.backdropReport);
  if (!report) return null;

  return (
    <p className="text-text-lo px-1 pb-2 text-[11px] leading-relaxed">
      {report.note
        ? report.note
        : report.applied
          ? "Asked Windows for this and it was not refused. Whether it is visible is something only you can see — if the window still looks flat, try another one here."
          : "Nothing was applied."}
    </p>
  );
}

function Notifications() {
  const detail = useApp((s) => s.preferences.notificationDetail);
  const set = useApp((s) => s.setPreference);

  const options: { id: typeof detail; label: string; description: string }[] = [
    {
      id: "full",
      label: "Sender and message",
      description: "The toast shows who wrote and what they wrote.",
    },
    {
      id: "sender",
      label: "Sender only",
      description: "The toast shows who wrote, never the message.",
    },
    {
      id: "none",
      label: "Neither",
      description: "The toast says a message arrived and nothing else.",
    },
  ];

  return (
    <Group
      title="What a notification says"
      description="Windows toasts are drawn by the operating system and can appear on a locked screen, so this decides how much of a decrypted message leaves the app."
    >
      {options.map((option) => (
        <label
          key={option.id}
          className="flex cursor-pointer items-start gap-3 py-3 first:pt-3 last:pb-3"
        >
          <input
            type="radio"
            name="notification-detail"
            checked={detail === option.id}
            onChange={() => set("notificationDetail", option.id)}
            className="accent-accent mt-1"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-text-hi text-body">{option.label}</span>
            <span className="text-text-mid text-meta">{option.description}</span>
          </span>
        </label>
      ))}
    </Group>
  );
}

/**
 * §8: how the app sits in Windows — the tray, and starting with the machine.
 *
 * The autostart toggle asks the registry rather than a stored preference: the
 * `Run` key is the truth, and after another tool "cleans startup programs" a
 * preference that disagreed with it would draw a toggle that lies.
 */
function System() {
  const closeToTray = useApp((s) => s.preferences.closeToTray);
  const set = useApp((s) => s.setPreference);

  // null: not asked yet, or no runtime to ask (a browser preview).
  const [autostart, setAutostartState] = useState<boolean | null>(null);
  const [autostartKnown, setAutostartKnown] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getAutostart().then((enabled) => {
      if (cancelled) return;
      setAutostartState(enabled);
      setAutostartKnown(enabled !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Group
        title="Window"
        description="The tray icon is always there; this decides what the close button means."
      >
        <Toggle
          checked={closeToTray}
          onChange={(next) => set("closeToTray", next)}
          label="Close to tray"
          description="Closing the window keeps Nexo running in the tray, still receiving messages. Off: closing quits."
        />
      </Group>

      <Group
        title="Startup"
        description="Written to your user account's Run key — never machine-wide, so it needs no administrator and touches nobody else's account."
      >
        <Toggle
          checked={autostart ?? false}
          disabled={!autostartKnown}
          onChange={(next) => {
            // Optimistic, then verified: the registry answer wins.
            setAutostartState(next);
            void setAutostart(next).then((ok) => {
              if (!ok) void getAutostart().then(setAutostartState);
            });
          }}
          label="Start with Windows"
          description={
            autostartKnown
              ? "Nexo starts when you sign in to Windows, minimised to the tray."
              : "Unavailable in this preview — there is no registry to write."
          }
        />
      </Group>
    </>
  );
}

/**
 * Relays (`docs/RELAY.md`): reaching Nexo through somebody else's computer
 * when it is blocked, and letting others reach it through this one.
 *
 * Both say what a relay can see, because both ask somebody to trust a
 * stranger's machine or lend their own: rule 5 is about exactly this kind of
 * sentence.
 */
function Connection() {
  return (
    <>
      <Group
        title="Connect through a relay"
        description="If Nexo is blocked where you are, someone outside the block can relay for you. Your messages stay end-to-end encrypted, and your connection to Nexo stays encrypted through the relay: it sees that you use Nexo and how much, never what. Anyone watching your own connection can still tell it leads to Nexo."
      >
        <ViaRelay />
      </Group>

      <Group
        title="Help others connect"
        description="Let people who can't reach Nexo connect through this computer. It passes along bytes it cannot read, to Nexo's servers and nowhere else, and keeps no record of who connected."
      >
        <RunRelay />
      </Group>
    </>
  );
}

function Privacy({ now }: { now: Date }) {
  const prefs = useApp((s) => s.preferences);
  const set = useApp((s) => s.setPreference);

  return (
    <>
      <Group
        title="What is encrypted"
        description="The full picture, in plain language. Nexo does not claim protection it cannot provide."
        bare
      >
        <PrivacyTable />
      </Group>

      <Group
        title="Blocked"
        description="Blocking is enforced by the server, not by this app: their posts leave your feed and neither of you can start a conversation. It does not reach messages already delivered, and it cannot stop somebody making a second account."
        bare
      >
        <BlockedList now={now} />
      </Group>

      {/* These three send nothing today.
          Saying so is the only honest option: a Privacy panel is the worst
          possible place for a control that does not control anything, and a
          switch that looks like it stops a signal leaving the machine -- when
          no signal ever leaves -- is a promise in the wrong direction. The
          setting is kept rather than removed because the choice is still
          recorded, and it takes effect the moment the transport lands. */}
      <Group title="Signals you send">
        <Callout icon="info">
          None of these leave your machine yet. Nexo has no live connection to
          send them over, so nothing is shared either way — the switches record
          what you want to happen once it does.
        </Callout>
        <Toggle
          checked={prefs.readReceipts}
          onChange={(next) => set("readReceipts", next)}
          label="Read receipts"
          description="Not active yet. When it is: let people see when you have read their message, and see theirs. Turning it off will hide both."
        />
        <Divider />
        <Toggle
          checked={prefs.typingIndicators}
          onChange={(next) => set("typingIndicators", next)}
          label="Typing indicators"
          description="Not active yet."
        />
        <Divider />
        <Toggle
          checked={prefs.presence}
          onChange={(next) => set("presence", next)}
          label="Online and last seen"
          description="Not active yet."
        />
        <Divider />
        <Toggle
          checked={prefs.linkPreviews}
          onChange={(next) => set("linkPreviews", next)}
          label="Link previews"
          description="Off by default. When on, this machine fetches the page behind a link — never the server, which would leak who is reading what and turn it into a request forwarder. The cost is yours instead: whoever owns a link learns your IP address and roughly when you opened the conversation. https only, and never a private address."
        />
      </Group>
    </>
  );
}

function Security() {
  const lockAfter = useApp((s) => s.preferences.lockTimeout);
  const set = useApp((s) => s.setPreference);
  return (
    <>
      <Group title="Password">
        <ChangePassword />
      </Group>

      <Group
        title="Lock"
        description="After this much idleness Nexo locks: the screen is replaced, the connection closes, and the session is dropped from memory until you unlock with your PIN or password, which needs the server. The lock guards the screen, not the disk — what Nexo keeps on this device is not encrypted, and anyone who can read this computer's files can read your messages."
      >
        <div className="flex items-center justify-between gap-6 py-3">
          <span className="text-text-hi text-body">Lock after</span>
          {/* `Select`, not `<select>`: the native one hands its list to the
              platform to draw, and on a transparent window that list comes
              back with no background -- four lines of text over the desktop.
              See the note on the component. */}
          <Select
            value={lockAfter}
            options={LOCK_TIMEOUTS}
            onChange={(next) => set("lockTimeout", next)}
            label="Lock after"
            className="min-w-[168px]"
          />
        </div>
      </Group>

      <Group title="Unlock PIN" bare>
        <UnlockPin />
      </Group>

      <Group title="Recovery">
        <div className="py-3">
          <Callout tone="warning" icon="alert" title="There is no account recovery.">
            Your identity key exists only on this machine. If you lose it, the account and its
            history are gone — the server holds ciphertext it cannot read and deletes what has
            been delivered. Encrypted key backup is planned, and it is not in v0.1.
          </Callout>
        </div>
      </Group>

      {/* Sign out sits above Delete account, in that order, because the two
          read alike and mean opposite things: one ends a session on this
          machine, the other ends the account everywhere. Ordered least to most
          final, and the copy on each says which is which.

          On a desktop this button is also on the rail. On a phone it is only
          here — a bottom tab bar has no hover, and a red control in the thumb
          zone beside Profile is a mis-tap away from the one action that cannot
          be taken back. */}
      <Group title="Sign out">
        <SignOutRow />
      </Group>

      {/* Last, and it belongs last. The section above explains why nothing
          here can be undone; this is the button that spends that. */}
      <Group title="Delete account" bare>
        <DeleteAccount />
      </Group>
    </>
  );
}

/**
 * Storage (§6.4), measured rather than estimated.
 *
 * The two rows are deliberately not one total: the store is the only copy of
 * your messages — the server deletes ciphertext on acknowledgement — and the
 * cache is re-fetchable. Summing them would invite clearing the wrong one.
 */
function Storage() {
  const [info, setInfo] = useState<StorageInfo | null>(null);
  const [asked, setAsked] = useState(false);

  const load = useCallback(() => {
    void storageInfo().then((next) => {
      setInfo(next);
      setAsked(true);
    });
  }, []);

  useEffect(load, [load]);

  const size = (bytes: number | undefined) =>
    info ? fileSize(bytes ?? 0) : asked ? "unavailable" : "…";

  return (
    <Group
      title="Local store"
      description="Messages, group state and cached profiles live in one encrypted database on this machine."
    >
      <FactRow icon="database" label="Store">
        <span className="font-mono">{info?.storePath ?? String.raw`%APPDATA%\Nexo\store.db`}</span>
      </FactRow>
      <Divider />
      <FactRow icon="lock" label="Messages and keys">
        <span className="font-mono">{size(info?.storeBytes)}</span>
      </FactRow>
      <Divider />
      <FactRow icon="file" label="Cached media">
        <span className="font-mono">{size(info?.cacheBytes)}</span>
      </FactRow>
      <div className="flex items-center justify-between gap-6 py-3">
        <p className="text-text-mid max-w-[52ch] text-meta leading-relaxed">
          Clearing the cache removes downloaded media. Messages stay — they are the store, not
          the cache, and nothing on the server could bring them back.
        </p>
        <Button
          icon="trash"
          disabled={!info}
          onClick={async () => {
            const ok = await confirm(
              "Clear cache",
              "This removes downloaded media from this device. It can be downloaded again later. Your messages are not touched.",
            );
            if (!ok) return;
            const cleared = await clearMediaCache();
            load();
            await notify(
              cleared ? "Cache cleared" : "Couldn't clear the cache",
              cleared
                ? "Downloaded media has been removed from this device."
                : "The cache could not be cleared. Nothing was removed.",
            );
          }}
        >
          Clear cache
        </Button>
      </div>
    </Group>
  );
}

/**
 * About also keeps the IPC boundary honest end to end: the version string is
 * asked of the Rust core rather than read from a bundled constant, so a broken
 * boundary shows up here as plain text instead of a silent stale value.
 */
function About() {
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void appVersion().then(setVersion);
    // There is no updater on the web, and there should not be: a page is
    // whatever the server last served. Saying so is better than a Check button
    // that does nothing, or one that reports a failure that is not one.
    if (!inTauri()) setError("On the web, reloading the page is the update.");
  }, []);

  // The real check, against the update server. Manifests are minisign-signed
  // and verified in Rust against the key pinned in tauri.conf.json, so the
  // server is not trusted — only the key is. A dev build has no key configured
  // and the error says so instead of pretending to have checked.
  async function onCheckUpdate() {
    setChecking(true);
    try {
      const update = await checkUpdate();
      if (!update) {
        await notify("Check for updates", `You're on the latest version (${version ?? "unknown"}).`);
        return;
      }
      const install = await confirm(
        "Update available",
        `Nexo ${update.version} is available. Download and install it now? The app restarts when it's done.`,
      );
      if (install) await installUpdate();
    } catch (raw) {
      await notify(
        "Check for updates",
        raw instanceof Error ? raw.message : String(raw),
      );
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <Group title="Nexo">
        <FactRow icon="info" label="Version">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <span className="font-mono">{version ?? "…"}</span>
          )}
        </FactRow>
        <Divider />
        <FactRow icon="lock" label="Encryption">
          MLS (RFC 9420) via OpenMLS
        </FactRow>
        <Divider />
        <div className="flex items-center justify-between gap-6 py-3">
          <span className="text-text-mid text-meta">
            Updates are minisign-signed; nothing unsigned ever installs.
          </span>
          <Button icon="refresh" disabled={checking} onClick={() => void onCheckUpdate()}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        </div>
      </Group>

      <Group title="Licences">
        <div className="py-3">
          <p className="text-text-mid max-w-[62ch] text-meta leading-relaxed">
            Nexo is MIT licensed. It uses OpenMLS for the protocol and no cryptography written
            here. The full list of dependencies and their licences ships with the app.
          </p>
          <div className="mt-3">
            <Button icon="external" onClick={() => void openUrl("https://github.com/deli-develop/nexo/blob/main/LICENSE")}>
              Open licences
            </Button>
          </div>
        </div>
      </Group>
    </>
  );
}

/**
 * Signing out, from Settings.
 *
 * The same `useSignOut` the rail uses — one path, one confirmation, one busy
 * flag around the *question* rather than only the answer. Two entry points to
 * one behaviour, not two behaviours.
 */
function SignOutRow() {
  const { signOut, busy } = useSignOut();

  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <p className="text-text-mid text-meta">
        Ends this session and deletes everything Nexo keeps on this device: your
        message history, your keys and the unlock PIN. The server does not keep
        delivered messages, so that history cannot come back here. Signing back
        in needs your password.
      </p>
      <Button
        variant="secondary"
        icon="logout"
        onClick={() => void signOut()}
        disabled={busy}
        className="shrink-0"
      >
        Sign out
      </Button>
    </div>
  );
}
