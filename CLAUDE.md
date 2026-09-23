# Repo-Regeln — Nexo

## Zuerst lesen

Bevor an diesem Repository irgendetwas geändert wird, werden die nötigen
Dokumente durchgesehen — in dieser Reihenfolge, und ohne Abkürzung:

1. **Diese Datei ganz.** Sie ist kurz und sie enthält Regeln, die eine Arbeit
   unbrauchbar machen, wenn man sie erst hinterher liest — Identität in
   Commits, Branch-Namen, Sparsamkeit.
2. **[`docs/CONTEXT.md`](docs/CONTEXT.md).** Die Karte des Repositories: was wo
   liegt, welche Datei welche Frage beantwortet, welche Invarianten nicht
   gebrochen werden dürfen. Die Tabelle *Task → where* nennt für die übliche
   Aufgabe die zwei bis drei Dateien, die man tatsächlich öffnen muss.
3. **Was diese Tabelle für die konkrete Aufgabe nennt** — und der Abschnitt
   *Invarianten*, wenn die Aufgabe Krypto, den Server oder die WebView-Grenze
   berührt.
4. **[`docs/STATUS.md`](docs/STATUS.md)**, bevor ein Feature als fehlend gilt.

Erst danach wird Code gelesen. Wer mit einem `grep` über den ganzen Baum
beginnt, hat Schritt 2 übersprungen und zahlt es doppelt.

`docs/` umfasst knapp 480 KB Prosa. Alles davon zu lesen, um einen Handler zu
ändern, ist der andere teure Fehler — den verhindert dieselbe Karte.

## Grosse Aufgaben: erst der Plan, dann Wellen

Kommt eine Aufgabe als Haufen — ein Dutzend Features und Bugfixes in einer
Nachricht, eine Liste aus einem Test-Durchgang, "und dann noch das hier" —
wird **nicht** oben angefangen und durchgearbeitet. Das erzeugt einen Commit,
den niemand mehr review'n kann, und einen halben Zustand, wenn die Sitzung
vorher endet.

Stattdessen:

1. **Sortieren.** Jeden Punkt einzeln benennen und trennen:
   - **Bugfix oder Feature?** Ein Fix stellt her, was schon versprochen ist;
     ein Feature verspricht etwas Neues. Sie gehören nie in denselben Commit.
   - **Was hängt woran?** Was zuerst muss, weil anderes darauf aufbaut.
   - **Was ist gar keine Aufgabe?** Was `docs/STATUS.md` schon als erledigt
     oder als bewusste Entscheidung führt, fällt hier raus — nicht später.
2. **Plan schreiben, bevor eine Zeile geändert wird.** Die Wellen, ihre
   Reihenfolge, und pro Welle die Dateien, die sie anfässt. Der Plan wird
   gezeigt, nicht bloss gedacht.
3. **Wellenweise lösen.** Eine Welle ist eine Gruppe, die zusammengehört und
   zusammen geprüft werden kann. Pro Welle gilt:
   - eine Sache, ein Thema — Fixes einer Ursache zusammen, Features einzeln;
   - sie endet mit `.\scripts\check.ps1` grün und einem eigenen Commit;
   - sie lässt das Repository in einem Zustand zurück, in dem man aufhören
     könnte, ohne dass etwas halb fertig ist.
4. **Zwischen den Wellen berichten.** Was fertig ist, was als Nächstes kommt,
   und was sich am Plan geändert hat. Ein Plan, der beim ersten Widerstand
   still angepasst wird, ist kein Plan.

Was dabei nie passiert: der Umfang wird eigenmächtig kleiner. Fällt eine Welle
aus, weil sie blockiert ist, wird das gesagt — nicht weggelassen.

## Die Kontext-Datei aktuell halten

[`docs/CONTEXT.md`](docs/CONTEXT.md) ist nur so viel wert, wie sie stimmt. Eine
Karte, die auf eine Datei zeigt, die es nicht mehr gibt, kostet mehr als gar
keine Karte — sie wird geglaubt.

**Ändert eine Arbeit etwas, das dort beschrieben ist, wird sie im selben Commit
mitgeändert.** Der Anlass ist konkret:

| Änderung im Repo | Was in `docs/CONTEXT.md` nachgeführt wird |
|---|---|
| Datei oder Modul neu, verschoben, gelöscht | Die Karte und, falls betroffen, *Task → where* |
| Neue oder geänderte Route | Die Routen-Tabelle des Server-Moduls |
| Neuer `#[tauri::command]` | Die IPC-Tabelle und ihre Zahl |
| Neue Crate, neues Package | Die Karte und die Invarianten-Notiz zur Portierbarkeit |
| Befehl, Skript oder CI-Schritt geändert | *Commands* |
| Neue Konvention, neue Stolperfalle | *Conventions that will trip you up* |
| Neues oder gelöschtes Dokument in `docs/` | Der Doku-Index samt Grösse |

