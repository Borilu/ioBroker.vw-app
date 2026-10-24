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

Zunächst die Klima- und Ladezustände abfragen und deren Rückmeldungen mit der Volkswagen-App vergleichen. Danach bei Bedarf **Klimastart, Stopp und Änderungen der Fahrzeugeinstellungen erlauben** aktivieren und speichern. Diese Freigabe gilt auch für Änderungen der Ladeeinstellungen. Ohne Freigabe sind lesende Abfragen und das Speichern von Wünschen möglich; tatsächliche Änderungen in der App bleiben gesperrt. Die Einrichtungsschaltflächen selbst führen keinen Klimatisierungsstart oder -stopp aus.

**Beim Laden wachhalten jetzt aktivieren** ändert auf ausdrücklichen Klick die entsprechende Android-Einstellung. Die zusätzliche dauerhafte Option erlaubt dem Adapter, diese Einstellung bei späteren Verbindungen anzuwenden. Eine vorhandene Bildschirmsperre muss weiterhin am Handy entsperrt werden.

Automatische Statusabfragen sind zunächst ausgeschaltet (`pollIntervalSeconds=0`). Wenn gewünscht, ein Intervall von mindestens 300 Sekunden einstellen. Ein Durchlauf liest zuerst den Klimastatus und anschließend Batterie und Ladeeinstellungen, sofern das Handy zwischen den Aufträgen weiterhin frei ist. Übernimmt zwischenzeitlich ein anderer Auftrag das Handy, wird die zusätzliche Ladeabfrage nicht dahinter eingereiht. Automatische Abfragen lösen keine Synchronisationsanfrage aus. `commands.refresh` bleibt eine reine Klimaabfrage; Batterie und Ladeeinstellungen können weiterhin getrennt mit `commands.refreshCharging` gelesen werden. Jede Abfrage bedient beziehungsweise öffnet die App; sie stellt keine passive Cloud-Abfrage dar. Die angezeigten Werte stammen aus der App und bestätigen nicht unabhängig den Fahrzeugzustand.

Die Rückmeldung der Volkswagen-App kann nach einem Start verzögert eintreffen. Neue Instanzen warten nach einem Schaltversuch standardmäßig bis zu **120 Sekunden** auf die App-Bestätigung. In den Experteneinstellungen lässt sich die **Wartezeit auf Bestätigung in der App** zwischen 30 und 150 Sekunden wählen. Das **Zeitlimit je Auftrag** beträgt standardmäßig 300 Sekunden und umfasst Verbindung, Navigation, Temperaturwahl und Bestätigung zusammen. Ein kleineres oder bereits weitgehend verbrauchtes Gesamtlimit beendet die Wartezeit früher.

Vorhandene Instanzen behalten ihr gespeichertes Gesamtlimit. Steht dort noch 125 oder 180 Sekunden, für Temperaturwahl und Start zusammen 300 Sekunden einstellen und speichern. Größere Temperatursprünge werden über frisch ausgelesene Einzelschritte bedient und benötigen zusätzliche Zeit. Eine längere Wartezeit löst keinen weiteren Startversuch aus.

`climate.confirmationSource` zeigt, worauf sich die Rückmeldung stützt: `app_controls` steht für die Klimabedienelemente, `app_overview` für die exakt erkannte aktive Klimabeschreibung in der Fahrzeugübersicht. Nach einem unklaren Ergebnis steht dort `none`. Alle Angaben stammen aus der App; `climate.vehicleConfirmed` bleibt `false`.

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

Ladeabfragen und Ladefehler verändern keine Klimarückmeldungen. Klimaabfragen und Klimafehler verändern ebenso wenig die Batterie- und Laderückmeldungen. Der Adapter bietet **keine Lade-Start/Stopp-Funktion**; die Ladebefehle starten oder stoppen auch keine Klimatisierung.

**Optimierte Batterienutzung** bedeutet laut App, dass die Hochvoltbatterie für Fernbedienungsfunktionen der App verwendet werden kann. Das kann die Reichweite beeinflussen. Die Option ist keine automatische 80-%-Batteriepflegebegrenzung. Außerdem weist die App darauf hin, dass die eingestellte Ladegrenze nicht an festgelegten Ladeorten gilt. Die Erläuterungen für das ausgewählte Fahrzeug direkt in der App beachten.

