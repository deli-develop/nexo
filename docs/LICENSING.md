# Licensing

What Nexo is licensed under, who holds the copyright, what shipping a binary
obliges us to do, and where the licence stops covering us. Written for a Swiss
project: the code is MIT, but a warranty disclaimer written for US law does not
survive contact with Art. 100 OR unchanged, and the statutory limits are named
below rather than assumed away.

This file is a description, not legal advice. The three items under
[Not a licensing question](#8-not-a-licensing-question) are the ones worth a
lawyer's hour; nothing in this repository resolves them.

## Quick answers

| Question | Answer | Detail |
|---|---|---|
| What licence? | MIT, the unedited text in [`LICENSE`](../LICENSE). | [§1](#1-what-is-licensed-and-by-whom) |
| Who holds the copyright? | `delidev` — the holder line; two humans behind it, jointly. | [§1.1](#11-the-copyright-holder-delidev) |
| Can one of us relicense alone? | No. Joint authorship, Art. 7 URG: both must consent. | [§1.2](#12-joint-authorship-art-7-urg) |
| May I edit `LICENSE`? | No — not one character. Scanners match it by text. | [§2](#2-why-license-is-not-edited) |
| Does publishing on GitHub discharge the notice duty? | For the source, yes. For the installer, no. | [§3](#3-what-mit-obliges-us-to-do) |
| Is the warranty disclaimer effective in Switzerland? | Partly. Not for intent or gross negligence. | [§4](#4-what-mit-does-not-do-under-swiss-law) |
| Is a green `cargo deny` proof we are clean? | No. It sees crate metadata, not vendored C, and not npm at all. | [§5](#5-dependency-licences) |
| What has to ship next to the `.exe`? | The notices in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md). | [§6](#6-third-party-notices-the-file-that-has-to-ship) |
| Do we need an export licence? | On our reading, no — public open source. | [§7](#7-export-control) |
| Biggest real exposure? | The name, BÜPF/VÜPF, revDSG — none of them licence questions. | [§8](#8-not-a-licensing-question) |

---

## 1. What is licensed, and by whom

Everything in this repository — the Rust crates, the React client, the design
tokens, the scripts and the documentation — is under the **MIT licence**, the
text in [`LICENSE`](../LICENSE). `license = "MIT"` in the workspace
`Cargo.toml` says the same thing for the published crate metadata, and the two
must not drift apart. There is no second licence for the docs, no
non-commercial clause on the design, and no separate terms for the assets: one
licence, whole tree.

That is a deliberate simplification. Split licensing (code MIT, docs CC-BY-SA,
assets "all rights reserved") reads as thorough and behaves as a trap — every
downstream user then has to work out which file falls under which regime, and
the first person to get it wrong is us.

### 1.1 The copyright holder: `delidev`

The copyright line in [`LICENSE`](../LICENSE) reads:

```
Copyright (c) 2026 delidev
```

`delidev` is the name the rights are held under. Two people write code here,
`bananaaboy` and `YungDice`, and the line is a single label over both of them —
it is not a company, not a legal person, and it does not itself own anything.
Under Swiss law copyright arises in the **human being** who creates the work
(Art. 6 URG); a handle, a project name or a brand is at most a way of *naming*
that person, never a substitute for them.

Two consequences follow, and neither is theoretical:

- **A pseudonym is a valid way to hold copyright in Switzerland.** The right
  exists whether or not the real name is published. But enforcing it — sending
  a takedown, suing an infringer, signing a licence for a customer — means
  first proving that `delidev` is you two. Keep something that establishes the
  link, dated and outside this repository: the account recovery records, a
  signed statement between you both, the domain registration. This costs
  nothing now and is unrecoverable later.
- **`delidev` cannot sign anything.** Where a counterparty needs a signature —
  a relicensing agreement, a store listing, an employer waiver — the humans
  sign, not the handle. If that becomes frequent, that is the signal to
  incorporate (a Swiss `Einzelfirma` or `GmbH`) and assign the rights to the
  entity, at which point the copyright line names the entity and this section
  gets shorter.

**Changing the holder name is not a licence change.** This line previously read
`filiusfetish`. Renaming it does not disturb any grant already made: everyone
who received a copy under the old line keeps their MIT permissions in that
copy, because MIT's grant runs with the copy and is not conditioned on the
holder's name staying put. The name identifies the holder for notice and
enforcement purposes; it is not the thing that grants anything. What a rename
*does* require is consistency — a tree where `LICENSE`, the docs and the About
panel name different holders invites exactly the argument you do not want to
have, which is why [`CLAUDE.md`](../CLAUDE.md) and this file are updated in the
same commit as the licence.

### 1.2 Joint authorship (Art. 7 URG)

Because two people contribute creative work to one product, this is
**Miturheberschaft** under Art. 7 URG. What that actually means here:

- The work belongs to both of you **together**. Neither holds a severable half
  of the messenger.
- Using and exploiting it needs **agreement of both** (Art. 7 Abs. 1 URG).
  Consent may not be withheld against good faith (`wider Treu und Glauben`),
  which is a real limit on obstruction but not a workaround.
- **Relicensing needs both signatures.** A later move to Apache-2.0, a dual
  licence, or a commercial licence sold to one customer cannot be done by one
  of you alone. Nor can a change of the copyright line's meaning.
- Where contributions are **separable** (Art. 7 Abs. 4 URG) — say, one of you
  wrote the entire design-token package and nothing else touches it — each may
  exploit their own part separately unless you agree otherwise. In a codebase
  this interwoven, do not rely on that; assume the whole thing is joint.
- Infringement by an outsider may be pursued by **either of you alone**
  (Art. 7 Abs. 3 URG), with damages going to the community. That is the one
  place the law does not require you both to agree.

### 1.3 The authorship record, which does not exist yet

The single cheapest thing in this document, and the one still undone: write the
split down. An informal split is the usual reason an otherwise clean
open-source project cannot be relicensed years on — not malice, just two people
who remember it differently after one of them has moved on.

One page between the two of you, dated and signed, settling:

| Point | What to state |
|---|---|
| Shares | Equal, or a named split. Silence defaults to equal-ish and to argument. |
| Who may license | Either alone, or both jointly (the Art. 7 default). |
| Relicensing | Which licences are pre-agreed (e.g. "either may add Apache-2.0 as a dual licence"), and which need a fresh signature. |
| Exit | What happens if one leaves: does the remaining person get a licence to continue, or must every future decision still be joint? |
| The handle | That `delidev` denotes you both, and who may use it. |
| Employment | Whether either wrote any of this in the course of employment. |

That last row is the trap. **Art. 17 URG transfers software copyright to the
employer by default** where the software is created in an employment
relationship in the fulfilment of contractual duties — no assignment clause
needed, it is the statutory default and it is specific to software. If either
of you wrote any part of Nexo on an employer's time or equipment, or within
what an employment contract describes as your duties, that employer is
plausibly a rights holder here regardless of what `LICENSE` says. The fix is a
short written waiver from the employer, obtained while relations are good.

### 1.4 Contributions from outside: inbound = outbound

There is no CLA and there will not be one. Anyone who opens a pull request
licenses their contribution under the same MIT licence the project is under —
the "inbound = outbound" convention, and the same one the Linux kernel, Rust
and most of the ecosystem run on. The contributor keeps their copyright; we get
an MIT licence to it; nobody signs anything.

What that costs us honestly: because contributors keep their copyright and we
hold only an MIT licence to their work, **a future relicensing needs their
consent too**, not just the two signatures from §1.2. MIT is permissive enough
that a move to Apache-2.0 or a dual licence is workable without it in practice
(MIT code can be redistributed inside an Apache-2.0 work, with the MIT notice
retained), but "workable in practice" is not "clean". If a single outside
contribution ever becomes structurally important, either get a written
relicensing permission from its author at merge time or rewrite it.

A CLA would fix this and cost more than it fixes at this size: it turns a
one-line pull request into a paperwork exercise and is the most reliable way to
lose a drive-by contributor.

### 1.5 No per-file copyright headers

Rust and TypeScript files here carry no `// Copyright (c) 2026 delidev` header,
and this is a decision rather than an oversight. MIT does not require them —
its condition is that the notice travel with copies of the Software, which
`LICENSE` at the root satisfies for a source distribution. Headers rot: they
drift out of date on the year, they get copy-pasted into files written by
someone else, and they cost a diff on every new file to say something already
said once, correctly, at the root.

The exception, if it ever arises: a file lifted from another project keeps
**its** header, unmodified, plus its licence in the notices. That is not
ceremony — it is the actual condition under which we are allowed to have the
file at all.

---

## 2. Why `LICENSE` is not edited

The MIT text in `LICENSE` is byte-for-byte the canonical wording, and it stays
that way. Only the copyright line — holder and year — is ours to touch. This is
deliberate and it is the safest available choice:

- Licence scanners, `cargo deny`, GitHub's licence detection and every
  corporate open-source review match MIT by comparing the text. One added
  sentence turns it into an unrecognised custom licence, which many companies
  are required to reject outright. The failure is silent from our side: we
  never learn that a team dropped Nexo in review.
- Adding a governing-law clause, a liability cap or a Swiss venue to the MIT
  text would not make MIT stronger — it would make it something that is no
  longer MIT while still being labelled as such, which is worse than either
  option on its own.
- A modified MIT is also unusable as a dependency by anyone with an
  allowlist-based policy, which is most of the same corporate reviewers, and it
  makes SPDX identification impossible: there is no expression for
  "MIT plus a sentence we added".

Everything that needs saying about Swiss law is therefore said here, in prose,
outside the licence. If some day a real clause is genuinely needed — a patent
grant, say — the answer is to **change licence** (to Apache-2.0, which has one)
under §1.2, not to edit this one.

---

## 3. What MIT obliges *us* to do

MIT is short but it is not free of duties, and the duty lands on the
distributor — us:

> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.

Two distributions, two different answers:

**The source, on GitHub.** Satisfied. `LICENSE` sits at the root of every clone,
tarball and zip GitHub generates, so the notice travels with the copy
automatically. Nothing to do.

**The installer, `Nexo_x.y.z_x64-setup.exe`.** Not satisfied on its own. A
binary installer is a copy of the Software, so the copyright notice and the
permission notice have to travel with it — **ours and every dependency's**
whose licence says the same thing (MIT, BSD-2, BSD-3, ISC, Apache-2.0, Zlib,
OFL all do). A user who installs Nexo and never visits GitHub must still be
able to read them.

That is a release step, not a repository state. The brief reserves the place for
it: §236's **About panel** ("version, licences, update check") is where the
notices belong, and [`docs/RELEASING.md`](RELEASING.md#third-party-notices)
records it as part of what has to be true before a build is announced.

### 3.1 What the About panel currently claims

Settings → About, in `apps/desktop/src/features/settings/SettingsPage.tsx`,
says:

> Nexo is MIT licensed. It uses OpenMLS for the protocol and no cryptography
> written here. The full list of dependencies and their licences ships with the
> app.

The last sentence is **not true today**. The button beside it opens
`https://github.com/deli-develop/nexo/blob/main/LICENSE` in the system browser —
Nexo's own licence, fetched over the network, from a machine that might be
offline and a repository that might one day move. No dependency list ships with
the app, because none is generated at build time.

That is the gap, stated plainly so it is not rediscovered later. Closing it is
two pieces of work, both recorded in [`RELEASING.md`](RELEASING.md#third-party-notices):

1. Generate the notices at release time and embed the result, so the panel
   reads from a bundled file rather than the network.
2. Until it is embedded, the copy should describe what actually happens
   ("opens the licence on GitHub") rather than what is planned.

A false statement about licensing in shipped UI is a bad place to be sloppy: it
is the one claim a licence-compliance reviewer will check first, and it is
checkable in ten seconds.

---

## 4. What MIT does not do, under Swiss law

The all-caps paragraph in `LICENSE` disclaims warranty and liability in terms
written for US law. In Switzerland it is partially enforceable, and it is worth
knowing exactly which part:

- **Liability for intent and gross negligence cannot be excluded in advance.**
  Art. 100 Abs. 1 OR voids such a clause outright. No wording in `LICENSE`
  changes this, and the all-caps typography does not help — Swiss law has no
  conspicuousness doctrine that makes shouted text more binding.
- **Ordinary negligence is covered**, which is most of what the disclaimer is
  there for. Art. 100 Abs. 2 OR still lets a court disregard even that
  exclusion at its discretion in some settings, but the base case holds.
- **Product liability for personal injury or damage to private property cannot
  be excluded at all** — Art. 8 PrHG. For a messenger this is close to
  theoretical, but no wording removes it, and it is worth remembering the day
  someone proposes a hardware or automotive integration.
- Because the software is handed over **free of charge**, the standard of care
  is measured against a gratuitous transfer (Schenkung, Art. 248 OR) rather
  than a sale. That works in our favour, and it stops working the moment money
  changes hands for the software itself.
- **MIT names no governing law and no venue.** For a Swiss rights holder and a
  Swiss user the IPRG decides, and the answer depends on the dispute — for
  infringement, typically the law of the country for which protection is
  claimed. This is a gap in MIT, not a defect in this repository, and it is not
  fixable by editing the licence (see §2).

The distinction that actually matters: **MIT licenses the software; it says
nothing about operating the service.** The moment `api.delidev.net` accepts a
registration, that is a separate legal relationship with a user, governed by
terms of service and a privacy notice that do not exist in this repository yet.
No licence text will stand in for them, and the disclaimer above protects the
code, not the server.

---

## 5. Dependency licences

Everything Nexo ships that was written by someone else, in three groups: the
Rust crates (gated), the npm packages (**not** gated), and the vendored C and
font binaries (invisible to both gates).

### 5.1 The Rust side, and the gate that enforces it

[`deny.toml`](../deny.toml) allows permissive licences only, and CI fails on
anything else — two passes, one per target, because the client and the server
have disjoint dependency graphs. The reason is recorded there and it is a real
one: `libsignal` is AGPL-3.0-only, and linking it into a distributed desktop
client would push copyleft onto the whole application. OpenMLS is MIT, which is
why it is the crypto core.

What each allowed family asks of us as a distributor:

| Licence | What it obliges |
|---|---|
| MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib | Ship the copyright and permission notice with the binary. |
| Apache-2.0 (incl. WITH LLVM-exception) | §4: ship the licence, pass on any `NOTICE` file, mark modified files. Also grants a **patent licence** — a reason to prefer it, not merely tolerate it. |
| MPL-2.0 | **File-level copyleft.** Unmodified use as a library needs only the notice and a pointer to upstream source. If we ever *modify* an MPL file and ship it, that file's source must be made available. In this tree the crate is `option-ext 0.2.0`, reached through `dirs-sys`; we do not modify it. |
| Unicode-3.0, CDLA-Permissive-2.0 | Data licences, no copyleft. `webpki-roots` carries Mozilla's root CA bundle under CDLA-Permissive-2.0 — certificate data, not code. |
| BSL-1.0, CC0-1.0 | Notice-only and public-domain-equivalent respectively. |
| `OpenSSL` | The **old** OpenSSL/SSLeay licence, and the only entry on the list with a clause that reaches beyond the binary — see §5.2. |

`[bans]` in the same file denies `libsignal-protocol` (AGPL) and `openssl` (the
crate) by name, so the two failure modes that would actually hurt fail loudly
rather than being noticed at review time.

### 5.2 The advertising clause, precisely

`aws-lc-sys 0.44.0` (pulled in by `jsonwebtoken`'s `aws_lc_rs` backend and by
the S3 SDK's TLS) declares `OpenSSL` in its SPDX expression, because it carries
BoringSSL/OpenSSL-derived C code. Clause 3 of that licence requires an
acknowledgement in **advertising materials** mentioning features or use of the
software:

> This product includes software developed by the OpenSSL Project for use in the
> OpenSSL Toolkit.

Read literally that reaches wherever the app is offered for download — today
the GitHub release page, since there is no separate marketing host any more —
not just the About panel. The cheap and complete answer is to carry the
acknowledgement in the third-party notices **and** wherever the download is
offered, and then stop thinking about it. It is one sentence; arguing about whether a download page
counts as advertising costs more than complying.

Note the contrast, because it is easy to get backwards: `openssl-src 300.6.1`
vendors **OpenSSL 3.6.3**, and OpenSSL relicensed to **Apache-2.0 as of 3.0** —
that copy carries *no* advertising clause. The clause comes from `aws-lc-sys`,
not from OpenSSL itself. The `OpenSSL` entry in `deny.toml` is therefore earning
its place for a different crate than the comment history suggests, and is worth
re-reading next time that list is touched.

### 5.3 The blind spot in the cargo gate

**`cargo deny` reads crate metadata, not vendored C source.** Two of the native
libraries we ship are invisible to it:

- `libsqlite3-sys 0.30.1` declares `MIT` — its own wrapper code. What it
  actually compiles, under the `bundled-sqlcipher-vendored-openssl` feature, is
  **SQLCipher** (BSD-3-clause, © Zetetic LLC) and **OpenSSL 3.6.3**
  (Apache-2.0). Neither notice is in any crate's `license` field.
- The same applies to `aws-lc-sys`'s bundled C, which is where the clause in
  §5.2 comes from, and which additionally carries ISC and OpenSSL-licensed
  code from BoringSSL.

So a green `cargo deny check licenses` does **not** mean the notices we ship are
complete. The Zetetic copyright and the two OpenSSL-related notices have to be
carried by hand. Together with the fonts in §5.5 this is the single most likely
way for this project to be in technical breach of a licence, and it is entirely
avoidable.

Generating the list of the rest is mechanical:

```powershell
cargo install cargo-about
cargo about generate --format json > third-party-notices.json
```

`cargo-about` has the same blind spot, so the vendored notices are **appended**
to whatever it produces, not replaced by it.

### 5.4 The npm side, which has no gate at all

This is the part that is easy to forget, because the word "dependency" in a
Rust workspace tends to mean "crate". CI runs `pnpm audit --audit-level=moderate`
for **vulnerabilities**; nothing anywhere checks npm **licences**. And these
packages are not a build-time detail: `pnpm build` bundles them into
`apps/desktop/dist`, which the Rust client embeds into the executable. They
ship, in the literal sense.

What is in the shipped bundle, with the licence each declares:

| Package | Licence | Note |
|---|---|---|
| `react`, `react-dom` 19.2.8 | MIT | © Meta Platforms. |
| `zustand` 5.0.15 | MIT | |
| `@tanstack/react-query` 5.102.2 | MIT | |
| `@tauri-apps/api` 2.11.1 and the four plugins | MIT **OR** Apache-2.0 | Dual — we may pick either. Record the choice once in the notices rather than per file. |
| `unicode-emoji-json` 0.9.0 | MIT (package) | The **data** is derived from Unicode's emoji files — see §5.6. |
| `tailwindcss` 4.3.3 | MIT | A devDependency whose **output ships**, including Preflight — see below. |
| `@fontsource-variable/inter`, `@fontsource/jetbrains-mono` 5.3.0 | MIT (packaging) / **OFL-1.1** (the fonts) | The important one — §5.5. |

Two subtleties worth stating, because both are the kind of thing a reviewer
notices and we would otherwise not have an answer for:

- **Tailwind is a devDependency, but its bytes ship.** The generated utility CSS
  is our own composition, but **Preflight**, Tailwind's base reset, is copied
  text derived from `modern-normalize` (MIT). It lands in the bundle verbatim.
  MIT-licensed, so the duty is the ordinary one: carry the notice.
- **TypeScript and Vite do not ship.** A compiler's output is our code, not a
  copy of the compiler. `typescript` (Apache-2.0), `vite`, `vitest` and the
  `@types/*` packages therefore belong to the build, not to the notices — the
  distinction is *does a byte of it end up in the installer*, and for these the
  answer is no.

**The gap, and the fix.** Until an npm licence check exists, the list above is
maintained by reading `apps/desktop/package.json`, which is short enough that
this is honest work rather than a pretence. The mechanical check, for when it
is worth wiring into `scripts/check.ps1` and CI beside `cargo deny`:

```powershell
pnpm licenses list --prod          # what is actually installed, by licence
pnpm licenses list --prod --json   # the same, for a notices generator
```

A `pnpm licenses list --prod` whose output contains anything outside
MIT / Apache-2.0 / BSD / ISC / OFL-1.1 / CC0 is a finding, and should be treated
the way a `cargo deny` failure is treated: fixed or written down with a reason,
not waved through.

### 5.5 The fonts, and why OFL is not just another MIT

Nexo bundles two typefaces, and they are the only dependencies in the tree
under a licence family neither gate understands:

| Font | Licence | Holder |
|---|---|---|
| **Inter** (variable) | SIL Open Font License 1.1 | © Rasmus Andersson |
| **JetBrains Mono** | SIL Open Font License 1.1 | © JetBrains s.r.o. |

The `@fontsource*` npm packages are MIT — that covers Fontsource's *packaging*,
the CSS and the build tooling. **The font files inside are OFL-1.1**, and the
OFL is where the actual obligations live. Its terms are permissive but they are
not MIT's, and three of them bite for a desktop app:

- **The notice travels, and so does the licence.** OFL §2: the fonts may be
  bundled and redistributed, but each copy must carry the above copyright
  notices and the full OFL text. Shipping the `.woff2` inside our bundle is
  redistribution. This is the same duty as MIT and it is the one we are
  currently not discharging.
- **Reserved Font Names.** OFL §3 forbids distributing a *modified* version
  under the original name. If anyone ever subsets, re-hints, or otherwise
  regenerates Inter for a smaller bundle, the result must not be shipped as
  "Inter". Subsetting is a normal optimisation and this is exactly how a
  project trips over it. If we subset, we rename.
- **They may not be sold on their own.** OFL §1: the fonts, alone or bundled,
  may not be sold by themselves. Bundled *with software* — which is us — is
  explicitly fine, including commercially. No issue today; a "Nexo font pack"
  download would be one.

The OFL also has no patent grant and no trademark grant, so neither font's name
comes with permission to use it as a brand. We do not, so this is a note rather
than a problem.

### 5.6 Emoji data

`unicode-emoji-json` is MIT as a package, but what it contains is derived from
the Unicode Consortium's emoji data files. That data is under the **Unicode
licence** (`Unicode-3.0`), which `deny.toml` already allows on the Rust side for
the same underlying reason. Its condition is a notice condition: carry the
Unicode copyright and permission notice with copies of the data.

Note what we do **not** ship: no emoji *images*. The picker renders the
platform's own font (Segoe UI Emoji on Windows), which is Microsoft's, present
on the machine already, and not redistributed by us. That is a licensing
non-event and it is worth keeping that way — bundling an emoji image set (Twemoji,
Noto Emoji) would add a CC-BY or OFL obligation and several megabytes.

### 5.7 What we wrote ourselves

For completeness, because "did you get this from somewhere" is the other half of
the question:

- **Icons** are inline SVG drawn in this repository. No icon set is vendored, no
  attribution is owed, and nothing is fetched at runtime — the CSP has no remote
  image host to allow.
- **Avatars, banners and media placeholders** are gradients derived
  deterministically from a handle or an id. Generated, not licensed.
- **The design tokens** in `packages/design-tokens` are ours.
- **The colour and type scale** are choices, not copied assets. Type *choices*
  are not protectable in any case; the font files that render them are, which is
  §5.5.

---

## 6. Third-party notices: the file that has to ship

[`docs/THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) is the working document
for the duty in §3: what has to be in front of a user who installed the `.exe`
and never opens GitHub. It carries, in full text, the notices that no tool can
produce for us — SQLCipher, the two OpenSSL-derived components, and the two
OFL fonts — plus the commands that generate the mechanical remainder and the
checklist that says when it is complete.

Keeping it in `docs/` rather than at the repository root is intentional: the
root file would imply it is complete and current at all times, when in fact its
generated half is produced at release time. `RELEASING.md` owns the moment it
must be regenerated.

---

## 7. Export control

Nexo is cryptographic software, so Swiss export control is a fair question. The
short version:

- Cryptography for data confidentiality falls under **dual-use category 5 part
  2**, implemented in Switzerland through the **GKG** (Güterkontrollgesetz) and
  **GKV** (Güterkontrollverordnung), following the Wassenaar lists.
- Software **in the public domain** — publicly available without restriction on
  further dissemination — is outside those lists. The source is public on
  GitHub, so the source distribution is not controlled.
- For the compiled installer, the **General Software Note** exempts software
  that is generally available to the public, downloadable by anyone without
  restriction and installable by the user without further support from us. A
  free public GitHub release matches that.

Our reading is therefore that no export licence is required for what this
project does today. Three things would change the analysis and should trigger a
question to **SECO** before they happen: selling the client commercially or
under a restrictive agreement; adding cryptographic functionality that is not
publicly available open source; and restricting who may download it (a gated
beta, a login wall on the installer), because "generally available to the
public" is the whole basis of the exemption.

---

## 8. Not a licensing question

These are outside what any licence file can settle, and they are where the real
exposure is:

- **The name.** "Nexo" is in active trademark use by an unrelated company in
  crypto-finance, and "nexo" is also the name of a card-payment standard.
  Classes 9, 38 and 42 — software, telecommunications, hosted services — are
  exactly this product's classes. Before a public launch, a store listing or any
  paid promotion, run a search on **Swissreg** and **EUIPO** for the classes we
  would occupy. A rename is cheap now and expensive after the first install
  base. Note that this is independent of the copyright position in §1: holding
  the copyright cleanly under `delidev` says nothing about whether we may call
  the product Nexo.
- **BÜPF / VÜPF.** Operating a communications service from Switzerland makes us
  at minimum a *provider of derived communication services* (Anbieterin
  abgeleiteter Kommunikationsdienste, Art. 2 BÜPF), with duties to cooperate
  with lawful surveillance requests. End-to-end encryption is not a way out of
  those duties: what is owed is the data we hold, and
  [`README.md`](../README.md) is already blunt that we hold conversation
  metadata — who talked to whom, when, and message sizes. That is precisely the
  category that gets requested. The Threema litigation is the relevant
  precedent on how lightly a small E2EE provider can be classified.
- **revDSG and GDPR.** A privacy notice, a record of processing, and a data
  processing agreement with Hetzner (an EU/EEA processor, so no transfer
  problem) are required before real users exist — not because of the licence,
  but because of the service.
