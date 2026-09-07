import { Icon } from "../../components/ui/Icon";
import { cn } from "../../lib/cn";

/**
 * §4.4, stated once.
 *
 * The brief asks for a Privacy panel that says exactly what is and is not
 * end-to-end encrypted, in plain language. It appears in Settings and again on
 * the Security tab of your own profile — and it is this component both times,
 * so the wording cannot drift apart between the two places.
 *
 * Rule 5 also bounds the vocabulary: no "military grade", no "unhackable", and
 * no implying that metadata is protected. It is not.
 */
const rows: { data: string; protection: string; e2ee: boolean }[] = [
  {
    data: "Message bodies, attachments and reactions",
    protection: "End-to-end encrypted with MLS. The server stores ciphertext it cannot read.",
    e2ee: true,
  },
  {
    data: "Feed posts and their media",
    protection: "Encrypted in transit and at rest. Readable by the server, public to any signed-in account.",
    e2ee: false,
  },
  {
    data: "Profile picture, banner, display name, handle, bio, location and links",
    protection: "Encrypted in transit and at rest. Readable by the server, and public by design.",
    e2ee: false,
  },
  {
    data: "Call audio and video",
    protection:
      "End-to-end encrypted with DTLS-SRTP, arranged inside an MLS message. The relay forwards packets it cannot read.",
    e2ee: true,
  },
  {
    data: "Conversation and call metadata — who you talk to and call, when, and how long",
    protection:
      "Encrypted in transit and at rest. Visible to the server. Calls are relayed so the other person never learns your IP address; the relay sees both. This is the honest limit of the design.",
    e2ee: false,
  },
];

export function PrivacyTable({ className }: { className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-panel border border-line", className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-fill">
            <th className="text-text-mid px-4 py-2.5 text-[11px] font-medium tracking-[0.06em] uppercase">
              Data
            </th>
            <th className="text-text-mid px-4 py-2.5 text-[11px] font-medium tracking-[0.06em] uppercase">
              Protection
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.data} className="border-t border-[var(--hairline)] align-top">
              <td className="px-4 py-3">
                <span className="flex items-start gap-2">
                  <Icon
                    name={row.e2ee ? "lock" : "globe"}
                    size={15}
                    className={cn("mt-0.5 shrink-0", row.e2ee ? "text-success" : "text-warning")}
                  />
                  <span className="text-text-hi text-meta leading-relaxed">{row.data}</span>
                </span>
              </td>
              <td className="text-text-mid px-4 py-3 text-meta leading-relaxed">
                {row.protection}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
