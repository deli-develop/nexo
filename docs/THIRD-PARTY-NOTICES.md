# Third-party notices

The notices that have to reach someone who installed `Nexo_x.y.z_x64-setup.exe`
and never opens GitHub. [`LICENSING.md`](LICENSING.md#3-what-mit-obliges-us-to-do)
explains why the duty exists; this file is the working copy of what discharges
it, and [`RELEASING.md`](RELEASING.md#third-party-notices) says when to
regenerate it.

The document has two halves, and the split is the whole point:

- **[Generated](#the-generated-half)** — the several hundred crate and package
  notices a tool can produce. Never written by hand.
- **[By hand](#the-hand-written-half)** — seven notices no tool in this
  repository can see, because they live in vendored C source and font
  binaries. This half is why the file exists.

A release that ships only the generated half is in technical breach of at least
three licences. That is not a dramatic statement; it is what §5.3 and §5.5 of
[`LICENSING.md`](LICENSING.md) describe.

---

## The generated half

Two tools, one per ecosystem. Run both; neither covers the other.

```powershell
# Rust — every crate in both target graphs
cargo install cargo-about
cargo about generate --format json > third-party-notices.json

# JavaScript — everything pnpm actually installs for production
pnpm licenses list --prod --json > third-party-notices.npm.json
```

Neither output is committed. Both are build inputs, regenerated when
dependencies change — which is what `Cargo.lock` and `pnpm-lock.yaml` moving in
a diff means.

`cargo about` needs `about.toml` beside it to know which licence texts to
accept; the allow-list there must match `deny.toml`'s, or the generator will
silently omit a crate whose licence CI has already approved.

---

## The hand-written half

Six notices. Each entry gives what it covers, where the authoritative text
lives, and what must be copied. **Copy the text from the path named — do not
retype it, and do not trust the reproduction below to be byte-exact.** The
excerpts here exist so a reviewer can see what is owed without a build tree
present.

### 1. SQLCipher — BSD-3-Clause, © Zetetic LLC

Reached through `libsqlite3-sys 0.30.1` with the
`bundled-sqlcipher-vendored-openssl` feature. The crate declares `MIT` for its
own wrapper code, so neither `cargo deny` nor `cargo about` will ever mention
Zetetic. Every encrypted byte in `store.db` goes through this library.

**Authoritative text:** `LICENSE` at the root of the vendored SQLCipher tree,
under `target/<profile>/build/libsqlite3-sys-*/out/` after a build.

What it requires, in the binary case: reproduce the copyright notice, the
condition list and the disclaimer in the documentation or other materials
provided with the distribution — the About panel is those materials — and do
not use the Zetetic name to endorse Nexo.

```
Copyright (c) 2008-2012 Zetetic LLC
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the ZETETIC LLC nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

[disclaimer follows — copy the full text from the path above]
```

### 2. SQLite — public domain

SQLCipher is a fork of SQLite, whose own code its authors placed in the public
domain. Nothing is legally owed. The customary acknowledgement is cheap and
signals that the dependency was understood rather than missed:

```
This product includes software derived from SQLite, whose authors have
dedicated it to the public domain.
```

### 3. OpenSSL 3.6.3 — Apache-2.0

Vendored by `openssl-src`, built because SQLCipher needs a crypto provider.
**This copy carries no advertising clause** — OpenSSL relicensed to Apache-2.0
as of 3.0. Do not confuse it with entry 4.

**Authoritative text:** `LICENSE.txt` in the vendored OpenSSL tree, under
`target/<profile>/build/openssl-src-*/`.

Apache-2.0 §4 requires shipping the full licence text, passing on any `NOTICE`
file found in the source, and stating that files were modified if we modify any
(we do not). The full text is ~11 KB and must be included verbatim, not
summarised.

### 4. aws-lc-sys / BoringSSL — ISC, OpenSSL and SSLeay licences

Reached twice: `jsonwebtoken`'s `aws_lc_rs` backend on the server, and the AWS
S3 SDK's TLS. Its SPDX expression declares `OpenSSL`, which is the **old**
OpenSSL/SSLeay licence, and clause 3 of that licence is the only obligation in
this entire tree that reaches beyond the binary:

> This product includes software developed by the OpenSSL Project for use in
> the OpenSSL Toolkit.

That sentence must appear in **advertising materials mentioning features or use
of the software**. Read literally, that includes wherever the app is offered for
download — the GitHub release page today — not only the About panel. Put it in both and stop thinking
about it — see [`LICENSING.md` §5.2](LICENSING.md#52-the-advertising-clause-precisely).

The SSLeay half of the same licence carries its own acknowledgement, applicable
to the parts of the code that originate there:

> This product includes cryptographic software written by Eric Young
> (eay@cryptsoft.com).

**Authoritative text:** `LICENSE` in the `aws-lc-sys` crate source, which
carries the ISC, OpenSSL and SSLeay texts together.

### 5. Inter — SIL Open Font License 1.1, © Rasmus Andersson

Shipped as a variable `.woff2` inside the bundle, via
`@fontsource-variable/inter`. The npm package is MIT — that covers Fontsource's
packaging and CSS, not the font.

**Authoritative text:** `LICENSE` inside
`node_modules/@fontsource-variable/inter/`, which carries the OFL 1.1 in full
(~4 KB). It must be reproduced verbatim, along with:

```
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)
This Font Software is licensed under the SIL Open Font License, Version 1.1.
```

**"Inter" is a Reserved Font Name.** If the font is ever subsetted, re-hinted or
otherwise modified before shipping — a normal bundle-size optimisation — the
result may not be distributed under that name. Subset, then rename.

### 6. JetBrains Mono — SIL Open Font License 1.1, © JetBrains s.r.o.

Shipped the same way, via `@fontsource/jetbrains-mono`, and under the same
terms.

**Authoritative text:** `LICENSE` inside
`node_modules/@fontsource/jetbrains-mono/`.

```
Copyright (c) 2020 The JetBrains Mono Project Authors
(https://github.com/JetBrains/JetBrainsMono)
This Font Software is licensed under the SIL Open Font License, Version 1.1.
```

"JetBrains Mono" is likewise a Reserved Font Name, and JetBrains' trademark
rights in the name are separate from the font licence entirely.

### 7. Unicode emoji data — Unicode licence

`unicode-emoji-json` is MIT as a package; the data inside is derived from the
Unicode Consortium's emoji files and carries the Unicode copyright and
permission notice with it.

We ship no emoji **images** — the picker renders the platform font, which is
already on the machine and is not ours to redistribute. Keep it that way; a
bundled emoji set would add a CC-BY or OFL obligation and several megabytes.

---

## Where these end up

The brief reserves Settings → About (§236: "version, licences, update check")
for this. The panel today opens `LICENSE` on GitHub in the system browser and
tells the user that "the full list of dependencies and their licences ships with
the app", which is not yet true — recorded as an open gap in
[`LICENSING.md` §3.1](LICENSING.md#31-what-the-about-panel-currently-claims).

What closing it looks like:

1. Both generators run at release time; their output plus this file's
   hand-written half are concatenated into one plain-text notices file.
2. The file is embedded in the client the way `apps/desktop/dist` is embedded —
   no network fetch, because an offline machine has the same right to read the
   notices as an online one.
3. The About panel opens it locally. The GitHub link stays as a convenience, not
   as the mechanism.
4. The OpenSSL acknowledgement from entry 4 additionally goes in the
   download page footer.

Until step 2 exists, the honest interim is to fix the sentence in the panel to
describe what the button actually does.

---

## Release checklist

Everything below must be true before a build is announced. `RELEASING.md` is
where this is enforced; this is the licensing half of its list.

- [ ] `cargo about generate` run against the current `Cargo.lock`, for **both**
      target graphs — the Windows client and the Linux server have different
      dependency trees.
- [ ] `pnpm licenses list --prod` run against the current `pnpm-lock.yaml`, and
      nothing in its output falls outside
      MIT / Apache-2.0 / BSD / ISC / OFL-1.1 / CC0.
- [ ] All seven hand-written entries above present, with full licence texts
      copied from the paths named — not from this file.
- [ ] The OpenSSL advertising acknowledgement present in the notices **and** in
      the download page footer.
- [ ] Nexo's own notice present: `Copyright (c) 2026 delidev`, plus the MIT
      permission notice.
- [ ] The notices are readable **offline**, from inside the installed app.
- [ ] No font was subsetted or modified while still carrying its Reserved Font
      Name.
