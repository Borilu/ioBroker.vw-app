# Einrichtung im ioBroker Admin

Für den Einstieg gibt es eine [einfache Anleitung mit Screenshots für Installation und Handy-Kopplung](INSTALLATION.de.md), auch [als PDF zum Herunterladen](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.9.2/VW-App-Installation-und-Kopplung.pdf). Die folgenden Abschnitte dienen als ausführliche Referenz.

Die separate [Bedienungsanleitung](BEDIENUNG.de.md) führt alle Datenpunktpfade, ihren Inhalt und die erforderlichen Bedienfolgen auf. Sie ist ebenfalls [als PDF für 0.10.0 verfügbar](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.10.0/VW-App-Bedienungsanleitung.pdf). Dieses ältere PDF enthält die Lademodi noch nicht; dafür die aktualisierte Online-Anleitung für 0.11.1 verwenden.

Der Adapter bedient die offizielle Volkswagen-App auf einem Android-Handy. Die Volkswagen-Anmeldung erfolgt auf dem Handy. Für die Einrichtung werden weder das Volkswagen-Passwort noch ein Volkswagen-Zugriffstoken in ioBroker eingetragen.

Die Konfiguration verwendet die native JSON-Oberfläche von ioBroker Admin. Die Einrichtungsschaltflächen benötigen eine laufende Adapterinstanz. Dauerhafte Einstellungen zuerst speichern und die Instanz starten beziehungsweise ihren Neustart abwarten.

## Installation und Aktualisierung

