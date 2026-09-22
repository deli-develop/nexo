import { markVerified } from "../../lib/conversations";
import { fileSize, relativeTime, safetyNumber } from "../../lib/format";
import { confirm, notify } from "../../lib/native";
import { asConversationError, saveAttachment } from "../../lib/conversations";
import { fieldFor, fileTone } from "../../lib/palette";
import type { Attachment, Conversation, Message } from "../../lib/types";
import { IconButton } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { Panel } from "../../components/ui/Surface";
import { cn } from "../../lib/cn";
import { pinnedLine } from "./pinned";

/**
 * The 280px context panel (§6.1, §7.3).
 *
 * Everything in it comes from the local decrypted store — there is no
 * server-side index of what was shared in a conversation, and there cannot be
 * one: the server holds ciphertext (rule 4).
 *
 * The panel has no header of its own; its actions live in the top row, so the
 * column reads as one continuous strip from the window edge down.
 */
export function ContextPanel({
  conversation,
  now,
  onRefresh,
  messages = [],
}: {
  conversation: Conversation;
  now: Date;
  /// Re-reads conversations after something changed their stored state.
  onRefresh: () => Promise<void>;
  /// The open conversation, so pinned messages can be listed from it.
  messages?: Message[];
}) {
  // Pinned on this device, newest first. Read from what is already loaded
  // rather than fetched: the list is the same messages, and a second source
  // would be a second thing to keep in step.
  const pinned = messages.filter((m) => m.pinned).reverse();
  // Attachments live inside the messages in the encrypted store and nothing
  // indexes them per conversation yet, so there is nothing to list. Empty is
  // the honest showing; the sections below already say so.
  const shared: Array<{ attachment: Attachment; at: Date }> = [];
  const images = shared.filter(({ attachment }) => attachment.kind === "image");
  const files = shared.filter(({ attachment }) => attachment.kind === "file");

  return (
    <Panel
      tone="list"
      edge={false}
      className="flex w-[280px] shrink-0 flex-col border-l border-[var(--hairline)]"
    >
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5">
        {pinned.length > 0 ? (
          <section className="space-y-3">
            {/* "on this device" is not a nicety. A shared pin has no
                enforceable cap -- the server may not read a payload, so it
                cannot count -- so claiming everyone sees this would be a
                promise nothing here can keep. */}
            <SectionHead label="Pinned on this device" onSeeAll={false} />
            <ul className="space-y-2">
              {pinned.map((message) => {
                const line = pinnedLine(message);
                return (
                  <li
                    key={message.id}
                    className="rounded-control bg-surface-2 px-3 py-2"
                  >
                    <p className="flex items-start gap-1.5">
                      {line.icon ? (
                        <Icon
                          name={line.icon}
                          size={12}
                          className="text-text-lo mt-[3px] shrink-0"
                        />
                      ) : null}
                      <span
                        className={cn(
                          "line-clamp-3 min-w-0 flex-1 text-[12px]",
                          // The app describing the message reads quieter than
                          // the message itself. A file name in the same weight
                          // as somebody's words reads as their words.
                          line.described
                            ? "text-text-lo italic"
                            : "text-text-body",
                        )}
                      >
                        {line.text}
                      </span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="space-y-3">
          <SectionHead
            label="Shared media"
            onSeeAll={images.length > 5}
            onClick={() =>
              void notify(
                "Shared media",
                `${images.length} image${images.length === 1 ? "" : "s"} shared in this conversation. A dedicated gallery view arrives with the media milestone.`,
              )
            }
          />
          {images.length === 0 ? (
            <p className="text-text-lo text-meta">Nothing shared yet.</p>
          ) : (
            <div className="flex gap-2">
              {images.slice(0, 5).map(({ attachment }) => (
                <button
                  key={attachment.id}
                  type="button"
                  aria-label={attachment.name}
                  title={attachment.name}
                  onClick={() =>
                    void notify(
                      attachment.name,
                      "Full-size preview arrives with the media milestone.",
                    )
                  }
                  className="size-11 shrink-0 rounded-[10px] ring-1 ring-line-strong transition-transform duration-[var(--motion-fast)] ease-[var(--ease-state)] hover:-translate-y-0.5"
                  style={{ background: fieldFor(attachment.id) }}
                />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <SectionHead
            label="Shared files"
            onSeeAll={files.length > 3}
            onClick={() =>
              void notify(
                "Shared files",
                `${files.length} file${files.length === 1 ? "" : "s"} shared in this conversation.`,
              )
            }
          />
          <ul>
            {files.slice(0, 3).map(({ attachment, at }) => {
              const tone = fileTone(attachment.name);
              return (
                <li
                  key={attachment.id}
                  className="flex items-center gap-3 py-2"
                >
                  <span
                    className="text-text-hi flex size-9 shrink-0 items-center justify-center rounded-[10px] font-mono text-[9px] font-semibold"
                    style={{ background: tone.tint }}
                    aria-hidden="true"
                  >
                    {tone.label}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-text-hi block truncate text-meta">
                      {attachment.name}
                    </span>
                    <span className="text-text-lo block text-[11px]">
                      {relativeTime(at, now)} · {fileSize(attachment.size)}
                    </span>
                  </span>
                  <IconButton
                    name="download"
                    label={`Save ${attachment.name}`}
                    size={15}
                    onClick={() => void saveSharedFile(attachment)}
                  />
                </li>
              );
            })}
            {files.length === 0 ? (
              <li className="text-text-lo text-meta">Nothing shared yet.</li>
            ) : null}
          </ul>
        </section>

        <section className="space-y-2">
          {/* Link collection has no source yet: previews are generated
              client-side per message (§4.5) and nothing indexes them per
              conversation. An empty section is the honest showing -- inventing
              a list here would be the one thing rule 7 forbids. */}
          <SectionHead label="Shared links" onSeeAll={false} />
          <ul>
            <li className="text-text-lo text-meta">Nothing shared yet.</li>
          </ul>
        </section>

        <Encryption conversation={conversation} onVerified={onRefresh} />
      </div>
    </Panel>
  );
}

/**
 * Sentence case, at reading size, with the overflow affordance on the right.
 * Tracked-out uppercase micro-labels are a habit, not a decision, and they
 * make every section shout the same volume as the content under it.
 */
function SectionHead({
  label,
  onSeeAll,
  onClick,
}: {
  label: string;
  onSeeAll: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-text-hi text-body font-medium">{label}</h2>
      {onSeeAll ? (
        <button
          type="button"
          onClick={onClick}
          className="text-accent-soft text-[11px] transition-opacity duration-[var(--motion-fast)] hover:opacity-80"
        >
          See all
        </button>
      ) : null}
    </div>
  );
}

/**
 * §4.1: the safety number is SHA-256 over both identity public keys, rendered
 * as 12 groups of 5 digits in the mono face so two people can read it aloud to
 * each other without ambiguity. M1 shows a mock number; M4 shows the real one.
 *
 * It states the unverified case in a sentence rather than a bordered warning
 * box. Unverified is the normal state of a new conversation — a standing alarm
 * for the normal state is how people learn to ignore alarms. The loud,
 * undismissable banner §4.1 asks for is for a key that *changes*, and that
 * arrives with real keys in M4.
 */
function Encryption({
  conversation,
  onVerified,
}: {
  conversation: Conversation;
  /// Re-reads the conversation, so the mark shows without waiting for a sync.
  onVerified: () => Promise<void>;
}) {
  const groups = safetyNumber(conversation.safetyDigits);

  // A group has no number to compare, and must not be offered one.
  //
  // A safety number is a fingerprint over *two* identity keys, so
  // `safety_number` returns nothing for a conversation with more than two
  // people in it. This panel used to render the compare-these-digits
  // instruction anyway, above an empty box, with a live "Mark as verified"
  // underneath -- and pressing it recorded a verification that had compared
  // nothing and then said so: "You compared these digits with this group and
  // they matched", beside a green shield. That is the overstatement rule 5
  // exists to prevent, in the one place in the app where being wrong about
  // what is proven matters most.
  if (groups.length === 0) {
    return (
      <section className="space-y-3">
        <SectionHead label="Encryption" onSeeAll={false} />
        <p className="text-text-mid text-meta leading-relaxed">
          <Icon
            name="shield"
            size={13}
            className="text-text-lo mr-1.5 inline align-[-2px]"
          />
          Messages here are end-to-end encrypted, and only the people in this
          conversation can read them. There is nothing to compare: safety
          numbers are a fingerprint over two people&rsquo;s keys, so they exist
          in a one-to-one conversation and not in a group. To verify somebody
          here, open the conversation you have with them alone.
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHead label="Encryption" onSeeAll={false} />

      <p className="text-text-mid text-meta leading-relaxed">
        {conversation.verified ? (
          <>
            <Icon
              name="shield"
              size={13}
              className="text-success mr-1.5 inline align-[-2px]"
            />
            You compared these digits with{" "}
            {conversation.kind === "dm" ? conversation.title : "this group"} and
            they matched.
          </>
        ) : (
          <>
            <Icon
              name="shield"
              size={13}
              className="text-text-lo mr-1.5 inline align-[-2px]"
            />
            Compare these digits over a channel you already trust. Until you do,
            nothing proves the keys belong to who you think.
          </>
        )}
      </p>

      <div className="rounded-control border border-line bg-fill px-3 py-2.5">
        <div className="text-text-mid grid grid-cols-4 gap-x-2 gap-y-1 text-center font-mono text-[11px] tracking-[0.02em]">
          {groups.map((group, index) => (
            <span key={`${group}-${index}`}>{group}</span>
          ))}
        </div>
      </div>

      <div className="flex items-center">
        <button
          type="button"
          onClick={async () => {
            if (conversation.verified) {
              await notify(
                "Compare again",
                "Read the digits above with the other side and confirm they match before marking it verified again.",
              );
              return;
            }
            const ok = await confirm(
              "Mark as verified",
              "Only confirm this if you've actually compared these digits with the other side and they matched.",
            );
            if (ok) {
              // Recorded in the encrypted store against the keys that are
              // current right now, so a later change clears it by itself.
              await markVerified(conversation.id);
              await onVerified();
            }
          }}
          className="text-accent-soft text-meta transition-opacity duration-[var(--motion-fast)] hover:opacity-80"
        >
          {conversation.verified ? "Compare again" : "Mark as verified"}
        </button>
      </div>
    </section>
  );
}

/**
 * Saves a file listed in the Shared panel.
 *
 * Same path as the bubble's download button, and the same rule 7 behaviour: a
 * failure is shown, never swallowed. Kept as a plain function rather than a
 * hook because this list has no per-row busy state to track -- the dialog is
 * the interaction, and it is modal.
 */
async function saveSharedFile(attachment: {
  id: string;
  name: string;
}): Promise<void> {
  try {
    await saveAttachment(Number(attachment.id));
  } catch (error) {
    await notify("Couldn't save that file", asConversationError(error).message);
  }
}
