# Weinkeller

Eine Web-App (PWA) zur Verwaltung deines Weinkellers, ähnlich wie Vivino. Sie läuft auf iPhone, iPad und Mac, lässt sich auf den Home-Bildschirm legen und funktioniert auch offline.

## Funktionen

- **Keller**: Weine mit Foto, Weingut, Jahrgang, Typ, Herkunft, Rebsorte, Preis und Bestand. Mit Suche, Filtern (Typ, „Trinkreif“) und Sortierung.
- **Etikett fotografieren**: Foto direkt mit der Kamera aufnehmen. Mit einem Claude API-Key füllt „✨ Etikett erkennen“ die Felder automatisch aus, inklusive geschätztem Trinkfenster und Speiseempfehlung.
- **Bewertungen & Notizen**: eigene Sterne-Bewertung und Verkostungsnotizen. „Flasche öffnen“ zieht eine Flasche vom Bestand ab und speichert Datum, Anlass und Eindruck.
- **Trinkreife**: Trinkfenster pro Wein mit den Status „Lagern“, „Trinkreif“, „Bald trinken“ und „Überfällig“.
- **Statistik**: Flaschenzahl, Kellerwert, Ø Bewertung, getrunkene Flaschen, eine „Jetzt trinken“-Liste sowie Verteilung nach Typ, Land, Rebsorte und Jahrgang.
- **Regale**: frei definierbare Regale (Reihen × Spalten). Flaschen werden per Antippen Fächern zugeordnet. Beim Öffnen einer Flasche wird ihr Fach automatisch frei.
- **Einkaufsliste**: Weine merken, „Nachkaufen“ direkt aus einem Wein heraus. Nach dem Kauf erhöht „In Keller“ den Bestand oder legt den Wein neu an.
- **Sicherung**: Export und Import als JSON-Datei (Einstellungen → Daten).

## Daten & Cloud

Die App kennt zwei Betriebsarten:

- **Mit Cloud (empfohlen)**: Wenn in `config.js` Supabase-Zugangsdaten eingetragen sind, meldest du dich mit E-Mail und Passwort an. Deine Daten werden in deinem Konto gespeichert und automatisch zwischen allen Geräten synchronisiert.
- **Nur lokal**: Ist `config.js` leer, gibt es keine Anmeldung, und alle Daten bleiben im Browser des jeweiligen Geräts. Übertragen lassen sie sich dann nur über Export und Import der Sicherung.

So funktioniert die Synchronisation:

- Die App arbeitet immer zuerst lokal und ist deshalb schnell und auch offline nutzbar. Änderungen werden im Hintergrund hochgeladen, sobald eine Verbindung besteht.
- Änderungen anderer Geräte holt die App beim Start, beim Zurückkehren in die App und jede Minute ab. In den Einstellungen gibt es zusätzlich „Jetzt synchronisieren“.
- Bearbeiten zwei Geräte denselben Wein, gewinnt die jüngere Änderung.
- Fotos liegen in einem privaten Cloud-Speicher und werden auf anderen Geräten bei Bedarf nachgeladen.
- Beim **Abmelden** werden die Daten vom Gerät entfernt; sie bleiben im Konto. Bei der **ersten Anmeldung** auf einem Gerät werden bereits lokal vorhandene Weine ins Konto übernommen.
- Jeder Benutzer sieht nur seine eigenen Daten. Das erzwingt die Datenbank selbst über Row Level Security.
- Der Claude API-Key bleibt auf dem jeweiligen Gerät und wird weder synchronisiert noch exportiert.

## Cloud einrichten (Supabase, einmalig, ca. 10 Minuten)