Ab Version 0.9.1 benötigt der Adapter einen **Linux-x64-Host**, **Node.js ab 22.19.0**, **js-controller ab 6.0.11** und **Admin ab 7.6.20**. Das Handy muss Android 11 oder neuer mit verfügbarem drahtlosen Debugging verwenden. Die bisher geprüfte Kombination ist ein Galaxy A31 mit Android 12, deutscher Volkswagen-App 4.8.1 und einem ID.7 GTX Tourer. Andere Kombinationen sind damit nicht automatisch bestätigt. Informationen zur Smartphone-App stellt [Volkswagen](https://www.volkswagen.de/de/besitzer-und-service/digitale-extras/volkswagen-apps-login-und-shop.html) bereit.

Der npm-Paketname lautet **`iobroker.vw-app`**. npm-Veröffentlichung und Aufnahme in das ioBroker-Adapterverzeichnis sind getrennte Schritte. Der Adapter ist derzeit noch nicht in das Verzeichnis **beta/latest** oder **stable** aufgenommen. Eine veröffentlichte npm-Version allein macht ihn dort noch nicht sichtbar.

Sobald die gewünschte Version auf [npm](https://www.npmjs.com/package/iobroker.vw-app) verfügbar ist:

1. Im Admin **Adapter** öffnen und bei Bedarf den Expertenmodus aktivieren.
2. Über das Octocat-Symbol **Aus eigener Quelle installieren** öffnen und den Reiter **Von npm** auswählen.
3. `iobroker.vw-app` eingeben, die veröffentlichte Version auswählen und installieren lassen.
4. Falls der Dialog keine Instanz angelegt hat, eine Instanz von `vw-app` hinzufügen und deren Einstellungen öffnen.

Die Installation führt der ioBroker-eigene Installer aus. Die Voraussetzungen oben vorher prüfen: Bei einer Installation aus eigener Quelle werden die Abhängigkeiten des Adapterverzeichnisses nicht geprüft. Die genauen Beschriftungen können je nach Admin-Version abweichen; siehe [offizielle Admin-Anleitung](https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/admin/adapter.md#install-from-your-own-source).

Bis zur Aufnahme in das Adapterverzeichnis lassen sich spätere veröffentlichte Versionen im selben Reiter **Von npm** auswählen und installieren. Nach der Aufnahme steht der Adapter für Nutzer des betreffenden Verzeichnisses über die normale Adapterliste zur Installation und Aktualisierung bereit. Eine spätere Aufnahme in **stable** benötigt eine eigene Prüfung und Rückmeldungen aus der Testphase.

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

Zunächst die Klima- und Ladezustände abfragen und deren Rückmeldungen mit der Volkswagen-App vergleichen. Danach bei Bedarf **Klimastart, Stopp und Änderungen der Fahrzeugeinstellungen erlauben** aktivieren und speichern. Diese Freigabe gilt auch für Änderungen der Ladeeinstellungen. Ohne Freigabe sind lesende Abfragen und das Speichern von Wünschen möglich; tatsächliche Änderungen in der App bleiben gesperrt. Die Einrichtungsschaltflächen selbst führen keinen Klimatisierungsstart oder -stopp aus.

**Beim Laden wachhalten jetzt aktivieren** ändert auf ausdrücklichen Klick die entsprechende Android-Einstellung. Die zusätzliche dauerhafte Option erlaubt dem Adapter, diese Einstellung bei späteren Verbindungen anzuwenden. Eine vorhandene Bildschirmsperre muss weiterhin am Handy entsperrt werden.

Neue Instanzen verwenden für **Automatische App-Abfragen: Mindestabstand je Bereich** den Wert **15 Sekunden**. Vorhandene Instanzen behalten ihren gespeicherten Wert; `0` bleibt ausgeschaltet. Fehlt der Wert in einer älteren Konfiguration, bleibt die Automatik ebenfalls aus. Zulässig sind `0` oder ganze Zahlen von 15 bis 86400. Die Automatik liest Klima, Batterie/Ladeeinstellungen, Fahrzeugzustandsbericht, Türen/Fenster/Kofferraum/Verriegelung, die FIN, Klima-Abfahrtszeiten, Ladeortliste und jeden vorhandenen Ladeort nacheinander. Der Wert bezeichnet den Mindestabstand nach Abschluss bis zur erneuten Fälligkeit desselben Bereichs, keinen vollständigen Rundlauf alle 15 Sekunden. Zusätzliche Ladeorte und ihre Untermenüs sowie die FIN-Abfrage verlängern zusammen mit App-Navigation und Erholungspausen den tatsächlichen Rundlauf.

Bedienbefehle haben Vorrang vor automatischen Leseabfragen. Die automatische Abfrage hält dafür an einer sicheren Schrittgrenze an. Sie synchronisiert nicht, übernimmt keine vorgemerkten Wünsche und wiederholt keine Fahrzeugaktion. Manuell bleiben `commands.refresh`, `commands.refreshCharging` und `commands.refreshVehicleReport` getrennt verfügbar. Jede Abfrage bedient beziehungsweise öffnet die App; die angezeigten Werte bestätigen nicht unabhängig den Fahrzeugzustand. Die zusätzlichen Aktualitätsdaten und die Einstellung **App-Auslesung als veraltet markieren nach** sind in Abschnitt 9 erklärt.

Die Rückmeldung der Volkswagen-App kann nach einem Start verzögert eintreffen. Neue Instanzen warten nach einem Schaltversuch standardmäßig bis zu **120 Sekunden** auf die App-Bestätigung. In den Experteneinstellungen lässt sich die **Wartezeit auf Bestätigung in der App** zwischen 30 und 150 Sekunden wählen. Das **Zeitlimit je Auftrag** beträgt standardmäßig 300 Sekunden und umfasst Verbindung, Navigation, Temperaturwahl und Bestätigung zusammen. Ein kleineres oder bereits weitgehend verbrauchtes Gesamtlimit beendet die Wartezeit früher.

Vorhandene Instanzen behalten ihr gespeichertes Gesamtlimit. Steht dort noch 125 oder 180 Sekunden, für Temperaturwahl und Start zusammen 300 Sekunden einstellen und speichern. Größere Temperatursprünge werden über frisch ausgelesene Einzelschritte bedient und benötigen zusätzliche Zeit. Eine längere Wartezeit löst keinen weiteren Startversuch aus.

`climate.confirmationSource` zeigt, worauf sich die Rückmeldung stützt: `app_controls` steht für die Klimabedienelemente, `app_overview` für die exakt erkannte aktive Klimabeschreibung in der Fahrzeugübersicht. Nach einem unklaren Ergebnis bleibt die letzte bekannte Quelle mit ungültiger Qualität erhalten; `refresh.climate.status` zeigt den Fehler. Der erhaltene Wert bestätigt keinen aktuellen Ausgang. Alle Angaben stammen aus der App; `climate.vehicleConfirmed` bleibt `false`.

Am **24. Oktober 2026** bestätigte der Nutzer einen echten Klimastart am ID.7. Die App-Rückmeldung traf dabei verzögert ein, nachdem der Adapter bereits `outcome_unknown` gemeldet hatte. Der längere Wartezeitraum und die zusätzlich erkannte Beschreibung auf der Fahrzeugkachel berücksichtigen diesen Ablauf. Der sichtbare 30-Minuten-Countdown war im ausgelesenen Android-Ansichtsbaum nicht verfügbar. Deshalb veröffentlicht der Adapter keine geschätzte Restzeit und leitet daraus keine Fahrzeugbestätigung ab.

Bei unklarer Rückmeldung zuerst die Volkswagen-App prüfen. Einen Start oder Stopp nicht durch wiederholte Betätigung zu erzwingen versuchen.

## 5. Zieltemperatur auswählen

Im Datenpunkt `vw-app.0.climate.targetTemperature` einen unterstützten numerischen °C-Wert wählen, zum Beispiel `22.5`, und mit `ack=false` schreiben. Der geprüfte Zahlenbereich beträgt **16,0 bis 29,5 °C in 0,5-°C-Schritten**. Die daneben liegenden Sonderwerte `LO` und `HI` werden nicht unterstützt. Zeichenfolgen wie `"22.5"` werden nicht als Zahlen übernommen.

Der Adapter speichert den Sollwert privat und bestätigt ihn mit `ack=true`. Das bedeutet ausschließlich **gespeichert**: Diese Auswahl allein bedient das Handy noch nicht. Ein ungültiger Wert wird durch den letzten akzeptierten Sollwert ersetzt; der feste Fehlercode `invalid_temperature` erscheint dazu in `climate.targetTemperatureError`. Eine gültige Auswahl löscht diesen Auswahlfehler. Rückmeldung und Fehler eines gleichzeitig laufenden Handyauftrags werden dadurch nicht überschrieben.

Nach einer ungültigen oder nicht gespeicherten Temperaturauswahl bleiben neue Aufträge, die diese Temperatur übernehmen sollen, mit `temperature_selection_failed` gesperrt. Obwohl der frühere Sollwert wieder angezeigt wird, muss zuerst ausdrücklich ein gültiger Wert neu gewählt oder **App-Temperatur beibehalten** betätigt werden. `commands.applySettings` übernimmt keine Temperatur. Status und Stopp bleiben verfügbar. Ein bereits angenommener Auftrag behält seinen ursprünglichen Sollwert auch dann, wenn eine spätere Auswahl fehlschlägt.

`commands.setTemperature` mit `true` und `ack=false` stellt den gespeicherten Sollwert im Modus Klimatisierung ein, ohne Start oder Stopp zu drücken. `commands.start` übernimmt ihn vor einem Start der Klimatisierung. Die Temperaturwahl gilt nur für `climate`; bei einem ausdrücklich gewählten Start mit `windowHeating` wird die vorgemerkte Temperatur ignoriert und für eine spätere Klimatisierung behalten. Für tatsächliche Temperaturänderungen muss die Schaltfreigabe aktiviert sein. Der getrennte Datenpunkt `climate.temperature` zeigt den zuletzt aus der App ausgelesenen Wert; wenn dieser nicht lesbar ist, enthält er `null` mit ungültiger Qualität.

Der Sollwert bleibt über Adapterneustarts erhalten. Der Knopf `commands.clearTemperature` (**App-Temperatur beibehalten**) wählt, bei späteren Starts die vorhandene App-Temperatur zu verwenden. Alternativ lässt sich ein echter Nullwert (`null`, nicht der Text `"null"`) an den Sollwert schreiben. Beides ändert nur die gespeicherte Auswahl und bedient das Handy nicht. `commands.setTemperature` ohne ausgewählten Sollwert wird vor einem Handyzugriff abgewiesen.

Eine Auswahl während eines laufenden Auftrags gilt für den nächsten Auftrag. Der bereits gestartete Vorgang behält seinen ursprünglichen Sollwert. Bei unklarer Rückmeldung den tatsächlichen App-Wert prüfen; eine gespeicherte Auswahl bestätigt keine Temperaturmessung am Fahrzeug.

## 6. Modus und weitere Klimaeinstellungen vormerken

Die folgenden Datenpunkte unter `vw-app.0` speichern zusätzliche Wünsche. Werte mit `ack=false` schreiben; die Bestätigung `ack=true` bedeutet zunächst nur **gespeichert**, nicht bereits in der App eingestellt. Alle vier Wünsche bleiben über einen Adapterneustart erhalten. `null` behält die betreffende App-Einstellung bei, während `false` einen Schalter ausdrücklich ausschalten soll.

| Vorgemerkter Wunsch | Erlaubte Werte | Getrennte App-Rückmeldung |
| --- | --- | --- |
| `climate.targetMode` | `null`, `climate`, `windowHeating` | `climate.mode` |
| `climate.targetClimateOnUnlock` | `null`, `true`, `false` | `climate.climateOnUnlock` |
| `climate.targetAutoWindowHeating` | `null`, `true`, `false` | `climate.autoWindowHeating` |
| `climate.targetZones` | `null`, `frontLeft`, `frontRight`, `both` | `climate.zones` |

`climate` bedeutet Klimatisierung, `windowHeating` Scheibenheizung. **`commands.applySettings`** mit `true` und `ack=false` übernimmt ausschließlich diese vier vorgemerkten Wünsche in die App. Für Änderungen an den App-Einstellungen muss die Schaltfreigabe aktiviert sein. Dabei wird weder eine vorgemerkte Temperatur übernommen noch Start oder Stopp gedrückt. Die tatsächlichen App-Werte erscheinen getrennt in den Rückmeldedatenpunkten.

Bietet die Volkswagen-App nach Änderungen **Speichern** an, betätigt der Adapter diese Schaltfläche einmal und liest die Werte nach erneutem Öffnen der Einstellungen zurück. Erst diese Prüfung bestätigt die Übernahme. Bereits vorher offene, manuell bearbeitete Entwürfe werden weder gespeichert noch verworfen. Bei `unsaved_settings` die Änderungen zuerst direkt am Handy ausdrücklich speichern oder verwerfen, den Zoneneditor verlassen und anschließend erneut versuchen. Die Android-Zurück-Funktion ersetzt das Speichern nicht; sie kann einen App-Entwurf verwerfen.

Bei einer ungültigen oder nicht gespeicherten Auswahl stellt der Adapter den zuletzt akzeptierten Wert wieder her. `climate.targetSettingsError` nennt das betroffene Feld. Neue Start- und Einstellungsübernahme-Aufträge werden dann mit `settings_selection_failed` abgewiesen, bis genau dieses Feld erneut gültig gewählt oder **`commands.clearSettings`** betätigt wurde. Eine erfolgreiche Auswahl an einem anderen Feld löscht den Fehler nicht. Ein gleichzeitig laufender Handyauftrag behält seine eigene Rückmeldung; Status und Stopp bleiben verfügbar.

**`commands.clearSettings`** setzt nur diese vier Wünsche auf `null`, ohne das Handy zu bedienen. Der Temperaturwunsch in `climate.targetTemperature` bleibt dabei erhalten. Für dessen Rücknahme weiterhin `commands.clearTemperature` verwenden.

Start übernimmt einen festen Schnappschuss der vorgemerkten Wünsche. Eine spätere Auswahl gilt für den nächsten Auftrag. Wenn `climate.targetMode=null` ist, behält Start das bisherige Verhalten bei: Es wird kein anderer Modus gewählt, und ein geprüfter Klimatisierungsmodus ist weiterhin erforderlich. Ein ausdrücklich gewünschter Moduswechsel ist nur bei ausgeschalteter Klimatisierung möglich. Bei laufendem Betrieb wird der Wechsel abgewiesen; der Adapter stoppt oder startet die Klimatisierung dafür nicht automatisch neu.

Die Schalter für Klimatisierung beim Entriegeln und automatische Scheibenheizung sowie die Zonenauswahl sind auch in den Einstellungen des Scheibenheizungsmodus sichtbar. Zur Bedeutung der Zonen verwendet die App folgenden Text: „Zonen im Innenraum Ihres Fahrzeugs, in denen zusätzliche temperaturbeeinflussende Funktionen während der Klimatisierung aktiviert werden sollen.“ `frontLeft` wählt vorne links, `frontRight` vorne rechts und `both` beide vorderen Zonen für diese Zusatzfunktionen. Damit werden keine unterschiedlichen Solltemperaturen oder eine getrennte Luftverteilung eingestellt.

Der nur lesbare Rückmeldepunkt `climate.zones` kann außerdem `none` melden: In der App ist dann keine der beiden vorderen Zonen ausgewählt. Als Wunschwert für `climate.targetZones` ist `none` nicht erlaubt. Davon zu unterscheiden ist `null` mit ungültiger Qualität: Dieser Wert bedeutet, dass die Einstellung nicht eindeutig ausgelesen werden konnte.

Die Referenz-App kann beim erneuten Öffnen der Fahrzeugübersicht oder Einstellungen wieder Klimatisierung anzeigen. Der gespeicherte Moduswunsch des Adapters bleibt erhalten. Der Adapter speichert und prüft zuerst die übrigen Einstellungen und wählt danach den gewünschten Modus für den Auftrag. `climate.mode` beschreibt die aktuelle App-Ansicht und keine unabhängige Fahrzeugmessung.

Version 0.3.0 bestand 220 automatisierte Tests auf Linux. Auf dem Galaxy A31 wurden beide Modi, beide Stellungen der Automatikschalter, alle drei Zonenauswahlen sowie Speichern, erneutes Auslesen und ein gemeinsamer Auftrag mit allen vier Wünschen geprüft. Die Wünsche blieben nach einem Adapterneustart erhalten und konnten anschließend gelöscht werden. Die ursprünglichen App-Werte wurden wiederhergestellt; die Klimatisierung blieb aus. Die Verbindung zum Startablauf ist durch Regressionstests abgedeckt; ein zusätzlicher physischer Klimastart wurde für diese Einstellungsprüfung nicht ausgelöst.

## 7. Batterie und Ladeeinstellungen

`commands.refreshCharging` mit `true` und `ack=false` liest die in der App angezeigten beziehungsweise zwischengespeicherten Batterie- und Ladeinformationen, ohne Ladeeinstellungen zu ändern oder ausdrücklich eine Fahrzeugsynchronisation anzufordern. `battery.soc` enthält den Ladezustand in Prozent, `battery.rangeKm` die Restreichweite in Kilometern. Der Prozentwert wird aus den Reichweitendetails gelesen. Als Rückfall kann die Fahrzeugübersicht nur eine eindeutig mit km bezeichnete Reichweite liefern; aus ihr wird kein Ladezustand geschätzt. Ein nicht lesbarer Wert ist `null` mit ungültiger Qualität.

`battery.observedAt` nennt den Zeitpunkt, zu dem der Adapter diese Werte aus der App gelesen hat. Das ist **kein Fahrzeugtelemetrie-Zeitstempel** und sagt nicht, wann das Fahrzeug die Werte gemessen oder übertragen hat. Die App kann ältere Werte anzeigen. Die Zeit der letzten Klimaabfrage steht weiterhin getrennt in `operation.lastUpdated`.

**`commands.synchronize`** mit `true` und `ack=false` fordert ausdrücklich eine Synchronisation über die Volkswagen-App an. Der Adapter betätigt den eindeutig erkannten Link **Jetzt synchronisieren** einmal. Der anschließend deaktivierte Link bestätigt nur die angenommene Anfrage. Anschließend liest der Adapter Batterie und Ladeeinstellungen erneut aus der App; die Werte können weiterhin aus deren Zwischenspeicher stammen.

Die App weist darauf hin, dass die Synchronisation einige Minuten dauern kann. Der Auftrag wartet nicht automatisch auf nachweislich neue Fahrzeugwerte und meldet keine abgeschlossene Fahrzeugsynchronisation. Bei Bedarf später erneut `commands.refreshCharging` auslösen und den App-Stand prüfen. Normale Abfragen und automatisches Polling betätigen **Jetzt synchronisieren** nicht.

Für `commands.synchronize` ist die Freigabe für Änderungen der Fahrzeugeinstellungen nicht erforderlich. Der Auftrag übernimmt keine vorgemerkten Wünsche und wartet nicht auf deren Speicherwarteschlangen. Die Regel, dass am Handy höchstens ein Auftrag gleichzeitig läuft, gilt weiterhin.

Der nur lesbare Datenpunkt `battery.lastSyncRequestAt` heißt **Letzte an die App gesendete Synchronisationsanfrage**. Er speichert einen ISO-Zeitpunkt und wird nur bei einem gültigen neuen Anfragetimestamp aktualisiert. Eine Abfrage ohne gültigen neuen Anfragetimestamp erhält den bisherigen Verlauf. Dieser Wert bezeichnet die Anfrage an die App, während `battery.observedAt` die Auslesezeit bezeichnet. Beide sind kein Beleg für den Zeitpunkt einer Fahrzeugmessung oder eine abgeschlossene Synchronisation.

Die folgenden vier Wünsche werden mit `ack=false` geschrieben. `ack=true` bestätigt nur die private Speicherung; die Auswahl allein bedient das Handy nicht. Die Wünsche bleiben nach einem Adapterneustart erhalten. `null` behält die betreffende App-Einstellung bei, ein echtes Boolean `false` schaltet eine Option ausdrücklich aus.

| Vorgemerkter Wunsch | Erlaubte Werte | Getrennte App-Rückmeldung |
| --- | --- | --- |
| `charging.targetSoc` | `null` oder numerisch `50`, `60`, `70`, `80`, `90`, `100` % | `charging.socLimit` |
| `charging.targetReducedAcCurrent` | `null`, `true`, `false` | `charging.reducedAcCurrent` |
| `charging.targetAutoUnlockAc` | `null`, `true`, `false` | `charging.autoUnlockAc` |
| `charging.targetOptimizedBatteryUse` | `null`, `true`, `false` | `charging.optimizedBatteryUse` |

Die geprüften Positionen des Ladegrenzen-Reglers liegen bei **50 bis 100 % in 10-%-Schritten**. Zwischenwerte wie `55`, Zahlen als Text wie `"80"` und Schalterwerte als Text wie `"false"` werden abgewiesen. Ungültige Eingaben oder fehlgeschlagene Speicherungen stellen den letzten akzeptierten Wert wieder her und nennen das betroffene Feld in `charging.targetSettingsError`.

**`commands.applyChargingSettings`** mit `true` und `ack=false` übernimmt nur diese vier Ladewünsche. Mindestens ein Wunsch und die Freigabe für Änderungen der Fahrzeugeinstellungen sind erforderlich. Der Adapter berechnet den Ladegrenzen-Tipp aus der frisch gelesenen nativen Reglergeometrie und prüft den exakt angezeigten Zielwert. Wird **Speichern** angeboten, betätigt er die Schaltfläche einmal und öffnet die Einstellungen erneut, um die gespeicherten Werte zu prüfen. Erst danach wird Erfolg gemeldet.

Ein vorher bereits offener, manuell geänderter Einstellungsentwurf wird weder gespeichert noch verworfen. Die Änderungen zuerst direkt am Handy ausdrücklich speichern oder verwerfen und den Unterdialog verlassen. Der Adapter verwendet eine bereits sichtbare Volkswagen-Ansicht weiter, damit ein offener Entwurf nicht durch einen neuen App-Aufruf umgangen wird.

Nach einem Auswahlfehler ist ein neuer Ladeeinstellungsauftrag mit `charging_selection_failed` gesperrt. Genau das betroffene Feld erneut gültig auswählen oder **`commands.clearChargingSettings`** betätigen. Eine erfolgreiche Änderung eines anderen Feldes löscht den Fehler nicht. Der Knopf setzt ausschließlich die vier Ladewünsche atomar auf `null`, ohne das Handy zu bedienen; die Klima- und Temperaturwünsche bleiben erhalten.

Ladewünsche haben eine eigene Speicherwarteschlange. Nur die Übernahme der Ladeeinstellungen wartet auf vorangegangene Ladewünsche. Klimaaufträge und Ladeabfragen warten nicht auf eine laufende Speicherung der Ladewünsche; umgekehrt wartet ein Ladeeinstellungsauftrag nicht auf Temperatur- oder Klimawünsche. Am Handy läuft weiterhin höchstens ein Auftrag gleichzeitig. Ein angenommener Auftrag behält seinen ursprünglichen Schnappschuss; spätere Auswahlen gelten für den nächsten Auftrag. Auswahlfehler überschreiben keine Rückmeldung eines gleichzeitig laufenden Handyauftrags.

Ladeabfragen und Ladefehler verändern keine Klimarückmeldungen. Klimaabfragen und Klimafehler verändern ebenso wenig die Batterie- und Laderückmeldungen. Die vier Ladeeinstellungswünsche wählen keinen Lademodus. Der separate Modusbefehl kann unmittelbar Laden auslösen; ein zusätzlicher Lade-Start/Stopp-Knopf wird nicht angeboten.

**Optimierte Batterienutzung** bedeutet laut App, dass die Hochvoltbatterie für Fernbedienungsfunktionen der App verwendet werden kann. Das kann die Reichweite beeinflussen. Die Option ist keine automatische 80-%-Batteriepflegebegrenzung. Außerdem weist die App darauf hin, dass die eingestellte Ladegrenze nicht an festgelegten Ladeorten gilt. Die Erläuterungen für das ausgewählte Fahrzeug direkt in der App beachten.

Version 0.4.0 bestand **332 automatisierte Tests auf Linux**. Die Liveprüfung las Ladezustand und km-Reichweite aus der echten App, speicherte die Ladegrenzen 50 und 100 % und bestätigte sie nach erneutem Öffnen. Alle drei Schalter wurden in beiden Stellungen geprüft. Die Ladewünsche blieben nach einem Adapterneustart erhalten. Anschließend wurden die ursprünglichen App-Einstellungen wiederhergestellt und alle vier Wünsche gelöscht; die Klimatisierung blieb ausgeschaltet und unverändert. Die Liveprüfung von `commands.synchronize` löste genau eine Anfrage aus, bestätigte den deaktivierten App-Link, setzte `battery.lastSyncRequestAt` und las anschließend Batterie- und Ladewerte, ohne Einstellungen zu ändern. Damit ist die Anfrage an die App bestätigt; ein abgeschlossener Abgleich mit dem Fahrzeug wurde nicht nachgewiesen. Die neuen Batterie- und Ladefunktionen wurden bislang ausschließlich mit der **deutschen Volkswagen-App 4.8.1 auf einem Galaxy A31 mit Android 12** geprüft.

### 7.1 Lademodus getrennt auswählen

Ab 0.11.0 liest der vorhandene Ladebereich auch den Modus in den Reichweitendetails der App. Die neue Modusauswahl besitzt einen eigenen Wunsch, eigene Speicherung und einen eigenen ausdrücklichen Übernehmen-Befehl; die vier bisherigen Ladeeinstellungswünsche bleiben unabhängig.

0.11.1 ergänzt die Erkennung einer bestätigten Ansichtsvariante mit zusätzlichem leerem, nicht interaktivem Compose-Wrapper. 0.11.0 konnte diese Variante mit `unknown_state` vor dem Modus-Auswahltipp ablehnen. Die vollständige Prüfung der drei Karten, der Auswahl, ihrer Geometrie und möglicher Überlagerungen bleibt erhalten. Ein Update löst keinen Moduswechsel aus.

| Datenpunkt unter `vw-app.0` | Zugriff | Inhalt oder Bedienung |
| --- | --- | --- |
| `charging.mode` | Lesen | `immediate` = Sofortladen, `departure` = Laden zur Abfahrtszeit, `departureClimate` = Laden und Klima zur Abfahrtszeit; anfangs unbekannt `null`, Qualität beachten |
| `charging.modeObservedAt` | Lesen | ISO-UTC-Zeit der letzten erfolgreichen Modusbeobachtung, sonst leer; keine Fahrzeugmesszeit |
| `charging.targetMode` | Wunsch | Einer der drei Moduswerte oder `null` zum Beibehalten; mit `ack=false` schreiben |
| `charging.targetModeError` | Lesen | Fester Auswahl-/Speicherfehler; leer nach gültig gespeicherter Auswahl oder Löschen |
| `commands.applyChargingMode` | Nur schreiben | Einmal `true`, `ack=false`: gespeicherten Modus übernehmen, Schaltfreigabe erforderlich |
| `commands.clearChargingMode` | Nur schreiben | Einmal `true`, `ack=false`: nur den Moduswunsch löschen, ohne Handyzugriff |

Die Modus-Auswahlliste enthält nur die drei benannten Modi. `null` ist ein echter Nullwert zum Löschen des Wunschs, kein weiterer Modus und nicht der Text `"null"`. Falls die Oberfläche keinen Nullwert anbietet, dafür `commands.clearChargingMode` verwenden.

Zuerst `charging.targetMode` auswählen und auf dessen Bestätigung `ack=true` sowie ein leeres Fehlerfeld warten. Dann `commands.applyChargingMode` einmal auslösen. Nach dem Auftrag dessen Rückmeldung sowie `charging.mode`, gültige Qualität und eine frische `charging.modeObservedAt` prüfen. Ein bestätigter Wunsch bedeutet nur gespeichert; erst der ausdrückliche Befehl bedient die App.

**Die App speichert den Modus sofort beim Antippen, ohne Speichern-Knopf. Der Wechsel kann unmittelbar Laden auslösen.** Der Adapter betätigt keinen zusätzlichen Startknopf. Vor dem möglicherweise wirksamen Tipp gilt der gemeinsame Schalt-Mindestabstand von **60 bis 3600 Sekunden**, Standard **60**. Keine S-PIN ist erforderlich. Bei unklarem Ergebnis die App prüfen und neu lesen; weder einen automatischen Wiederholungsversuch noch einen zusätzlichen Start nachschieben.

Eine bereits wirksame Auswahl kann in der App erst verzögert bestätigt werden. 0.11.1 nutzt dafür die eingestellte `outcomeTimeoutSeconds` innerhalb der übergeordneten Auftragsfrist: begrenzte reine Leseabfragen bei Übergangsansichten, nötigenfalls einen sicheren Leseweg von der bestätigten Fahrzeugübersicht zurück in die Reichweitendetails sowie lesendes Warten nach genau einer nativen Header-Zurück-Aktion. Zur Bestätigung werden weder die Modusauswahl noch diese Zurück-Aktion wiederholt. Bleibt der Auftrag unklar, zuerst `commands.refreshCharging` verwenden und den gültigen Modus samt neuer `charging.modeObservedAt` prüfen; ein Fehler ist kein Nachweis dafür, dass die Auswahl unwirksam blieb.

Die Modusdatei und ihre Speicherbarriere sind von den vier bisherigen Ladewünschen getrennt. `commands.applyChargingSettings` übernimmt keinen Modus; `commands.clearChargingSettings` löscht keinen Moduswunsch. Ungültige Auswahl oder fehlgeschlagene Speicherung sperrt nur Mode-Apply bis zur gültigen Neuauswahl oder zum Modus-Löschen. Ein bereits angenommener Auftrag behält seine ursprüngliche Auswahl. Neustart, Wiederverbinden und Polling wenden keine Wünsche an und wiederholen keinen Moduswechsel.

`commands.refreshCharging` sowie die automatische Ladeabfrage erneuern den Modus samt tatsächlicher erfolgreicher Auslesezeit. Ist nur der Modus unlesbar oder fehlt eine gültige Moduszeit, bleiben der bisherige Modus und seine Zeit historisch erhalten, und `charging.mode` erhält `q=0x82`. Die Batterie und `refresh.charging.status` können trotzdem frisch sein. Auch eine nach ihrer eigenen Zeit abgelaufene Modusbeobachtung wird ungültig; Fehler, Ablauf und Neustart schreiben den letzten Erfolgszeitpunkt nicht fort.

**Geplantes Laden über Ladeort-Timer wird nur bei `departure` oder `departureClimate` ausgeführt.** Timer zuerst konfigurieren und aktivieren, danach den passenden Modus ausdrücklich auswählen und übernehmen und den gültigen Istmodus samt frischer Moduszeit prüfen. Timer dürfen auch bei `immediate` bearbeitet werden. Timer-Übernehmen stellt keinen Modus automatisch um; `enabled=true` allein ist kein Nachweis für ausgeführtes geplantes Laden.

## 8. Fahrzeugzustandsbericht lesen

**`commands.refreshVehicleReport`** mit `true` und `ack=false` liest das Menü **Fahrzeugzustandsbericht** der Volkswagen-App. Der Knopf ist ausschließlich schreibbar; Rückmeldung und Aktualität stehen getrennt unter `operation` und `refresh.vehicleReport`. Er ist der einzige Bedienpunkt für den Bericht; alle Datenpunkte unter `vehicleReport` sind ausschließlich lesbar. Es gibt keine Wunschwerte und keinen Übernehmen-, Speichern-, Schalt- oder Synchronisationsauftrag für den Bericht. Die Freigabe für Änderungen der Fahrzeugeinstellungen ist nicht nötig; das geprüfte Handy und das kalibrierte App-/Fahrzeugprofil bleiben erforderlich.

Der Bericht kann auf Anforderung oder durch die automatische Aktualisierung gelesen werden. `commands.refresh` liest weiterhin nur den Klimastatus. Ein Berichtauftrag wartet nicht auf das Speichern von Klima-, Temperatur- oder Ladewünschen. Am Handy kann weiterhin nur ein Auftrag gleichzeitig laufen.

Alle folgenden Datenpunkte liegen unter `vw-app.0`:

| Datenpunkt | Bedeutung |
| --- | --- |
| `vehicleReport.odometerText` | Kilometerstand als App-Text |
| `vehicleReport.odometerKm` | Eindeutig abgeleiteter Kilometerstand in km; sonst `null` mit ungültiger Qualität |
| `vehicleReport.nextServiceText` | Serviceangabe als App-Text |
| `vehicleReport.nextServiceDays` | Eindeutig abgeleitete Servicefrist in Tagen; sonst `null` mit ungültiger Qualität |
| `vehicleReport.nextServiceKm` | Eindeutig abgeleitete Servicefrist in km; sonst `null` mit ungültiger Qualität |
| `vehicleReport.summary` | Zusammenfassung aus der App |
| `vehicleReport.hasMessages` | Aus einer erkannten Zusammenfassung abgeleitete Meldungsangabe; sonst `null` mit ungültiger Qualität |
| `vehicleReport.messageCount` | Eindeutig abgeleitete Meldungsanzahl; sonst `null` mit ungültiger Qualität |
| `vehicleReport.synchronizationText` | Unveränderter Synchronisationshinweis im App-Bericht |
| `vehicleReport.notice` | Hinweistext des Berichts |
| `vehicleReport.additionalTexts` | Zusätzliche gelesene Berichttexte als JSON-Array-Zeichenfolge |
| `vehicleReport.json` | Vollständiger normalisierter Bericht als JSON-Zeichenfolge |
| `vehicleReport.observedAt` | ISO-Zeitpunkt, zu dem der Adapter den Bericht aus der App gelesen hat |

Zu jeder Kategorie gibt es `vehicleReport.<Kategorie>.status` und `vehicleReport.<Kategorie>.texts`. `texts` enthält eine JSON-Array-Zeichenfolge mit den gelesenen Kategorietexten.

| Kategorie im Datenpunkt | Bezeichnung in der App |
| --- | --- |
| `engine` | Antrieb |
| `assistance` | Assistenten |
| `brakes` | Bremsen |
| `lighting` | Fahrlicht |
| `comfort` | Komfort |
| `tires` | Reifen |
| `other` | Sonstige |

`no_messages` bedeutet ausschließlich, dass die App für diese Kategorie keine Meldungen anzeigt. Das ist keine Diagnose und keine unabhängige Bestätigung eines gesunden Fahrzeugzustands. Unbekannte Texte bleiben erhalten und werden mit `unknown` dargestellt. Aus namenlosen Symbolen werden weder Farben noch Warnstufen erfunden. Spätere Warnkonstellationen sind noch nicht live geprüft und werden deshalb nicht als bestätigte Interpretation ausgegeben.

Der rohe App-Hinweis in `vehicleReport.synchronizationText` ist von der Auslesezeit `vehicleReport.observedAt` zu unterscheiden. Beide lösen keine Synchronisierung aus und belegen nicht unabhängig den Messzeitpunkt am Fahrzeug. Kann der vollständige Bericht nicht sicher gelesen oder validiert werden, bleiben die letzten bekannten Berichtswerte mit ungültiger Qualität erhalten; `refresh.vehicleReport.status` zeigt `error`. Eine zu alte App-Auslesung wird mit `stale` und ungültiger Qualität gekennzeichnet. Die erhaltenen Werte sind ein historischer Stand, kein frisch gelesener Bericht; der Zeitpunkt der letzten erfolgreichen Auslesung wird bei einem Fehler nicht erneuert. Klima- und Laderückmeldungen bleiben unabhängig davon erhalten.

Version 0.5.0 bestand **391 automatisierte Tests auf Linux**. Echte obere und untere Berichtsansichten wurden zusätzlich lokal zu einem vollständigen validierten Modell zusammengeführt. Zwei Liveabfragen auf einem **Galaxy A31 mit Android 12 und deutscher Volkswagen-App 4.8.1** erfassten Kilometerstand, Serviceangabe, Zusammenfassung, Synchronisationshinweis, alle sieben Kategorien, Fußzeile und normalisiertes JSON korrekt; die zweite Abfrage erneuerte `observedAt`. Alle 27 tatsächlichen ioBroker-Berichtsobjekte wurden auf reinen Lesezugriff geprüft, übereinstimmend mit den automatisierten Schematests. Bei beiden Abfragen blieben 23 überwachte Klima-, Lade-, Wunsch- und Synchronisationsanfragewerte exakt unverändert. Es wurde weder eine Fahrzeugaktion noch Speichern oder Synchronisieren ausgelöst; die Klimatisierung blieb ausgeschaltet. Aktive Warnkonstellationen wurden weder erzeugt noch live geprüft.

## 9. Automatische Aktualisierung und Alter der App-Auslesung

Bei aktivierter Automatik werden `climate`, `charging`, `vehicleReport`, `vehicleAccess`, `vehicleInfo`, `departureClimate` und `departureLocations` fair nacheinander gelesen. Für jeden frisch entdeckten vorhandenen Ladeort kommt ein eigener Bereich `departureLocation_loc_<24hex>` hinzu, höchstens fünf. Es gibt weder überlappende Abfragen noch eine Warteschlange zum Nachholen verpasster Intervalle. Zwischen automatischen Aufträgen wartet der Adapter mindestens **5 Sekunden oder 25 % der zuletzt gemessenen Auftragsdauer**, je nachdem, welcher Wert größer ist. Ein vollständiger Rundlauf umfasst die Lesezeit aller Bereiche und diese Pausen. Weitere Ladeorte, Timereditoren und Untermenüs sowie die Fahrzeugverwaltung für die FIN benötigen zusätzliche Zeit; der Mindestabstand von 15 Sekunden ist kein Versprechen für einen vollständigen Rundlauf in dieser Zeit.

Fehler verlängern die Wiederholungsabstände bis fünf Minuten; ein längeres eingestelltes Mindestintervall bleibt wirksam. Bedienbefehle erhalten Vorrang und dürfen eine automatische Leseabfrage an einer sicheren Schrittgrenze ablösen. Nach einem Bedienauftrag wird eine Kontrollabfrage des betroffenen Bereichs bevorzugt. Sie liest ausschließlich; Start, Stopp, Speichern oder andere Änderungen werden dabei niemals automatisch wiederholt. Offene manuelle Entwürfe werden weiterhin weder gespeichert noch verworfen. **Jetzt synchronisieren** bleibt ein ausdrücklich ausgelöster Einzelauftrag.

Alle folgenden Datenpunkte unter `vw-app.0` sind ausschließlich lesbar. `<Bereich>` steht für `climate`, `charging`, `vehicleReport`, `vehicleAccess`, `vehicleInfo`, `departureClimate`, `departureLocations` oder `departureLocation_loc_<24hex>`:

| Datenpunkt | Bedeutung |
| --- | --- |
| `refresh.<Bereich>.status` | `fresh`, `stale`, `error` oder `unknown` für die App-Auslesung dieses Bereichs |
| `refresh.<Bereich>.lastReadAt` | Zeitpunkt der letzten erfolgreichen App-Auslesung |
| `refresh.<Bereich>.ageSeconds` | Alter dieser erfolgreichen Auslesung in Sekunden |
| `refresh.<Bereich>.lastErrorCode` | Fester Fehlercode der letzten Abfrage |
| `refresh.<Bereich>.lastDurationSeconds` | Dauer der letzten Abfrage in Sekunden |
| `refresh.<Bereich>.maxAgeSeconds` | Aktuell verwendete Altersgrenze |
| `refresh.autoBusy` | Eine automatische App-Abfrage läuft |

`fresh` bedeutet nur, dass der Adapter die **App** kürzlich erfolgreich gelesen hat. `stale` bezeichnet eine zu alte App-Auslesung, `error` eine fehlgeschlagene Abfrage und `unknown` einen Bereich ohne erfolgreiche Beobachtung. Das besagt nicht, wann das Fahrzeug die Daten gemessen oder übertragen hat. Der unveränderte App-Hinweis in `vehicleReport.synchronizationText` bleibt davon getrennt; häufiges Lesen fordert keine neue Fahrzeugsynchronisation an.

**App-Auslesung als veraltet markieren nach** entspricht `refreshMaxAgeSeconds`. `0` wählt eine automatische Altersgrenze. Dabei gilt der größere Wert aus **90 Sekunden** und dem **Doppelten des größeren Werts aus eingestelltem Mindestabstand und geschätzter vollständiger Rundlaufzeit**. Alternativ lässt sich eine feste Grenze von 30 bis 86400 ganzen Sekunden wählen. Diese Einstellung ändert nur die Einordnung der Auslesezeit, weder die Abfragefrequenz noch den Synchronisationshinweis der App. `operation.lastUpdated`, `battery.observedAt`, `vehicleReport.observedAt` und `vehicleInfo.observedAt` bleiben die Zeitpunkte der jeweiligen erfolgreichen App-Auslesung.

Version 0.6.0 bestand **437 automatisierte Tests auf Linux**. Bei der vorangegangenen RC1-Liveprüfung auf dem Referenz-Galaxy-A31 wurde jeder Bereich mit eingestelltem Mindestabstand von 15 Sekunden etwa alle **90–92 Sekunden** erneut gelesen. Bei ausgeschalteter Automatik und einer Altersgrenze von 30 Sekunden blieben abgelaufene Werte mit ungültiger Qualität erhalten; Wünsche und Synchronisationsanfrage-Historie blieben unverändert. Die Übergabe vom automatischen Lesen an einen manuell angeforderten Bericht dauerte etwa **1,75 Sekunden**. Das ist die Übergabezeit, nicht die Dauer der anschließenden Berichtsabfrage. Automatische Abfragen bewahrten die manuelle Auftragsrückmeldung. Bei diesen Liveprüfungen wurden weder Klimastart oder -stopp noch Speichern von Fahrzeugeinstellungen oder Synchronisieren ausgelöst. Sechs zusätzliche Regressionstests mit simulierten Ansichten prüfen die kooperative Übergabe über die Zonen-Seite, harte Abbrüche, Zeitlimits und den Erhalt manueller Entwürfe; sie sind kein zusätzlicher physischer Start-/Stopp-Test.

Diese Laufzeitmessung stammt aus Version 0.6.0 mit den drei ursprünglichen Bereichen. Sie sagt die längere Rundlaufzeit mit den zusätzlichen Abfahrtszeit- und Ladeortabfragen aus Version 0.7.0 nicht voraus.

## 10. Abfahrtszeiten und vorhandene Ladeorte

Version 0.7.0 liest die **zwei Klima-Abfahrtszeiten** und **bis zu fünf bereits im Fahrzeug angelegte Ladeorte** mit jeweils drei Timern. Die folgenden IDs stehen unter `vw-app.0`.

| Datenpunkt oder Befehl | Bedeutung |
| --- | --- |
| `commands.refreshDepartureClimate` | Beide Klima-Abfahrtszeiten auslesen |
| `commands.refreshDepartureLocations` | Ladeortliste und Zuordnungen neu erkennen |
| `departures.climate.observedAt` | Letzte erfolgreiche App-Auslesung der Klima-Abfahrtszeiten |
| `departures.climate.timer1` / `timer2` | Istwerte und Wünsche des jeweiligen Klimatimers |
| `chargingLocations.observedAt` | Letzte erfolgreiche Auslesung der Ladeortliste |
| `chargingLocations.loc_<24hex>` | Stabiler Schlüssel eines Ladeorts innerhalb des bestätigten Fahrzeugprofils |
| `chargingLocations.loc_<24hex>.commands.refresh` | Drei Timer, Einstellungen und bevorzugte Zeiten dieses Ortes auslesen |

Neue Ladeorte zuerst im Fahrzeug anlegen und anschließend die Liste auslesen. Der Adapter legt keine Ladeorte an und löscht sie nicht. Die Ortsdatenpunkte `name`, `present`, `activeTimerCount`, `bindingStatus` und `observedAt` zeigen Namen, Vorhandensein, aktive Timer, Bindungsrückmeldung und Auslesezeit. Der Schlüssel folgt der internen Ortskennung und bleibt unabhängig von Reihenfolge und Anzeigename. Umbenennen, Entfernen und Wiedererscheinen eines Ortes erhalten gespeicherte Wünsche und historische Werte, sperren aber deren bisherige Feldbindungen. Das gilt auch nach erfolgreichem Umbenennen durch den Adapter: Alle vorhandenen Nicht-null-Wünsche der alten Bindung, einschließlich des gerade verwendeten Namenswunsches, müssen vor einem weiteren Übernehmen ausdrücklich neu gewählt oder gelöscht werden. Nach einer Umbenennung ist außerdem eine vollständige neue Listenabfrage nötig; bis zu deren Erfolg bleibt der bisherige Gesamtbestand als veraltet markiert.

Jeder Klimatimer und die drei Orts-Timer `timer1`, `timer2`, `timer3` besitzen dieselben Grundfelder:

| Feld unter dem Timer | Bedeutung |
| --- | --- |
| `enabled`, `time`, `days`, `repeat` | Nur lesbare App-Einstellungen: Aktivierung, `HH:mm`, Wochentage als JSON-Array und Wiederholung |
| `date` | Nur lesbares lokales Kalenderdatum eines einmaligen Timers, bei wiederkehrenden Timern `null` |
| `vehicleOffset`, `isLocalVehicleTime`, `source` | Zeitmetadaten und Beobachtungsquelle der App |
| `daysSummary`, `daysSummaryRecognized` | Roher Wochentagshinweis aus der Übersicht und dessen Erkennbarkeit |
| `targetEnabled`, `targetTime`, `targetDays`, `targetRepeat` | Privat gespeicherte Wünsche; `null` behält den jeweiligen App-Wert bei |
| `targetError` | Fehler beim Auswählen oder Speichern eines Wunsches |
| `commands.apply` | Wünsche nur dieses Timers ausdrücklich übernehmen und gespeicherten App-Stand prüfen |
| `commands.clear` | Wünsche nur dieses Timers löschen, ohne den App-Timer zu ändern |

Wünsche mit `ack=false` schreiben. Ein Beispiel für einen wiederkehrenden Timer ist `targetTime="07:30"`, `targetDays='["mon","wed","fri"]'`, `targetRepeat=true` und der gewünschte boolesche Wert für `targetEnabled`. Die Tageskennungen lauten `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`. Anschließend am **gleichen Timer** `commands.apply=true` mit `ack=false` schreiben. Für Zeitänderungen unterstützt die App **Fünf-Minuten-Schritte**. Ein einmaliger Timer mit `repeat=false` benötigt genau einen ausgewählten Wochentag. Sein Kalenderdatum bestimmt die App und liefert es als Istwert zurück; es gibt keinen zusätzlichen beschreibbaren Datumsdatenpunkt. Der Adapter rechnet diese Angaben nicht über die Zeitzone des ioBroker-Hosts um und setzt ein altes Einmaldatum durch bloßes Auslesen nicht neu.

`ack=true` am Wunsch bestätigt zunächst nur die private Speicherung im Adapter. Für **Übernehmen** ist die Freigabe für Änderungen der Fahrzeugeinstellungen nötig. Der Auftrag verwendet einen festen Schnappschuss seiner angenommenen Wünsche, speichert Änderungen ausdrücklich und öffnet den Timer zur Kontrolle erneut. Dabei wird kein sofortiger Klima- oder Ladestart beziehungsweise -stopp betätigt. Einen Timer zu aktivieren erlaubt den für später geplanten Vorgang gemäß App. Offene manuelle Entwürfe werden weder heimlich gespeichert noch verworfen. Eine von Android angenommene Eingabe beweist noch keine gespeicherte Einstellung. Bei unklarem Ergebnis zuerst die App prüfen; der Adapter wiederholt Schreibaktionen nicht automatisch.

Die App kann beim Speichern einen Timer einschalten; der Adapter prüft danach den gewünschten Aktivierungszustand und stellt ihn gegebenenfalls her. Bei `targetEnabled=null` ist der gewünschte Endzustand die ursprüngliche Aktivierung. Zwischen Speichern und einer anschließenden Korrektur kann der Timer durch die App vorübergehend eingeschaltet sein.

Nach Speichern und direkt gespeicherten Schalteränderungen wartet der Adapter jeweils **20 Sekunden**, bevor er den gespeicherten Zustand erneut öffnet und prüft. Zusammen mit Navigation und vollständiger Kontrollabfrage können Änderungen dadurch mehrere Minuten dauern. Die Pause dient der Stabilität der App und bestätigt keine neue Fahrzeugtelemetrie.

Ladetimer liefern zusätzlich die nur lesbaren Felder `climatisation`, `profileId` und `isPreferredTimesAvailable`. Die vier Timerwünsche verändern diese Zusatzangaben nicht.

Unter jedem Ort enthält `settings` die Wünsche `targetName`, `targetReducedAcCurrent` und `targetAutoUnlockAc` sowie die Istwerte `name`, `reducedAcCurrent` und `autoUnlockAc`. Die eigenen `settings.commands.apply` und `.commands.clear` übernehmen beziehungsweise löschen nur diese drei Wünsche. `settings.targetError` nennt Auswahlfehler. Die beiden ortsbezogenen Ladegrenzen werden in der beobachteten App als Grafik ohne auslesbare Zahlenwerte gezeichnet. Deshalb bleiben `settings.directSoc` und `settings.socLimit` **`null` mit nicht verfügbarer Qualität**; `settings.socReadCapability` lautet `not_exposed_by_app`. Für diese Ortsgrenzen gibt es keine SOC-Wunschdatenpunkte. Die separat geprüfte globale Grenze `charging.targetSoc` mit `commands.applyChargingSettings` bleibt unverändert verfügbar; laut App gilt diese globale Grenze nicht an vordefinierten Ladeorten.

`preferredTimes.window1` bis `window4` enthalten die nur lesbaren Angaben `start`, `end`, `enabled` und `editable`. Pro Fenster lässt sich ausschließlich der boolesche Wunsch `targetEnabled` oder `null` vormerken. Die gemeinsamen `preferredTimes.commands.apply` und `.commands.clear` übernehmen beziehungsweise löschen diese vier Schalterwünsche; `preferredTimes.targetError` meldet Auswahlfehler. Die Zeitfenster selbst bleiben nur lesbar: Laut App werden ihre genauen Anfangs- und Endzeiten im Infotainment-System des Fahrzeugs eingerichtet. Der App-Hinweis steht in `preferredTimes.notice`.

Die automatische Aktualisierung umfasst die neuen Bereiche mit den Frische- und Fehlerregeln aus Abschnitt 9. Lesen übernimmt keine Wünsche und fordert keine Fahrzeugsynchronisation an. Eine kürzlich gelesene App bestätigt weiterhin keine neuen Fahrzeugmesswerte.

Der kleine Android-Helfer ist im Adapter enthalten und läuft innerhalb derselben verwalteten ADB-Verbindung. Es sind weder ein weiterer VM-Dienst noch eine installierte Helfer-APK, ein Python-Prozess oder ein JDK für den Betrieb nötig. Nur Entwickler, die den Helfer neu bauen, benötigen das in der README beschriebene Java-Bauwerkzeug.

### Belegte Prüfungen von Version 0.7.0

Die Linux-RC2-Prüfung bestand **642 von 642 Tests**, einschließlich aller POSIX-Prüfungen. Der Bytevergleich umfasste **73 öffentliche Quelldateien und 42 npm-Paketdateien**. Die Liveprüfungen verwendeten ein **Galaxy A31 mit Android 12 und deutscher Volkswagen-App 4.8.1**:

| Ausschließlich lesender App-Auftrag | Gemessene Dauer |
| --- | --- |
| Beide Klima-Abfahrtszeiten | 30,056 s |
| Bestandsaufnahme des einen vorhandenen Ladeorts | 19,833 s |
| Drei Timer, Einstellungen und vier bevorzugte Zeitfenster dieses Ortes | 62,688 s |

Jede Leseabfrage kehrte ohne Einstellungsänderung zur Fahrzeugübersicht zurück. Der produktive Controller änderte außerdem einen deaktivierten einmaligen Ladetimer von **Samstag 08:30 auf Montag 08:35**, speicherte, wartete, korrigierte die automatische Aktivierung der App und bestätigte den abschließend deaktivierten Timer durch erneutes Öffnen und vollständiges Auslesen. Das dauerte **152,533 Sekunden**, die Wiederherstellung **151,817 Sekunden**. Danach entsprachen die gesamten Ladeort-, Timer-, Einstellungs- und Zeitfensterinhalte exakt dem Ausgangsmodell. Eine Unicode-Namensänderung zusammen mit beiden Optionen für reduzierten AC-Ladestrom und automatisches AC-Entriegeln dauerte **164,472 Sekunden**, die Wiederherstellung **167,846 Sekunden**; auch danach war das vollständige Modell wieder exakt auf dem Ausgangsstand.

Das Aktivieren des bevorzugten Zeitfensters 1 mit dem produktiven Controller dauerte **155,772 Sekunden** und wurde durch eine vollständige Ortsabfrage bestätigt; alle anderen Modellwerte blieben auf dem Ausgangsstand. Die Wiederherstellung auf `false` über den **installierten Adapter 0.7**, mit `targetEnabled` und `commands.apply`, war nach **160,559 Sekunden** erfolgreich. Alle **62 ioBroker-Istwert-Datenpunkte** entsprachen dem wiederhergestellten Ausgangsmodell; die beiden absichtlich nicht verfügbaren Orts-SOC-Werte blieben `null` mit ungültiger Qualität. Bestätigung, Qualität und App-Auslesezeitpunkte wurden geprüft. Anschließend löschte `preferredTimes.commands.clear` deren vier Wünsche, ohne einen Handyauftrag zu starten. Die übrigen Wünsche und die Historie der Synchronisationsanfragen blieben unverändert.

Diese Prüfungen betätigten weder Klimastart oder -stopp noch Synchronisieren. Fünf Ladeorte sind durch synthetische Tests abgedeckt; am echten Gerät war ein Ort vorhanden. Der Einmaltimer-Test zeigte einen zwischenzeitlichen Wechsel von Wiederholen im Entwurf und bestätigte abschließend einen gespeicherten Einmaltimer. Ein direkt gespeicherter wiederkehrender Timer wurde nicht live geprüft. Die Zeiten oben messen einzelne Aufträge und keinen vollständigen automatischen Aktualisierungsrundlauf; sie dürfen nicht als gemessene Gesamtrundlaufzeit ausgegeben werden.

## 11. Türen, Fenster, Kofferraum und Verriegelung

Ab Version 0.8.0 stehen unter `vw-app.0.vehicleAccess` einzelne, ausschließlich lesbare Zustände bereit:

| Datenpunkt | Bedeutung |
| --- | --- |
| `doors.frontLeftOpen`, `doors.frontRightOpen`, `doors.rearLeftOpen`, `doors.rearRightOpen` | Jede Tür einzeln: `true` offen, `false` geschlossen, `null` unbekannt |
| `windows.frontLeftOpen`, `windows.frontRightOpen`, `windows.rearLeftOpen`, `windows.rearRightOpen` | Jedes Fenster einzeln: `true` offen, `false` geschlossen, `null` unbekannt |
| `trunkOpen` | Kofferraum: `true` offen, `false` geschlossen, `null` unbekannt |
| `locked` | `true` verriegelt, `false` entriegelt, `null` unbekannt; getrennt von den Öffnungen |
| `warningText` | Von der App auslesbarer Warnhinweis zu offenen oder eingeschalteten Komponenten; leer bei fehlendem Hinweis |
| `synchronizationText` | Synchronisationshinweis auf der Startseite |
| `observedAt` | Zeitpunkt der erfolgreichen App-Auslesung |

Mit `vw-app.0.commands.refreshVehicleAccess=true` und `ack=false` lässt sich dieser Bereich sofort lesen. Die automatische Aktualisierung umfasst ihn ebenfalls. `refresh.vehicleAccess.*` führt Alter, letzte erfolgreiche Auslesung, Dauer, Gültigkeit und Fehler nach denselben Regeln wie die anderen Bereiche mit. Das eingestellte Mindestintervall gilt weiterhin; die Navigation durch alle Bereiche benötigt mehr Zeit. Manuelle Aufträge behalten Vorrang, und das Handy wird nur von einem Auftrag zugleich bedient.

Die VW-App nennt offene Komponenten in einer gemeinsamen Beschreibung. Wenn alles geschlossen ist, fehlt dieser Warntext vollständig. Der Adapter wertet ein fehlendes Bauteil nur innerhalb der vollständig erkannten Startseitenstruktur mit lesbarem Statusbereich als geschlossen. Unvollständige, abgeschnittene, widersprüchliche oder nicht unterstützte Darstellungen werden nicht zu geratenen Geschlossen-Werten. Unbekannte Werte besitzen ungültige Qualität. Bei Fehlern und zu alten Abfragen bleiben die letzten Werte als historische Beobachtung erhalten und werden ungültig markiert; der letzte erfolgreiche Auslesezeitpunkt wird bei Fehlern nicht fortgeschrieben.

Die Tür-/Fensterwerte und die Verriegelung sind unabhängig: Ein Fahrzeug kann bei geschlossenen Türen und Fenstern weiterhin entriegelt sein. Die Abfrage verriegelt oder entriegelt nichts, bedient keine Öffnung, übernimmt keine Wünsche und fordert keine Fahrzeugsynchronisation an. Eine Freigabe für Einstellungsänderungen ist dafür nicht nötig. `observedAt` bezeichnet eine App-Auslesung, keine neue Messung am Fahrzeug; auch `synchronizationText` ersetzt keinen bestätigten Fahrzeug-Messzeitpunkt.

Die Untersuchung am Referenzgerät erfasste alle Öffnungen offen und das Fahrzeug entriegelt, danach das einzelne Schließen von Fahrertür, Fahrerfenster und Kofferraum sowie alle Öffnungen geschlossen bei beiden Verriegelungszuständen. Die jeweiligen Bezeichnungen verschwanden unabhängig voneinander. Private Originalansichten werden nicht veröffentlicht; die öffentlichen Tests verwenden nachgebildete Ansichten.

Eine teilweise gescrollte Fahrzeugübersicht richtet der Adapter über die native Scrollfunktion der App aus. Es gibt dafür keine Wischgeste als Ersatz, die eine Aktualisierung durch Herunterziehen auslösen könnte. Nur eine vollständig sichtbare und eindeutig erkannte Fahrzeug- und Warnanzeige erlaubt die Veröffentlichung der Öffnungszustände. Die bekannte Detailansicht **Fahrzeug** darf der Adapter über ihren Zurück-Pfeil verlassen; offene PIN-Abfragen bleiben geschützt.

## 12. Fahrzeug verriegeln und entriegeln

Voraussetzung ist, dass beide Funktionen für das ausgewählte Fahrzeug bereits manuell in der Volkswagen-App funktionieren. In den Adaptereinstellungen die vierstellige **Volkswagen S-PIN** eingeben und **Fahrzeug verriegeln und entriegeln erlauben** aktivieren, anschließend speichern. Führende Nullen gehören zur PIN. Diese Freigabe ist unabhängig von der Freigabe für Klima- und Einstellungsänderungen; neue und aktualisierte Instanzen erhalten sie nicht automatisch.

Die S-PIN ausschließlich in diesem maskierten Einstellungsfeld hinterlegen, niemals in einem Datenpunkt, Skript, Chat oder Fehlerbericht. `sPin` ist als `encryptedNative` und `protectedNative` deklariert: ioBroker Admin verschlüsselt die gespeicherte Konfiguration und der Controller entschlüsselt sie für den Adapterstart. Eine vollständige Absicherung gegenüber Administratoren des ioBroker-Systems ergibt sich daraus nicht. Die verwendete Admin-/JSON-config-Generation kann beim Speichern die entschlüsselte Konfiguration in die Browserkonsole schreiben; deshalb keine Konsolen- oder Konfigurationsmitschnitte mit eingetragener PIN weitergeben. Siehe [JSON-config 10.1.2](https://github.com/ioBroker/json-config/blob/v10.1.2/src/JsonConfig.tsx#L664-L682).

`commands.lockVehicle` beziehungsweise `commands.unlockVehicle` einmal mit `true` und `ack=false` schreiben. Der Adapter prüft Handy, App-Version, Fahrzeug und den frisch gelesenen Verriegelungszustand. Ist der gewünschte Zustand bereits erkennbar, wird keine PIN eingegeben. Andernfalls öffnet er die passende PIN-Maske und überträgt die PIN einmal über den geschützten Eingabekanal. In der geprüften App benötigen **beide** Richtungen die S-PIN; die vierte Ziffer löst den Auftrag automatisch aus.

Ein begonnener Auftrag wird bei unklarer Rückmeldung nicht wiederholt. `security.blocked` und `security.reason` zeigen die über Neustarts erhaltene Auftragssperre an. Eine offene oder fehlerhafte PIN-Abfrage wird konservativ als ungeklärter Ausgang behandelt; der Adapter versucht keine weiteren PIN-Eingaben. Zuerst App, Fahrzeugzustand und hinterlegte PIN prüfen. Danach lässt sich die Sperre ausdrücklich über **Nach korrigierter S-PIN die Sicherheitssperre zurücksetzen** in den Adaptereinstellungen aufheben. Dies gibt ausschließlich einen späteren eigenen Auftrag frei und sendet selbst keinen Fahrzeugbefehl.

Die Rückmeldung erfolgt über `vehicleAccess.locked` und die zugehörigen Aktualitätsdaten. Das regelmäßige Auslesen bleibt aktiv und erfasst auch manuelle Bedienung oder eine automatische Wiederverriegelung. Es schaltet das Fahrzeug nie selbstständig und gleicht keinen gespeicherten Verriegelungswunsch ab. Eine App-Rückmeldung ist weiterhin keine unabhängige Bestätigung am Fahrzeug.

Nach akzeptierter PIN-Eingabe blendet der Adapter eine noch sichtbare Tastatur nach erneuter Prüfung einmal aus. Eine bereits ausgeblendete Tastatur erhält keinen Zurück-Befehl. Während vorübergehender Ansichtswechsel wartet er innerhalb des eingestellten Bestätigungszeitraums weiter und prüft ausschließlich lesend; PIN und Fahrzeugbefehl werden dabei nicht wiederholt. Am 25. Oktober 2026 wurden mit der korrigierten Version je ein Entriegelungs- und Verriegelungsauftrag erfolgreich geprüft: gültige passende App-Anzeige, fehlerfreie Adapterrückmeldung, aufgehobene lokale Sicherheitssperre und unabhängige Nutzerbestätigung am Fahrzeug. Die Tastatur war nach beiden Aktionen ausgeblendet. Dies bestätigt die Referenzkombination Galaxy A31, Android 12 und Volkswagen-App 4.8.1; andere Ansichten bleiben gesondert zu prüfen.

## 13. Fahrzeug-Identifizierungsnummer auslesen

Ab Version 0.10.0 liest der Adapter die **FIN** des ausgewählten Fahrzeugs aus der Fahrzeugverwaltung der App. Diese erreichst du über das Fahrzeug-Symbol oben rechts auf der Startseite.

| Datenpunkt unter `vw-app.0` | Bedeutung |
| --- | --- |
| `vehicleInfo.vin` | Ausschließlich lesbare Fahrzeug-Identifizierungsnummer des zugeordneten Fahrzeugs |
| `vehicleInfo.observedAt` | Zeitpunkt der letzten erfolgreichen App-Auslesung dieser Information |
| `commands.refreshVehicleInfo` | Einmal `true` mit `ack=false` schreiben, um die FIN sofort zu lesen |
| `refresh.vehicleInfo.*` | Aktualitätsstatus, Alter, letzte erfolgreiche Auslesung, Dauer, Fehlercode und Altersgrenze |

Die automatische Aktualisierung nimmt `vehicleInfo` als eigenen Lesebereich in dieselbe faire Reihenfolge auf. Es gilt der eingestellte Mindestabstand je Bereich; die zusätzliche Navigation verlängert den vollständigen Rundlauf. Manuelle Bedienbefehle behalten Vorrang. Diese Abfrage benötigt weder die Freigabe für Einstellungsänderungen noch die S-PIN. Sie fügt kein Fahrzeug hinzu, wählt kein anderes Fahrzeug aus, übernimmt keine Wünsche und synchronisiert das Fahrzeug nicht.

Eine fehlende, mehrdeutige oder ungültige FIN wird nicht geraten. Bei Lesefehlern und nach Ablauf der Gültigkeit bleiben die zuletzt erfolgreich gelesene FIN und ihr erfolgreicher Auslesezeitpunkt erhalten; die FIN wird mit ungültiger Qualität markiert. Nach einem Adapterneustart ist eine erhaltene FIN zunächst ebenfalls historisch, bis sie erneut erfolgreich gelesen wurde. Fehler in diesem eigenen Bereich machen die unabhängig gelesenen Tür- und Fensterzustände nicht ungültig. `observedAt` bezeichnet eine App-Auslesung, keine neue Messung am Fahrzeug.

## Schnittstelle der Einrichtungsschaltflächen

Alle Aktionen gehen über die ioBroker-Messagebox an die konfigurierte Instanz. Es werden keine beliebigen Shell-Kommandos oder Skripte aus der Oberfläche übertragen.

| Befehl | Nutzdaten | Verhalten |
| --- | --- | --- |
| `installRuntime` | `{acceptLicense: true}` | Explizite Laufzeitinstallation nach Zustimmung in der geöffneten Oberfläche |
| `pair` | `{hostIp, pairPort, code}` | Einmalige Android-Kopplung; `code` bleibt eine sechsstellige Zeichenfolge |
| `probe` | `{hostIp, connectPort}` | Verbindung, Gerätebindung und installierte App-Version prüfen; keine App-Freigabe |
| `calibrate` | `{hostIp, connectPort}` | App und Fahrzeug lesend übernehmen; geprüfte Profilwerte als Konfigurationsvorschlag zurückgeben |
| `keepAwake` | `{hostIp, connectPort}` | Android-Wachhalten beim Laden ausdrücklich aktivieren |
| `resetSecurityBlock` | `{}` | Nur aus ioBroker Admin; lokale Auftragssperre ausdrücklich aufheben, ohne Handybedienung oder PIN-Rückgabe |

`jsonData` interpoliert die Ports als Zeichenfolgen. Das Backend muss sie streng als ganzzahlige Ports zwischen 1 und 65535 prüfen. IP-Adressen werden ebenfalls im Backend geprüft; die Eingabehilfe im Browser ersetzt diese Prüfung nicht.

Die `sendTo`-Elemente `probe` und `calibrate` verwenden `useNative: true`. Eine sichere Antwort kann beispielsweise `{result: "calibration_success", native: {approvedAppVersion: "…", vehicleMarker: "…"}, saveConfig: true}` lauten. Vor Übernahme werden die Werte im Formular angezeigt und müssen gespeichert werden. `probe` darf in `native` ausschließlich Verbindungswerte zurückliefern; die App-Freigabe bleibt der ausdrücklichen Kalibrierung vorbehalten.

Gerätekennungen, ADB-Schlüssel und private Einrichtungsdaten gehören nicht in diese Rückgabe. Der Kopplungscode darf weder an ein Datenobjekt geschrieben noch in Logs, Fehlermeldungen oder Antwortobjekte übernommen werden. Die Oberfläche setzt weder einen Kopplungscode-State noch ein persistentes `native`-Feld dafür voraus.

Die Erfolgskennungen sind `runtime_installed`, `pair_success`, `probe_success`, `calibration_success` und `keep_awake_applied`. Rückmeldungen des Backends sollen feste, verständliche Meldungen enthalten und keine rohen Prozessausgaben.

## Warum die Kopplungseingaben nicht gespeichert werden

Die Felder heißen `_pairPort` und `_pairCode` und setzen zusätzlich `doNotSave: true`. Auch die nur im Browser gesetzte Lizenzzustimmung `_acceptRuntimeLicense` ist vorübergehend. Laut der [offiziellen JSON-Config-Dokumentation](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/README.md) werden mit `_` beginnende Attribute nicht in das Instanzobjekt gespeichert; `doNotSave` kennzeichnet zusätzlich ein ausschließlich intern verwendetes Attribut. Ein Feld vom Typ `password` maskiert lediglich die Anzeige und verhindert für sich genommen keine Speicherung.

Die verwendeten Typen und Eigenschaften sind im [offiziellen JSON-Config-Schema](https://github.com/ioBroker/ioBroker.admin/blob/master/packages/jsonConfig/schemas/jsonConfig.json) beschrieben. Für die native Oberfläche benötigt `common.adminUI.config` den Wert `json`, für die Aktionen `common.messagebox` den Wert `true`.
