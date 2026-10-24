# Einrichtung im ioBroker Admin

Der Adapter bedient die offizielle Volkswagen-App auf einem Android-Handy. Die Volkswagen-Anmeldung erfolgt auf dem Handy. Für die Einrichtung werden weder das Volkswagen-Passwort noch ein Volkswagen-Zugriffstoken in ioBroker eingetragen.

Die Konfiguration verwendet die native JSON-Oberfläche von ioBroker Admin. Die Einrichtungsschaltflächen benötigen eine laufende Adapterinstanz. Dauerhafte Einstellungen zuerst speichern und die Instanz starten beziehungsweise ihren Neustart abwarten.

## 1. Android-Werkzeuge bereitstellen

Bei **Android-Werkzeuge für diese Instanz verwenden** lädt die Auswahl allein keine Software. Den verlinkten [Google-SDK-Lizenztext](https://developer.android.com/studio/terms) lesen, die vorübergehende Zustimmung setzen und **Android-Werkzeuge herunterladen und installieren** betätigen. Der Adapter kann damit die [offiziellen Android SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools) gezielt für seine Instanz bereitstellen.

Alternativ diese Auswahl ausschalten und den vollständigen Pfad einer bereits vorhandenen `adb`-Installation eintragen. Danach speichern. Das Paket enthält keine Google-Platform-Tools-Binärdateien.

## 2. Das Android-Handy koppeln

1. Auf dem Handy die Entwickleroptionen und **Drahtloses Debugging** aktivieren. Die genauen Menünamen können je nach Hersteller abweichen.
2. Die numerische IP-Adresse des Handys ohne Port in **IP-Adresse des Android-Handys** eintragen. Handy und ioBroker müssen über das Netzwerk miteinander kommunizieren können.
3. **Gerät mit Kopplungscode koppeln** öffnen. Den dort angezeigten Kopplungsport und alle sechs Ziffern des Codes in die vorübergehenden Felder übertragen. Führende Nullen gehören zum Code.
4. **Jetzt mit dem Handy koppeln** betätigen, solange der Android-Kopplungsdialog offen ist.
5. Danach auf die Hauptseite von **Drahtloses Debugging** zurückgehen. Den dort angezeigten **Verbindungsport** eintragen. Dieser unterscheidet sich vom Kopplungsport. IP-Adresse und Verbindungsport speichern.
6. **Verbindung und App-Version prüfen** betätigen. Die Probe liest die Geräteidentität und App-Version. Sie gibt die App-Version noch nicht zum Schalten frei. Das Backend hinterlegt die Gerätebindung in seinem privaten Instanzverzeichnis.

Kopplungsport und Kopplungscode werden nicht als native Instanzkonfiguration gespeichert. Der Code wird ausschließlich mit dem expliziten Kopplungsauftrag übertragen. Nach der Kopplung das Feld leeren oder die Konfiguration schließen: Die Eingabe kann bis dahin noch im Arbeitsspeicher der geöffneten Browserseite stehen.

Android kann beim Umschalten des drahtlosen Debuggings oder nach einem Neustart einen anderen Verbindungsport anzeigen. Den aktuellen Hauptseitenport übernehmen und die Verbindung erneut prüfen. Kopplung erneut durchführen, wenn Android die bestehende Kopplung nicht mehr kennt. Ein unbekanntes oder anderes Handy wird nicht automatisch als Ersatz übernommen.

## 3. App und Fahrzeug bestätigen

Das Handy entsperren, bei Volkswagen anmelden und in der App die Übersicht des gewünschten Fahrzeugs öffnen. Anschließend **App und Fahrzeug übernehmen** betätigen. Diese Einrichtung liest die App-Version und den vollständigen festen Fahrzeugtext aus und gibt beide als Vorschlag an die Konfiguration zurück.

Die vorgeschlagene **Volkswagen-App-Version** und den **vollständigen Fahrzeugtext** prüfen und speichern. Der Fahrzeugtext umfasst den festen Hinweis einschließlich der vollständigen Fahrzeugbezeichnung; ein kurzer allgemeiner Text wie „Fahrzeug“ identifiziert das gewünschte Fahrzeug nicht ausreichend. Das Backend bindet das kalibrierte Profil zusätzlich in seiner privaten Einrichtung an das geprüfte Handy.

Nach einem Update der Volkswagen-App die Ansicht erneut prüfen und die Übernahme erneut ausführen. Die reine Verbindungsprobe übernimmt keine neue App-Freigabe.

## 4. Betrieb freigeben

Zunächst eine Statusabfrage durchführen und deren Rückmeldung mit der Volkswagen-App vergleichen. Danach bei Bedarf **Klimatisierung über ioBroker starten und stoppen erlauben** aktivieren und speichern. Die Einrichtungsschaltflächen selbst führen keinen Klimatisierungsstart oder -stopp aus.

**Beim Laden wachhalten jetzt aktivieren** ändert auf ausdrücklichen Klick die entsprechende Android-Einstellung. Die zusätzliche dauerhafte Option erlaubt dem Adapter, diese Einstellung bei späteren Verbindungen anzuwenden. Eine vorhandene Bildschirmsperre muss weiterhin am Handy entsperrt werden.

Automatische Statusabfragen sind zunächst ausgeschaltet (`0`). Wenn gewünscht, ein Intervall von mindestens 300 Sekunden einstellen. Jede Statusabfrage bedient beziehungsweise öffnet die App; sie stellt keine passive Cloud-Abfrage dar. Der angezeigte Klimazustand stammt aus der App und bestätigt nicht unabhängig den Fahrzeugzustand.

Die Rückmeldung der Volkswagen-App kann nach einem Start verzögert eintreffen. Neue Instanzen warten nach einem Schaltversuch standardmäßig bis zu **120 Sekunden** auf die App-Bestätigung. In den Experteneinstellungen lässt sich die **Wartezeit auf Bestätigung in der App** zwischen 30 und 150 Sekunden wählen. Das **Zeitlimit je Auftrag** beträgt standardmäßig 180 Sekunden und umfasst Verbindung, Navigation und Bestätigung zusammen. Ein kleineres oder bereits weitgehend verbrauchtes Gesamtlimit beendet die Wartezeit früher.

Vorhandene Instanzen behalten ihr gespeichertes Gesamtlimit. Steht dort noch 125 Sekunden, für den längeren Standardablauf 180 Sekunden einstellen und speichern. Eine längere Wartezeit löst keinen weiteren Startversuch aus.

`climate.confirmationSource` zeigt, worauf sich die Rückmeldung stützt: `app_controls` steht für die Klimabedienelemente, `app_overview` für die exakt erkannte aktive Klimabeschreibung in der Fahrzeugübersicht. Nach einem unklaren Ergebnis steht dort `none`. Alle Angaben stammen aus der App; `climate.vehicleConfirmed` bleibt `false`.

Am **24. Oktober 2026** bestätigte der Nutzer einen echten Klimastart am ID.7. Die App-Rückmeldung traf dabei verzögert ein, nachdem der Adapter bereits `outcome_unknown` gemeldet hatte. Der längere Wartezeitraum und die zusätzlich erkannte Beschreibung auf der Fahrzeugkachel berücksichtigen diesen Ablauf. Der sichtbare 30-Minuten-Countdown war im ausgelesenen Android-Ansichtsbaum nicht verfügbar. Deshalb veröffentlicht der Adapter keine geschätzte Restzeit und leitet daraus keine Fahrzeugbestätigung ab.

Bei unklarer Rückmeldung zuerst die Volkswagen-App prüfen. Einen Start oder Stopp nicht durch wiederholte Betätigung zu erzwingen versuchen.

## Schnittstelle der Einrichtungsschaltflächen

Alle Aktionen gehen über die ioBroker-Messagebox an die konfigurierte Instanz. Es werden keine beliebigen Shell-Kommandos oder Skripte aus der Oberfläche übertragen.

| Befehl | Nutzdaten | Verhalten |
| --- | --- | --- |
| `installRuntime` | `{acceptLicense: true}` | Explizite Laufzeitinstallation nach Zustimmung in der geöffneten Oberfläche |
| `pair` | `{hostIp, pairPort, code}` | Einmalige Android-Kopplung; `code` bleibt eine sechsstellige Zeichenfolge |
| `probe` | `{hostIp, connectPort}` | Verbindung, Gerätebindung und installierte App-Version prüfen; keine App-Freigabe |
| `calibrate` | `{hostIp, connectPort}` | App und Fahrzeug lesend übernehmen; geprüfte Profilwerte als Konfigurationsvorschlag zurückgeben |
| `keepAwake` | `{hostIp, connectPort}` | Android-Wachhalten beim Laden ausdrücklich aktivieren |

`jsonData` interpoliert die Ports als Zeichenfolgen. Das Backend muss sie streng als ganzzahlige Ports zwischen 1 und 65535 prüfen. IP-Adressen werden ebenfalls im Backend geprüft; die Eingabehilfe im Browser ersetzt diese Prüfung nicht.

Die `sendTo`-Elemente `probe` und `calibrate` verwenden `useNative: true`. Eine sichere Antwort kann beispielsweise `{result: "calibration_success", native: {approvedAppVersion: "…", vehicleMarker: "…"}, saveConfig: true}` lauten. Vor Übernahme werden die Werte im Formular angezeigt und müssen gespeichert werden. `probe` darf in `native` ausschließlich Verbindungswerte zurückliefern; die App-Freigabe bleibt der ausdrücklichen Kalibrierung vorbehalten.

Gerätekennungen, ADB-Schlüssel und private Einrichtungsdaten gehören nicht in diese Rückgabe. Der Kopplungscode darf weder an ein Datenobjekt geschrieben noch in Logs, Fehlermeldungen oder Antwortobjekte übernommen werden. Die Oberfläche setzt weder einen Kopplungscode-State noch ein persistentes `native`-Feld dafür voraus.

Die Erfolgskennungen sind `runtime_installed`, `pair_success`, `probe_success`, `calibration_success` und `keep_awake_applied`. Rückmeldungen des Backends sollen feste, verständliche Meldungen enthalten und keine rohen Prozessausgaben.

## Warum die Kopplungseingaben nicht gespeichert werden

Die Felder heißen `_pairPort` und `_pairCode` und setzen zusätzlich `doNotSave: true`. Auch die nur im Browser gesetzte Lizenzzustimmung `_acceptRuntimeLicense` ist vorübergehend. Laut der [offiziellen JSON-Config-Dokumentation](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md) werden mit `_` beginnende Attribute nicht in das Instanzobjekt gespeichert; `doNotSave` kennzeichnet zusätzlich ein ausschließlich intern verwendetes Attribut. Ein Feld vom Typ `password` maskiert lediglich die Anzeige und verhindert für sich genommen keine Speicherung.

Die verwendeten Typen und Eigenschaften sind im [offiziellen JSON-Config-Schema](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/schemas/jsonConfig.json) beschrieben. Für die native Oberfläche benötigt `common.adminUI.config` den Wert `json`, für die Aktionen `common.messagebox` den Wert `true`.