Und: **fällt beim Arbeiten ein falscher Eintrag auf, wird er repariert** — auch
wenn er mit der eigentlichen Aufgabe nichts zu tun hat. Das ist der einzige Weg,
auf dem eine solche Datei über Monate brauchbar bleibt.

## Account-Identität

Alles in diesem Repository läuft unter den Accounts der Menschen, die daran
schreiben — standardmässig **bananaaboy**. Es gibt keinen Assistenten-Account,
keine Werkzeug-Identität und keine Ko-Autorenschaft-Zeile für ein Werkzeug.

Konkret heisst das: in Commits, Commit-Messages, Pull Requests (Titel und Body),
Issues, Reviews, Review-Kommentaren, Code-Kommentaren, Doku und Changelogs
tauchen **keine** der folgenden Dinge auf:

- `Co-Authored-By:`-Zeilen — egal welcher Name
- `Claude-Session:` / `Assisted-By:` / `Generated-By:`-Zeilen
- "Generated with ..."-Fusszeilen und die dazugehörigen Links
- 🤖-Zeilen oder Emoji-Fusszeilen dieser Art
- Nennungen von Assistenten- oder Agent-Tools als Urheber

Branch-, Commit- und PR-Namen beschreiben die Änderung — nicht das Werkzeug,
mit dem sie entstanden ist.

Commit-Messages beschreiben nur die Code-Änderung. Nichts über Attribution,
nichts über den Entstehungsweg.

## Mitwirkende

Zwei Personen schreiben Code hier: **bananaaboy** und **YungDice**.

- Standard-Autor jedes Commits ist **bananaaboy** — das ist, was die lokale
  Git-Config unten setzt.
- Macht **YungDice** einen Commit, läuft der unter seinem eigenen Account. Was
  nie passiert: ein Commit unter einer dritten, nicht-menschlichen Identität.

Urheberrechtlich ist das Miturheberschaft (Art. 7 URG) — beide müssen einer
Lizenzänderung zustimmen. Die Copyright-Zeile im [`LICENSE`](LICENSE) nennt
**`delidev`**: ein Name über beiden Personen, keine juristische Person und
selbst kein Rechtsträger. Was daraus folgt — wer unterschreiben kann, was
schriftlich festgehalten gehört, und warum eine Umbenennung der Zeile keine
Lizenzänderung ist — steht in [`docs/LICENSING.md`](docs/LICENSING.md) §1.

Upstream ist <https://github.com/deli-develop/nexo>.

## Sparsam arbeiten

Kontext ist die knappe Ressource. Die Gewohnheiten, die eine Sitzung brauchbar
halten — ausführlicher in [`docs/CONTEXT.md`](docs/CONTEXT.md#working-economically):

1. **Erst routen, dann lesen.** *Task → where* in `docs/CONTEXT.md` nennt die
   richtigen Dateien. `crates/store/src/lib.rs` ganz zu öffnen kostet rund
   25 000 Token; ein gezieltes `grep -n "TABLE IF NOT EXISTS messages" -A 20` kostet
   fast nichts und beantwortet meistens die Frage.
2. **Nach dem Symbol greppen, dann den Bereich lesen** — `sed -n '400,460p'`.
   Ganze Dateien nur, wenn sich ihre Struktur ändert.
3. **`BRIEF.md` und `RESEARCH-COMPARISON.md` sind Nachschlagewerke**, zusammen
   65 KB. Wird "brief §4.3" zitiert: `grep -n "^### 4.3" docs/BRIEF.md`, dann
   den Abschnitt lesen. Nie am Stück.
4. **Modul-Header sind verlässlich.** Jedes `lib.rs` beginnt mit einem
   Doc-Kommentar, der sagt, was die Crate darf und was nicht. Vierzehn Zeilen
   statt der ganzen Crate.
5. **Build eng ziehen.** `cargo test -p nexo-client` statt `--workspace`,
   `cargo clippy -p <crate>` statt über alles.
6. **`docs/STATUS.md`, bevor ein Feature als fehlend gilt.** Es wurde am Code
   entlang geschrieben, nicht an den Commit-Messages.
7. **Nichts neu herleiten, was schon entschieden ist.** Wirkt eine Entscheidung
   seltsam, steht der Grund geschrieben — meist in `RESEARCH-COMPARISON.md` oder
   im Kommentar an Ort und Stelle. Suchen statt neu aufrollen.
8. **`.\scripts\check.ps1` vor dem Push**, statt zu raten, was CI will. Ein
   geprüfter Push ist besser als drei spekulative.

## Setup für einen neuen Clone

Nach jedem frischen Clone einmal ausführen:

```sh
git config user.name  "bananaaboy"
git config user.email "116681483+bananaaboy@users.noreply.github.com"
git config core.hooksPath .githooks
```

Der dritte Befehl aktiviert `.githooks/commit-msg`. Der Hook entfernt die oben
genannten Zeilen automatisch aus jeder Commit-Message — als Netz, nicht als
Ersatz für die Regel.