Version 0.4.0 bestand **332 automatisierte Tests auf Linux**. Die Liveprüfung las Ladezustand und km-Reichweite aus der echten App, speicherte die Ladegrenzen 50 und 100 % und bestätigte sie nach erneutem Öffnen. Alle drei Schalter wurden in beiden Stellungen geprüft. Die Ladewünsche blieben nach einem Adapterneustart erhalten. Anschließend wurden die ursprünglichen App-Einstellungen wiederhergestellt und alle vier Wünsche gelöscht; die Klimatisierung blieb ausgeschaltet und unverändert. Die Liveprüfung von `commands.synchronize` löste genau eine Anfrage aus, bestätigte den deaktivierten App-Link, setzte `battery.lastSyncRequestAt` und las anschließend Batterie- und Ladewerte, ohne Einstellungen zu ändern. Damit ist die Anfrage an die App bestätigt; ein abgeschlossener Abgleich mit dem Fahrzeug wurde nicht nachgewiesen. Die neuen Batterie- und Ladefunktionen wurden bislang ausschließlich mit der **deutschen Volkswagen-App 4.8.1 auf einem Galaxy A31 mit Android 12** geprüft.

## 8. Fahrzeugzustandsbericht lesen

**`commands.refreshVehicleReport`** mit `true` und `ack=false` liest das Menü **Fahrzeugzustandsbericht** der Volkswagen-App. Der Knopf wird automatisch zurückgesetzt. Er ist der einzige Bedienpunkt für den Bericht; alle Datenpunkte unter `vehicleReport` sind ausschließlich lesbar. Es gibt keine Wunschwerte und keinen Übernehmen-, Speichern-, Schalt- oder Synchronisationsauftrag für den Bericht. Die Freigabe für Änderungen der Fahrzeugeinstellungen ist nicht nötig; das geprüfte Handy und das kalibrierte App-/Fahrzeugprofil bleiben erforderlich.

Der Bericht wird nur auf Anforderung gelesen. Das bestehende Klima-/Lade-Polling bleibt unverändert; `commands.refresh` liest weiterhin nur den Klimastatus. Ein Berichtauftrag wartet nicht auf das Speichern von Klima-, Temperatur- oder Ladewünschen. Am Handy kann weiterhin nur ein Auftrag gleichzeitig laufen.

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

Der rohe App-Hinweis in `vehicleReport.synchronizationText` ist von der Auslesezeit `vehicleReport.observedAt` zu unterscheiden. Beide lösen keine Synchronisierung aus und belegen nicht unabhängig den Messzeitpunkt am Fahrzeug. Kann der vollständige Bericht nicht sicher gelesen oder validiert werden, werden nur die Berichtswerte geleert und als ungültig markiert; Klima- und Laderückmeldungen bleiben erhalten.

Version 0.5.0 bestand **391 automatisierte Tests auf Linux**. Echte obere und untere Berichtsansichten wurden zusätzlich lokal zu einem vollständigen validierten Modell zusammengeführt. Zwei Liveabfragen auf einem **Galaxy A31 mit Android 12 und deutscher Volkswagen-App 4.8.1** erfassten Kilometerstand, Serviceangabe, Zusammenfassung, Synchronisationshinweis, alle sieben Kategorien, Fußzeile und normalisiertes JSON korrekt; die zweite Abfrage erneuerte `observedAt`. Alle 27 tatsächlichen ioBroker-Berichtsobjekte wurden auf reinen Lesezugriff geprüft, übereinstimmend mit den automatisierten Schematests. Bei beiden Abfragen blieben 23 überwachte Klima-, Lade-, Wunsch- und Synchronisationsanfragewerte exakt unverändert. Es wurde weder eine Fahrzeugaktion noch Speichern oder Synchronisieren ausgelöst; die Klimatisierung blieb ausgeschaltet. Aktive Warnkonstellationen wurden weder erzeugt noch live geprüft.

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
