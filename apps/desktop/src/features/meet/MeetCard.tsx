import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { Callout } from "../../components/ui/Feedback";
import { Modal } from "../../components/ui/Modal";
import { block } from "../../lib/blocks";
import { startConversation, sendMessage } from "../../lib/conversations";
import { profile } from "../../lib/feed";
import {
  asMeetError,
  reportUser,
  sendIntro,
  type Pin,
  type ReportReason,
} from "../../lib/meet";
import { NexoChar, type CharConfig } from "./NexoChar";

/**
 * Somebody on the map, and the one message you may send them.
 *
 * The order of the three calls in {@link say} is the whole correctness of the
 * intro, and it is deliberately the opposite of what reads naturally:
 *
 *   1. `startConversation` — the ordinary path. MLS group creation, KeyPackage
 *      consumption and Welcome delivery already work and are not duplicated
 *      here; an intro is a normal conversation with a rule attached.
 *   2. `sendMessage` — the one message, through the ordinary path too.
 *   3. `sendIntro` — only now is the conversation marked as an intro.
 *
 * Doing (3) first would apply the one-message cap before the message existed,
 * so the message would be refused by the rule meant to permit it. Doing (3)
 * after means a failure at that step leaves an ordinary conversation, which is
 * a strictly better wreck than a request pointing at nothing.
 *
 * The cap itself is not enforced here. It is enforced in the delivery
 * service, because a cap the client applies is the same empty promise as a
 * block the client applies.
 */
export function MeetCard({
  pin,
  onClose,
  onBlocked,
}: {
  pin: Pin;
  onClose: () => void;
  /** They are gone from the map now, in both directions. */
  onBlocked: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  async function say() {
    const text = body.trim();
    if (!text) return;
    setBusy(true);
    setProblem(null);
    try {
      const conversationId = await startConversation(pin.handle);
      await sendMessage(conversationId, text);
      await sendIntro(pin.handle, conversationId);
      setSent(true);
    } catch (error) {
      setProblem(asMeetError(error).message);
    } finally {
      setBusy(false);
    }
  }

  async function hide() {
    setBusy(true);
    try {
      await block(pin.handle);
      onBlocked();
    } catch (error) {
      setProblem(asMeetError(error).message);
      setBusy(false);
    }
  }

  async function file(reason: ReportReason) {
    setBusy(true);
    try {
      // The reports table covers posts and comments as well, so it is keyed by
      // a numeric subject rather than a handle. The profile the card is about
      // is where that id comes from.
      const them = await profile(pin.handle);
      await reportUser(them.user_id, reason);
      setReporting(false);
      // Deliberately no confirmation beyond this: whether anybody else has
      // reported them, or what happens next, is not the reporter's to learn.
      setProblem("Thanks — that has been passed on.");
    } catch (error) {
      setProblem(asMeetError(error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal label={`${pin.display_name} on the map`} onClose={onClose}>
      <div className="rounded-panel bg-surface-2 w-full max-w-[420px] border border-line p-5">
        <div className="flex items-start gap-4">
          <NexoChar
            config={(pin.char_config ?? {}) as CharConfig}
            size={96}
            title={`${pin.display_name}'s character`}
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-text-hi font-display truncate text-[17px] font-medium">
              {pin.display_name}
            </h2>
            <p className="text-text-lo truncate text-meta">@{pin.handle}</p>
            {pin.headline ? (
              <p className="text-text-body mt-2 text-[13px]">{pin.headline}</p>
            ) : null}
          </div>
        </div>

        {sent ? (
          <Callout tone="neutral" icon="check" className="mt-4">
            Sent. You can write again once {pin.display_name} answers &mdash;
            that is one message each way until they do.
          </Callout>
        ) : (
          <>
            <label className="mt-4 block">
              <span className="text-text-lo text-meta">
                Say hello &mdash; one message, until they answer
              </span>
              <textarea
                rows={3}
                value={body}
                maxLength={500}
                onChange={(event) => setBody(event.target.value)}
                placeholder={`Why are you writing to ${pin.display_name}?`}
                className="text-text-hi placeholder:text-text-lo rounded-control mt-1.5 w-full resize-none bg-surface-3 px-3 py-2 text-[13px] outline-none focus-visible:ring-1 focus-visible:ring-accent"
              />
            </label>
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                onClick={() => void say()}
                disabled={busy || !body.trim()}
              >
                {busy ? "Sending…" : "Send"}
              </Button>
              <Button onClick={onClose}>Close</Button>
            </div>
          </>
        )}

        {problem ? (
          <Callout tone="warning" icon="alert" className="mt-3">
            {problem}
          </Callout>
        ) : null}

        <div className="border-line mt-4 flex gap-3 border-t pt-3">
          <button
            type="button"
            onClick={() => void hide()}
            disabled={busy}
            className="text-text-lo text-meta hover:text-text-hi"
          >
            Block
          </button>
          <button
            type="button"
            onClick={() => setReporting(true)}
            disabled={busy}
            className="text-text-lo text-meta hover:text-text-hi"
          >
            Report
          </button>
        </div>

        {reporting ? (
          <div className="rounded-control bg-surface-3 mt-3 p-3">
            <p className="text-text-lo mb-2 text-meta">What is wrong?</p>
            <div className="flex flex-wrap gap-2">
              {(
                ["spam", "harassment", "illegal", "impersonation", "other"] as const
              ).map((reason) => (
                <button
                  key={reason}
                  type="button"
                  disabled={busy}
                  onClick={() => void file(reason)}
                  className="rounded-control border-line text-text-lo hover:bg-surface-2 border px-2.5 py-1 text-[12px] capitalize"
                >
                  {reason}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