1. Erstelle unter <https://supabase.com> ein kostenloses Konto und ein neues Projekt. Wähle als Region z.B. *Central EU (Frankfurt)* und notiere dir das Datenbank-Passwort.
2. Öffne im Projekt den **SQL Editor**, füge den Inhalt von [`supabase/schema.sql`](supabase/schema.sql) ein und klicke auf **Run**. Damit werden die Tabelle, die Zugriffsregeln und der Foto-Speicher angelegt.
3. Kopiere unter **Project Settings → API** die **Project URL** und den **anon / publishable key** in `config.js`. Diesen Schlüssel darf der Browser kennen, die Daten schützen die Zugriffsregeln.
4. Trage unter **Authentication → URL Configuration** die Adresse ein, unter der die App läuft (z.B. `https://mein-weinkeller.netlify.app`). Setze sie als **Site URL** und füge sie zusätzlich bei **Redirect URLs** hinzu. Sonst führen die Links in Bestätigungs- und Passwort-Mails ins Leere.
5. Lade die App neu hoch (siehe unten) und erstelle in der App dein Konto.

Hinweise zur Gratis-Stufe von Supabase:

- Der eingebaute E-Mail-Versand ist auf wenige Mails pro Stunde begrenzt. Für ein privates Projekt genügt das. Alternativ kannst du unter **Authentication → Providers → Email** die E-Mail-Bestätigung abschalten.
- Gratis-Projekte werden nach etwa einer Woche ohne Nutzung pausiert. Die Daten bleiben erhalten, und du kannst das Projekt im Dashboard mit einem Klick wieder starten.
- Eine zusätzliche Sicherung als Datei (Einstellungen → Daten → Exportieren) schadet trotzdem nicht.

## Auf dem iPhone nutzen

Damit Kamera, Offline-Modus, Anmeldung und „Zum Home-Bildschirm“ funktionieren, muss die App über **HTTPS** erreichbar sein. Am einfachsten geht das so:

1. **Netlify Drop**: Öffne <https://app.netlify.com/drop> und ziehe diesen Ordner hinein. Du bekommst eine HTTPS-Adresse. Mit einem kostenlosen Netlify-Konto bleibt die Adresse dauerhaft bestehen, und du kannst Updates erneut hineinziehen.
   Alternativ eignen sich **GitHub Pages** oder **Cloudflare Pages**.
2. Öffne die Adresse auf dem iPhone in **Safari** → Teilen → **Zum Home-Bildschirm**.
3. Starte die App künftig über das Icon. Sie läuft dann im Vollbild und auch offline.

## Lokal auf dem Mac testen

```bash
cd /tmp && python3 -m http.server 8765 --directory ~/Weinkeller-Kopie
```

Hinweis: macOS lässt Terminal-Prozesse oft nicht direkt aus iCloud Drive lesen. Kopiere den Ordner deshalb vorher an einen lokalen Ort (z.B. `~/Weinkeller-Kopie`) und öffne dann <http://localhost:8765>.

## Etikett-Erkennung einrichten

1. Erstelle unter <https://console.anthropic.com/> einen API-Key. Die Nutzung wird pro Anfrage abgerechnet; eine Etikett-Erkennung kostet etwa 1–3 Rappen.
2. Trage ihn in der App unter **Einstellungen → Etikett-Erkennung** ein.
3. Sobald ein API-Key hinterlegt ist, startet die Erkennung beim Fotografieren eines neuen Weins automatisch. Bei bestehenden Weinen tippst du auf „✨ Etikett erkennen“.

Verwendet wird das Modell `claude-opus-5-5` über das offizielle Anthropic JS-SDK, das bei Bedarf von jsDelivr geladen wird.

## Dateien

| Datei | Inhalt |
|---|---|
| `index.html` | App-Hülle, Navigation |
| `app.js` | Ansichten, Logik, Aktionen |
| `db.js` | Lokale Speicherung (IndexedDB), Export/Import |
| `sync.js` | Anmeldung und Cloud-Synchronisation (Supabase) |
| `config.js` | Supabase-Zugangsdaten (leer = nur lokal) |
| `supabase/schema.sql` | Datenbank-Schema und Zugriffsregeln für Supabase |
| `label.js` | Etikett-Erkennung via Claude API |
| `styles.css` | Gestaltung (heller und dunkler Modus) |
| `sw.js`, `manifest.webmanifest`, `icons/` | PWA: Offline-Cache, Installation, Icons |
