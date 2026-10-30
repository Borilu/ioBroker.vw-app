# VW App in ioBroker bedienen

Diese Anleitung beschreibt die Bedienung von **vw-app 0.11.3**: Klimatisierung, Ladeeinstellungen und Lademodi, Abfahrtszeiten, Ladeorte, Fahrzeugdaten sowie Verriegeln und Entriegeln. Die Datenpunktreferenz nennt alle vom Adapter angelegten Zustände einschließlich der dynamisch erzeugten Ladeorte und der Aktualitätsanzeigen.

**Stand: 26. Oktober 2026.** Für Installation und WLAN-Kopplung verwende die [bebilderte Installationsanleitung](INSTALLATION.de.md). Die [Einrichtungsreferenz](ADMIN-SETUP.md) erklärt zusätzlich die Adaptereinstellungen.

[Bedienungsanleitung als PDF für 0.10.0](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.10.0/VW-App-Bedienungsanleitung.pdf). Dieses ältere PDF enthält die neuen Lademodi noch nicht. Die Erklärung der Befehlsknöpfe und der Lademodus-Bedienung ist hier online für 0.11.3 aktualisiert.

## 1 Datenpunkte finden und bedienen

Öffne in der ioBroker-Verwaltung **Objekte** und klappe **vw-app.0** auf. Alle hier genannten Pfade liegen unter dieser Instanz. Bei einer anderen Instanznummer ersetzt du die `0`, beispielsweise durch `vw-app.1`.

**Beispiel:** Der in einer Tabelle verkürzt angegebene Pfad `battery.soc` bedeutet vollständig **`vw-app.0.battery.soc`**. Die FIN findest du unter **`vw-app.0.vehicleInfo.vin`**. Manche Objekte erscheinen erst, nachdem der Adapter die betreffende Funktion oder einen Ladeort erkannt hat.

### Drei Arten von Datenpunkten

| Art | Bedeutung | Bedienung |
| --- | --- | --- |
| **Lesen** | Zuletzt aus der Volkswagen-App gelesener Istwert oder eine Adapterrückmeldung. | Nur ablesen. Aktualität und Qualität mitprüfen. |
| **Wunsch** | Im Adapter gespeicherte Auswahl, häufig mit `target` im Namen. | Wert mit `ack=false` schreiben, anschließend den passenden Befehl auslösen. |
| **Befehl** | Ausschließlich schreibbarer Knopf, beispielsweise `commands.start` oder `commands.applyChargingSettings`. | Einmal `true` mit `ack=false` schreiben; Ergebnis in den getrennten Auftrags- und Istwerten prüfen. |

`ack=false` bedeutet in ioBroker **unbestätigte Anforderung**. Beim Bearbeiten eines Werts in Admin darf die Eingabe also nicht bereits als bestätigt markiert sein. In Blockly oder Skripten ebenfalls als Anforderung schreiben. `ack=true` bei einem Wunsch bestätigt nur, dass die Auswahl gespeichert wurde. Erst der Übernehmen-Befehl bedient die App.

Befehlsknöpfe besitzen ab 0.10.1 die ioBroker-Metadaten `common.read=false` und `common.write=true`. Sie sind keine lesbaren Zustandsanzeigen. Der Adapter bestätigt das empfangene Ereignis; ein Knopfwert oder dessen Zurücksetzen zeigt weder eine laufende noch eine abgeschlossene Fahrzeugaktion an. Verwende die getrennten Rückmeldungen `operation.busy`, `operation.lastResult`, `operation.lastErrorCode` sowie die zurückgelesenen Istwerte und ihre Aktualität. Die Metadatenkorrektur aus 0.10.1 erhält bestehende Werte, Bezeichnungen und Berechtigungen; sie sendet keinen Handy- oder Fahrzeugbefehl.

Schreibe Zahlen als Zahlen, zum Beispiel `22.5` und `80`, und Schalter als echte boolesche Werte `true` oder `false`. Der Text `"false"` ist kein ausgeschalteter Schalter. Ein echter Nullwert `null` bedeutet bei Wünschen **diese App-Einstellung beibehalten**. Der Text `"null"` ist dafür ungeeignet. Falls deine Bedienoberfläche keinen Nullwert zulässt, verwende den jeweiligen Löschen-Befehl.

### Ein Auftrag nach dem anderen

1. Schreibe die gewünschten Werte des betreffenden Bereichs.
2. Warte auf deren Bestätigung und prüfe das zugehörige Auswahlfehlerfeld; es muss leer sein.
3. Löse genau den passenden Befehl einmal aus.
4. Warte, bis `operation.busy=false` ist, und prüfe `operation.lastResult` sowie `operation.lastErrorCode`.
5. Vergleiche den zurückgelesenen **Istwert** und die Aktualitätsanzeige des Bereichs.

Eine Änderung während eines laufenden Auftrags gilt erst für einen späteren Auftrag. Der bereits angenommene Auftrag arbeitet mit seiner ursprünglichen Auswahl. Mehrere Bedienbefehle nicht gleichzeitig senden; ein belegtes Handy kann mit `busy` antworten. Die automatische Abfrage verwendet getrennt `refresh.autoBusy` und übergibt an manuelle Aufträge an einer sicheren Stelle.

Wünsche bleiben über Neustarts erhalten. Automatisches Lesen übernimmt sie niemals. Löschen entfernt nur die gespeicherten Wünsche; es macht keine bereits in der App gespeicherte Änderung rückgängig.

Reines Vormerken und lokale Löschen-Befehle können `operation.*` unverändert lassen. Prüfe dabei die bestätigten Wunschwerte und deren Auswahlfehlerfeld; ein älteres `operation.lastResult` gehört möglicherweise zu einem früheren Handyauftrag.

## 2 Häufige Bedienabläufe

### Klimatisierung mit einer bestimmten Temperatur starten

Voraussetzung ist die Freigabe für Klima- und Einstellungsänderungen in den Adaptereinstellungen.

1. Schreibe `climate.targetMode = "climate"`.
2. Schreibe beispielsweise `climate.targetTemperature = 22.5`.
3. Falls gewünscht, wähle die weiteren Klimaoptionen aus Abschnitt 4.3. Bereits gespeicherte Nicht-null-Wünsche werden ebenfalls berücksichtigt.
4. Warte auf bestätigte Wunschwerte und leere Auswahlfehlerfelder.
5. Schreibe `commands.start = true`.
6. Prüfe nach Ende des Auftrags `climate.appState`, `climate.active` und `refresh.climate.status`.

Der Start übernimmt die vorgemerkten Klimaoptionen und im Modus `climate` die vorgemerkte Temperatur. Für einen Start mit unveränderten App-Einstellungen lösche vorher unerwünschte gespeicherte Wünsche über `commands.clearSettings` und `commands.clearTemperature`. Bei `targetMode=null` wird kein anderer Modus gewählt; die geprüfte Klimatisierungsansicht muss passen.

Ein ausdrücklicher Moduswechsel ist nur bei ausgeschalteter Klimatisierung möglich. Der Adapter stoppt einen laufenden Vorgang dafür nicht selbstständig.

Der Start kann verzögert erfolgen. Ein sichtbarer Restzeit-Countdown auf der App-Kachel hilft bei der manuellen Kontrolle. Der Adapter veröffentlicht keinen Restzeit-Datenpunkt, weil dieser Countdown in der geprüften Android-Auslesung nicht zuverlässig verfügbar ist. Bei `outcome_unknown` zuerst App und Fahrzeug prüfen; nicht wiederholt auf Start drücken.

### Temperatur ändern ohne zu starten

1. Schreibe den gewünschten Wert in `climate.targetTemperature`.
2. Warte auf Bestätigung und ein leeres `climate.targetTemperatureError`.
3. Schreibe `commands.setTemperature = true`.
4. Prüfe `climate.temperature` nach erfolgreichem Auftrag.

Unterstützt sind **16,0 bis 29,5 °C in 0,5-°C-Schritten**. `LO` und `HI` werden nicht unterstützt. `commands.applySettings` übernimmt keine Temperatur. `commands.clearTemperature` entfernt ausschließlich den Temperaturwunsch.

### Scheibenheizung starten oder Klima stoppen

Für Scheibenheizung `climate.targetMode = "windowHeating"` vormerken, die Bestätigung abwarten und `commands.start = true` schreiben. Ein Temperaturwunsch bleibt gespeichert und wird bei diesem Start nicht angewendet.

Zum Ausschalten des angezeigten Klimavorgangs einmal `commands.stop = true` schreiben und die Rückmeldung prüfen. Stopp erfordert keine vorherige Änderung der Wünsche.

### Weitere Klimaeinstellungen ändern

1. Schreibe die gewünschten Werte in `climate.targetMode`, `climate.targetClimateOnUnlock`, `climate.targetAutoWindowHeating` und/oder `climate.targetZones`.
2. Warte auf Bestätigung und ein leeres `climate.targetSettingsError`.
3. Schreibe `commands.applySettings = true`.
4. Prüfe die entsprechenden Istwerte `climate.mode`, `climate.climateOnUnlock`, `climate.autoWindowHeating` und `climate.zones`.

Dieser Auftrag startet oder stoppt keine Klimatisierung. Die Zonen bestimmen zusätzliche temperaturbeeinflussende Funktionen vorne links, vorne rechts oder beidseitig. Sie stellen keine unterschiedlichen Solltemperaturen für die Sitzplätze ein.

### Ladegrenze und Ladeoptionen ändern

1. Schreibe zum Beispiel `charging.targetSoc = 80`.
2. Wähle bei Bedarf `charging.targetReducedAcCurrent`, `charging.targetAutoUnlockAc` und `charging.targetOptimizedBatteryUse`.
3. Warte auf bestätigte Wünsche und ein leeres `charging.targetSettingsError`.
4. Schreibe `commands.applyChargingSettings = true`.
5. Warte auf Ende des Auftrags und prüfe die Istwerte unter `charging`.

Der Adapter betätigt den angebotenen **Speichern**-Knopf und öffnet die Einstellungen zur Kontrolle erneut. Die globale Ladegrenze unterstützt **50, 60, 70, 80, 90 und 100 %**. Zwischenwerte werden abgewiesen. Laut App gilt diese globale Grenze nicht an vordefinierten Ladeorten. Die Funktion **Optimierte Batterienutzung** erlaubt der App die Nutzung der Hochvoltbatterie für Fernbedienungsfunktionen; sie ist keine automatische 80-%-Ladebegrenzung.

Diese vier Einstellungswünsche ändern keinen Lademodus. Dafür gibt es den folgenden eigenen Bedienablauf.

Auch während eines laufenden Ladevorgangs werden Batterie, Reichweite und Ladeeinstellungen regelmäßig ausgelesen. Seit 0.11.3 erkennt der Adapter dafür die blaue Reichweiten-Kachel mit dem zusätzlichen Ladehinweis und das geänderte SOC-Textformat in der Lade-Detailansicht. Widersprüchliche Prozentwerte bleiben ungültig. Die Auslesung lässt den Ladevorgang unverändert. Unbekannte oder verdeckte Ansichten werden weiterhin abgewiesen; prüfe die Aktualitätsanzeigen und die Qualität der einzelnen Werte.

### Lademodus auswählen und ausdrücklich übernehmen

0.11.1 erkennt die Modusauswahl auch mit einer zusätzlichen leeren Umhüllung der App-Ansicht. Diese Variante konnte unter 0.11.0 mit `unknown_state` bereits vor dem Modus-Auswahltipp abbrechen. Die Prüfungen aller drei Optionen, der aktuellen Auswahl und möglicher Überlagerungen bleiben bestehen. Das Update übernimmt keinen gespeicherten Moduswunsch automatisch.

| Auswahl für `charging.targetMode` | Bedeutung in der App |
| --- | --- |
| `immediate` | Sofortladen |
| `departure` | Laden zur Abfahrtszeit |
| `departureClimate` | Laden und Klima zur Abfahrtszeit |
| `null` | Keinen neuen Modus vormerken; vorhandenen App-Modus beibehalten |

Die Modus-Auswahlliste enthält die drei benannten Modi. `null` ist ein echter Nullwert zum Löschen des Wunschs, kein vierter Modus und nicht der Text `"null"`. Bietet deine Oberfläche dafür keine Auswahl, verwende `commands.clearChargingMode`.

1. Schreibe den gewünschten Modus in `charging.targetMode`, beispielsweise `"departure"`.
2. Warte auf `ack=true` und ein leeres `charging.targetModeError`. Bis hierher wurde nur der Wunsch gespeichert.
3. Schreibe einmal `commands.applyChargingMode = true` mit `ack=false`.
4. Warte auf das Auftragsende und prüfe `operation.lastResult` und `operation.lastErrorCode`.
5. Prüfe den gewünschten Istwert in `charging.mode`, seine gültige Qualität und die frische erfolgreiche Auslesezeit `charging.modeObservedAt`.

**Die App übernimmt die Auswahl sofort, ohne Speichern-Knopf. Ein Moduswechsel kann dadurch unmittelbar Laden auslösen.** Der Adapter betätigt keinen zusätzlichen Lade-Startknopf. Für einen tatsächlichen Wechsel benötigt er die Freigabe für Klima- und Fahrzeugeinstellungen, keine S-PIN. Ohne diese Freigabe kann der Modusbefehl nur einen bereits erfüllten Wunsch frisch lesend bestätigen; ein abweichender Modus wird vor Auswahlmenü, Schaltreservierung und Modustipp abgelehnt. Vor einem möglicherweise wirksamen Modustipp gilt der gemeinsame Mindestabstand zwischen Schaltversuchen: **60 bis 3600 Sekunden**, Standard **60**. Bei unklarem Ergebnis zuerst die App prüfen und über `commands.refreshCharging` neu lesen; den Befehl nicht automatisch wiederholen.

Auch wenn die App die Modusauswahl vorübergehend deaktiviert, kann der Adapter einen eindeutig sichtbaren Modus lesen. Solange das Bedienelement deaktiviert ist, kann er darüber keinen anderen Modus auswählen. Die Anzeige bleibt eine Beobachtung der App und bestätigt keine neue Fahrzeugübertragung.

Die sichtbare App-Bestätigung kann später eintreffen als die Übernahme der Auswahl. Der Adapter wartet innerhalb der eingestellten Bestätigungszeit und der Gesamtauftragsfrist mit reinen Leseabfragen. Bei Bedarf öffnet er die Reichweitendetails erneut aus der bestätigten Fahrzeugübersicht. Nach einer einzigen nativen Zurück-Aktion im Auswahlmenü wartet er ebenfalls nur lesend. Weder Modusauswahl noch Zurück-Aktion werden zur Bestätigung erneut gesendet. Ein unklarer Ausgang bedeutet deshalb nicht sicher, dass keine Änderung erfolgt ist; zuerst den aktuellen Modus neu lesen.

`commands.clearChargingMode` löscht nur den gespeicherten Moduswunsch, ohne Handyauftrag. `commands.applyChargingSettings` und `commands.clearChargingSettings` betreffen weiterhin nur die vier bisherigen Ladewünsche. Ein Modus-Auswahlfehler muss durch gültige Neuauswahl oder Löschen des Moduswunschs behoben werden. Er blockiert weder normale Leseabfragen noch die vier bisherigen Ladeeinstellungen. Ein laufender Auftrag behält seinen zuvor angenommenen Modus; spätere Änderungen gelten für den nächsten Auftrag. Neustart und automatisches Lesen übernehmen keine gespeicherten Wünsche.

### Daten lesen und ausdrücklich synchronisieren

Für eine sofortige App-Abfrage verwende den passenden Lesebefehl aus Abschnitt 4.2. `commands.refresh` liest ausschließlich Klima; es ist kein vollständiger Rundlauf.

Für eine ausdrückliche Anfrage an Volkswagen schreibe einmal `commands.synchronize = true`. Der Adapter betätigt **Jetzt synchronisieren**, liest anschließend Batterie und Ladeeinstellungen und aktualisiert `battery.lastSyncRequestAt`. Eine erfolgreiche Rückmeldung bedeutet, dass die App die Anfrage angenommen hat. Der Abgleich mit dem Fahrzeug kann mehrere Minuten dauern. Bei Bedarf später erneut `commands.refreshCharging` auslösen. Regelmäßige Abfragen drücken **Jetzt synchronisieren** nicht.

### Eine Klima Abfahrtszeit einstellen

Verwende `departures.climate.timer1` oder `departures.climate.timer2`. Das folgende Beispiel betrifft ausschließlich Timer 1:

1. Lies bei Bedarf mit `commands.refreshDepartureClimate` beide Timer ein.
2. Schreibe `departures.climate.timer1.targetTime = "07:30"`.
3. Schreibe `departures.climate.timer1.targetDays = '["mon","wed","fri"]'`. Der Inhalt ist eine JSON-Array-Zeichenfolge.
4. Schreibe `departures.climate.timer1.targetRepeat = true`.
5. Schreibe `departures.climate.timer1.targetEnabled = true`.
6. Warte auf bestätigte Wünsche und ein leeres `departures.climate.timer1.targetError`.
7. Schreibe `departures.climate.timer1.commands.apply = true`.
8. Prüfe anschließend `enabled`, `time`, `days`, `repeat` und `refresh.departureClimate.status`.

Uhrzeiten sind **`HH:mm` in Fünf-Minuten-Schritten**. Für eine einmalige Abfahrt `targetRepeat=false` und genau einen Wochentag wählen. Das konkrete Kalenderdatum bestimmt die App; der Adapter zeigt es unter `date`. Es gibt keinen schreibbaren Datumsdatenpunkt und keine Umrechnung über die Zeitzone des ioBroker-Hosts.

Nur aktivieren oder deaktivieren: `targetEnabled` setzen, bestätigen lassen und `commands.apply` desselben Timers auslösen. Beachte dabei weitere Nicht-null-Wünsche dieses Timers. Zum ausschließlichen Umschalten bei Bedarf vorher dessen `commands.clear` auslösen.

Die App kann einen Timer beim Speichern zunächst aktivieren. Der Adapter prüft und korrigiert danach den gewünschten Endzustand; bei `targetEnabled=null` behält er die ursprüngliche Aktivierung bei. Zwischenzeitlich kann der Timer eingeschaltet sein. Änderungen daher mit ausreichendem Abstand zur betreffenden Abfahrt vornehmen. Nach Speichern und direkt gespeicherten Schalteränderungen wartet der Adapter jeweils 20 Sekunden vor der Kontrolle. Der gesamte Auftrag kann mehrere Minuten dauern.

### Einen Ladetimer an einem Ladeort einstellen

1. Lege einen neuen Ladeort zuerst im Fahrzeug an. Der Adapter erstellt oder löscht keine Ladeorte.
2. Schreibe `commands.refreshDepartureLocations = true` und warte auf Erfolg.
3. Suche unter `chargingLocations` den passenden Zweig `loc_<24hex>` anhand von `name`, `present=true` und gültiger Zuordnung.
4. Löse in diesem Zweig `commands.refresh` aus und warte auf Erfolg.
5. Verwende dort `timer1`, `timer2` oder `timer3`. Schreibe dessen `targetTime`, `targetDays`, `targetRepeat` und `targetEnabled` wie beim Klimatimer.
6. Löse `commands.apply` genau dieses Timers aus und prüfe die zurückgelesenen Werte.
7. Wähle anschließend `charging.targetMode = "departure"` oder `"departureClimate"`, warte auf die Wunschbestätigung und übernimm den Modus mit `commands.applyChargingMode`.
8. Prüfe den passenden Istwert `charging.mode`, seine gültige Qualität und die frische Zeit `charging.modeObservedAt`.

**Geplantes Laden an einem Ladeort wird nur im Modus `departure` oder `departureClimate` ausgeführt.** Bei `immediate` lassen sich Timer weiterhin bearbeiten; der Adapter stellt den Modus beim Timer-Übernehmen niemals automatisch um. `enabled=true` allein bedeutet deshalb nicht, dass geplantes Laden tatsächlich ausgeführt wird.

**Beispielpfad:** `vw-app.0.chargingLocations.loc_<24hex>.timer1.targetTime`. Ersetze `loc_<24hex>` durch den tatsächlich angelegten Schlüssel. Er ist kein frei wählbarer Name und enthält 24 hexadezimale Zeichen hinter `loc_`. Insgesamt werden bis zu fünf vorhandene Ladeorte unterstützt.

### Ladeort Einstellungen und bevorzugte Zeiten

Für Name, reduzierten AC-Ladestrom oder automatisches Entriegeln schreibe die Wünsche im jeweiligen Ortszweig unter `settings`. Danach `settings.commands.apply` auslösen und die Istwerte kontrollieren. Die gewünschten Werte gelten nur für diesen Ort.

Für bevorzugte Zeiten gibt es je Ort vier Fenster. Schreibe beispielsweise `preferredTimes.window1.targetEnabled = true`; danach den **gemeinsamen** Befehl `preferredTimes.commands.apply` auslösen. Dieser übernimmt alle dort gespeicherten Nicht-null-Wünsche. Beginn und Ende der Zeitfenster werden nur gelesen und müssen laut App im Fahrzeug eingerichtet werden.

Die grafischen Orts-Ladegrenzen **Direkt laden bis** und **Laden bis** sind in der geprüften App nicht als Zahlen auslesbar. `settings.directSoc` und `settings.socLimit` bleiben deshalb `null` mit ungültiger Qualität. Dafür gibt es keine schreibbaren Wunschwerte.

Nach Umbenennen, Entfernen oder Wiedererscheinen eines Ladeorts sind frühere Wünsche weiterhin gespeichert, aber ihre alte Zuordnung ist gesperrt. Lies die Ladeortliste erneut. Wähle alle benötigten Nicht-null-Wünsche in den betroffenen Gruppen ausdrücklich neu oder lösche sie über deren `commands.clear`. Das gilt nach einer Umbenennung durch den Adapter auch für den eben verwendeten Namenswunsch. Ein anderer Anzeigename darf alte Wünsche nicht stillschweigend freigeben.

### Fahrzeug verriegeln oder entriegeln

Beide Funktionen müssen zunächst manuell in der Volkswagen-App funktionieren. Hinterlege die vierstellige **S-PIN ausschließlich im maskierten Feld der Adaptereinstellungen**, aktiviere dort **Fahrzeug verriegeln und entriegeln erlauben** und speichere. Die separate Freigabe für Klima- und Einstellungsänderungen ersetzt diese Freigabe nicht.

1. Prüfe den aktuellen Zustand unter `vehicleAccess.locked` und dessen Aktualität.
2. Schreibe genau einmal `commands.lockVehicle = true` oder `commands.unlockVehicle = true`.
3. Warte auf das Auftragsende und prüfe `vehicleAccess.locked`, `refresh.vehicleAccess.status` sowie die Auftragsrückmeldung.
4. Bei unklarem Ergebnis kontrolliere die App und das Fahrzeug. Wiederhole keine PIN-Eingabe auf Verdacht.

Ist der gewünschte Zustand bereits frisch erkennbar, erfolgt keine PIN-Eingabe. Andernfalls gibt der Adapter die PIN genau einmal ein. Die geprüfte App sendet nach der vierten Ziffer automatisch; das gilt für beide Richtungen. Eine noch offene Tastatur wird nach angenommener Eingabe einmal ausgeblendet.

Eine unklare oder abgelehnte Authentifizierung sperrt weitere PIN-Versuche auch über Neustarts. `security.blocked=true` bezeichnet diese **lokale Auftragssperre**, nicht die Fahrzeugverriegelung. Prüfe App, Fahrzeugzustand und hinterlegte PIN. Erst danach verwende bei Bedarf in den Adaptereinstellungen **Nach korrigierter S-PIN die Sicherheitssperre zurücksetzen**. Dieser Knopf entriegelt oder verriegelt nichts und hebt keine Sperrfrist von Volkswagen auf.

Das Auto kann sich nach einer Entriegelung selbst wieder verriegeln. Regelmäßiges Lesen erfasst diese Änderung; der Adapter entriegelt nicht automatisch nach.

## 3 Aktuelle und gültige Werte verwenden

Der Adapter liest die App nacheinander aus. So werden auch Änderungen erfasst, die du direkt am Handy vorgenommen hast. Eine Instanz bedient ein bestimmtes Handy und das bestätigte Fahrzeugprofil. Während einer Abfrage sollte das Handy entsperrt und die App bedienbar sein. Offene manuelle Einstellungsentwürfe zuerst am Handy speichern oder verwerfen und den Editor verlassen.

In **Instanzen → vw-app.0 → Einstellungen** lassen sich diese Werte anpassen. Es sind Einstellungen, keine schreibbaren Betriebsdatenpunkte:

| Einstellung | Werte und Wirkung |
| --- | --- |
| Automatische App-Abfragen: Mindestabstand je Bereich (`pollIntervalSeconds`) | `0` aus; sonst ganze Sekunden von `15` bis `86400`. Neue Instanzen verwenden `15`. Die Wartezeit beginnt nach Abschluss einer Abfrage desselben Bereichs. |
| App-Auslesung als veraltet markieren nach (`refreshMaxAgeSeconds`) | `0` automatische Altersgrenze; sonst `30` bis `86400` ganze Sekunden. Ändert die Gültigkeitsbewertung, nicht die Abfragehäufigkeit. |
| Zeitlimit je Auftrag (`commandTimeoutSeconds`) | `30` bis `360` Sekunden; Standard `300`. Umfasst Verbindung, Einstellungen und Rückmeldung zusammen. |
| Wartezeit auf Bestätigung in der App (`outcomeTimeoutSeconds`) | `30` bis `150` Sekunden; Standard `120`. Das verbleibende Gesamtzeitlimit kann die Wartezeit verkürzen. |
| Mindestabstand zwischen Schaltversuchen (`cooldownSeconds`) | `60` bis `3600` Sekunden; Standard `60`. Ein Wartehinweis ist kein Anlass für automatische Wiederholungen. |

**15 Sekunden sind kein vollständiger Rundlauf.** Es werden Klima, Batterie/Laden, Fahrzeugbericht, Türen/Fenster/Verriegelung, FIN, Klima-Abfahrtszeiten und Ladeortliste gelesen. Für jeden erkannten Ladeort kommt eine vollständige Ortsabfrage hinzu. Navigation und Prüfungen brauchen Zeit; zwischen automatischen Aufträgen liegt eine Pause von mindestens 5 Sekunden oder 25 % der vorigen Auftragsdauer, je nachdem, welcher Wert größer ist. Fehler verlängern die Wartezeit bis fünf Minuten; ein längerer konfigurierter Mindestabstand bleibt wirksam. Manuelle Aufträge haben Vorrang.

### Aktualitätsanzeigen richtig verstehen

| Status unter `refresh.<Bereich>.status` | Bedeutung |
| --- | --- |
| `fresh` | Die App wurde kürzlich erfolgreich gelesen. Einzelne nicht verfügbare Felder können trotzdem ungültig sein. |
| `stale` | Die letzte erfolgreiche App-Auslesung ist zu alt oder die Zuordnung muss neu bestätigt werden. |
| `error` | Die letzte Abfrage dieses Bereichs ist fehlgeschlagen. |
| `unknown` | Es liegt noch keine erfolgreiche Beobachtung vor. |

Bei Fehlern oder abgelaufener Gültigkeit können letzte bekannte Werte als Historie stehen bleiben. Der letzte erfolgreiche Auslesezeitpunkt wird dabei nicht vorgetäuscht fortgeschrieben. Ein sichtbarer Zahlen- oder Schalterwert allein ist daher kein Beleg für aktuelle Daten.

Für Automatisierungen müssen **Bereichsstatus `fresh`, gültige Datenpunktqualität und ein passender Wert** zusammenpassen. ioBroker kennzeichnet ungültige Qualität hier mit `q=0x82` (dezimal 130); regulär gültig ist `q=0`. `null` bedeutet bei Istwerten unbekannt oder nicht verfügbar, nicht ausgeschaltet. Eine dokumentierte Ausnahme ist das absichtlich fehlende Einmaldatum eines wiederkehrenden Timers. `ack=true` allein sagt nichts über die Aktualität aus.

Die automatische Altersgrenze ist mindestens 90 Sekunden. Genauer verwendet sie das Doppelte des größeren Werts aus Mindestabstand und geschätzter vollständiger Rundlaufzeit, falls dies über 90 Sekunden liegt. Mit zusätzlichen Ladeorten kann sie daher größer werden. Unter `refresh.<Bereich>.maxAgeSeconds` siehst du den tatsächlich verwendeten Wert.

**Eine frische App-Auslesung bestätigt keine neue Messung am Fahrzeug.** `observedAt` und `lastReadAt` sind Auslesezeiten des Adapters. Die App kann weiterhin zwischengespeicherte Fahrzeugdaten zeigen. `synchronizationText` enthält ihren eigenen Hinweis. Auch `climate.vehicleConfirmed` bleibt deshalb immer `false`.

## 4 Vollständige Datenpunktreferenz

Alle Pfade in diesem Kapitel beginnen mit **`vw-app.0.`**. Untergliederungen wie `commands`, `climate` oder `chargingLocations` sind Ordner beziehungsweise Kanäle und enthalten selbst keinen Wert. **Lesen**, **Wunsch** und **Befehl** haben die Bedeutung aus Abschnitt 1.

### 4.1 Verbindung und Auftragsrückmeldung

| Pfad ab `vw-app.0.` | Art | Inhalt oder Funktion |
| --- | --- | --- |
| `info.connection` | Lesen | Boolean: Verbindung bei der letzten Prüfung erfolgreich; keine dauerhafte Erreichbarkeitsgarantie. |
| `info.runtimeReady` | Lesen | Boolean: private Android-/ADB-Laufzeit des Adapters gestartet. Bestätigt noch keine Handy- oder App-Verbindung. |
| `info.appVersion` | Lesen | Erkannte Version der Volkswagen-App. |
| `info.status` | Lesen | Einrichtungs-/Betriebsstatus, laufender Auftragsname oder fester Fehlercode. |
| `operation.busy` | Lesen | `true`, solange ein manueller Handy- oder Einrichtungsauftrag läuft. |
| `operation.lastResult` | Lesen | `running`, `succeeded`, `failed`; anfangs leer. Bezieht sich auf den letzten manuellen Auftrag. |
| `operation.lastError` | Lesen | Bereinigter Meldungstext zum letzten manuellen Fehler; leer ohne Fehler. |
| `operation.lastErrorCode` | Lesen | Fester Fehlercode zum letzten manuellen Auftrag; leer ohne Fehler. |
| `operation.lastUpdated` | Lesen | Zeitpunkt der letzten erfolgreichen Klima-Beobachtung als ISO-Zeit. Kein allgemeiner Zeitstempel für alle Bereiche. |
| `security.blocked` | Lesen | Boolean: Weitere S-PIN-Übermittlungen sind durch die lokale Sicherheitssperre blockiert. |
| `security.reason` | Lesen | Fester Grund dieser Sperre; leer bei aufgehobener Sperre. |

Automatische Abfragen überschreiben die manuelle Auftragsrückmeldung nicht. Ihre Fehler stehen im jeweils passenden `refresh`-Bereich. `succeeded` bestätigt den vorgesehenen App-Ablauf beziehungsweise dessen Rücklesung; es ist keine unabhängige physische Fahrzeugbestätigung.

Ob die Instanz selbst läuft, kannst du außerdem am ioBroker-Systemzustand `system.adapter.vw-app.0.alive` erkennen. Dieser liegt außerhalb von `vw-app.0` und wird vom ioBroker-Controller verwaltet. Einrichtungsknöpfe für Kopplung, Werkzeuge, Wachhalten und Rücksetzen der Sicherheitssperre befinden sich in den Adaptereinstellungen; dafür gibt es keine zusätzlichen Betriebsdatenpunkte.

### 4.2 Zentrale Befehle

Alle folgenden Datenpunkte sind boolesche **Befehle**. Schreibe einmal `true` mit `ack=false`. Eine nötige Freigabe wird in den Adaptereinstellungen gesetzt.

| Pfad ab `vw-app.0.` | Funktion |
| --- | --- |
| `commands.start` | Klimatisierung oder ausdrücklich gewählte Scheibenheizung starten; zuvor gespeicherte Klima-Wünsche berücksichtigen. Schaltfreigabe nötig. |
| `commands.stop` | Angezeigten Klimavorgang stoppen. Schaltfreigabe nötig. |
| `commands.refresh` | Nur Klimastatus und Klimaeinstellungen lesen. |
| `commands.setTemperature` | Gespeicherten Temperaturwunsch einstellen, ohne Start/Stopp. Schaltfreigabe nötig. |
| `commands.clearTemperature` | Temperaturwunsch auf `null` setzen; kein Handyzugriff. |
| `commands.applySettings` | Vier Klimaoptionswünsche übernehmen; keine Temperatur, kein Start/Stopp. Schaltfreigabe nötig. |
| `commands.clearSettings` | Nur die vier Klimaoptionswünsche löschen; Temperaturwunsch bleibt. |
| `commands.refreshCharging` | SOC, Reichweite und globale Ladeeinstellungen aus der App lesen. |
| `commands.synchronize` | Einmal **Jetzt synchronisieren** in der App anfordern, anschließend Ladebereich lesen. Keine Schaltfreigabe nötig. |
| `commands.applyChargingSettings` | Die vier globalen Ladewünsche speichern und zurücklesen. Schaltfreigabe nötig. |
| `commands.clearChargingSettings` | Nur die vier globalen Ladewünsche löschen; kein Handyzugriff. |
| `commands.applyChargingMode` | Nur den gespeicherten Lademodus übernehmen; kann unmittelbar Laden auslösen. Tatsächlicher Wechsel braucht Schaltfreigabe und gemeinsamen Schaltabstand, keine S-PIN. |
| `commands.clearChargingMode` | Nur den Moduswunsch auf `null` setzen; kein Handyzugriff. |
| `commands.refreshVehicleReport` | Gesamten Fahrzeugzustandsbericht lesen. |
| `commands.refreshVehicleAccess` | Türen, Fenster, Kofferraum und Verriegelung lesen. |
| `commands.refreshVehicleInfo` | FIN des bestätigten Fahrzeugs lesen; keine Fahrzeugauswahl ändern. |
| `commands.refreshDepartureClimate` | Beide Klima-Abfahrtszeiten lesen. |
| `commands.refreshDepartureLocations` | Bis zu fünf vorhandene Ladeorte und ihre Zuordnungen neu erkennen. Liest nicht gleichzeitig alle Ortsdetails. |
| `commands.lockVehicle` | Einmal verriegeln; separate Verriegelungsfreigabe und S-PIN nötig. |
| `commands.unlockVehicle` | Einmal entriegeln; separate Verriegelungsfreigabe und S-PIN nötig. |

### 4.3 Klima

| Pfad ab `vw-app.0.` | Art | Inhalt oder erlaubte Auswahl |
| --- | --- | --- |
| `climate.appState` | Lesen | `on`, `off`, `unknown`: in der App beobachteter Klimabetrieb. |
| `climate.active` | Lesen | `true` aktiv, `false` aus; bei fehlender gültiger Beobachtung Qualität beachten. |
| `climate.temperature` | Lesen | In der App eingestellte Temperatur in °C; keine gemessene Innenraumtemperatur. |
| `climate.targetTemperature` | Wunsch | Zahl 16,0 bis 29,5 °C in 0,5-Schritten oder `null`. Übernehmen mit `commands.setTemperature` oder beim Klimastart. |
| `climate.targetTemperatureError` | Lesen | Auswahl-/Speicherfehler zum Temperaturwunsch; leer bei gültiger Auswahl. |
| `climate.mode` | Lesen | `climate` oder `windowHeating`, soweit eindeutig ausgelesen; sonst `null`. Beschreibt die App-Ansicht. |
| `climate.targetMode` | Wunsch | `climate` = Klimatisierung; `windowHeating` = Scheibenheizung; `null` = beibehalten. |
| `climate.climateOnUnlock` | Lesen | Standklimatisierung beim Entriegeln aktiviert: Boolean oder `null`. |
| `climate.targetClimateOnUnlock` | Wunsch | `true` an, `false` aus, `null` beibehalten. |
| `climate.autoWindowHeating` | Lesen | Automatische Scheibenheizung: Boolean oder `null`. |
| `climate.targetAutoWindowHeating` | Wunsch | `true` an, `false` aus, `null` beibehalten. |
| `climate.zones` | Lesen | `frontLeft`, `frontRight`, `both`, `none` oder unbekannt `null`. |
| `climate.targetZones` | Wunsch | `frontLeft` vorne links, `frontRight` vorne rechts, `both` beide oder `null` beibehalten. `none` ist kein erlaubter Wunsch. |
| `climate.targetSettingsError` | Lesen | Auswahl-/Speicherfehler der vier Klimaoptionen mit betroffenem Feld. |
| `climate.confirmationSource` | Lesen | `none`, `app_controls` = Klimabedienansicht, `app_overview` = erkannte Beschreibung der Fahrzeugkachel. |
| `climate.vehicleConfirmed` | Lesen | Immer `false`; keine unabhängige Fahrzeugtelemetrie. |

Die vier Optionswünsche werden mit `commands.applySettings` oder beim Start übernommen. `commands.clearSettings` löscht sie gemeinsam. Temperatur und Optionen besitzen getrennte Wünsche und Fehleranzeigen.

### 4.4 Batterie und globale Ladeeinstellungen

| Pfad ab `vw-app.0.` | Art | Inhalt oder erlaubte Auswahl |
| --- | --- | --- |
| `battery.soc` | Lesen | Aktueller Ladezustand laut App in Prozent, Zahl 0 bis 100 oder unbekannt `null`. |
| `battery.rangeKm` | Lesen | Restreichweite laut App in km oder unbekannt `null`. |
| `battery.observedAt` | Lesen | Erfolgreiche Auslesezeit des Batterie-/Ladebereichs als ISO-Zeit. |
| `battery.lastSyncRequestAt` | Lesen | Zeitpunkt der letzten an die App gesendeten Synchronisationsanfrage; keine Bestätigung eines abgeschlossenen Abgleichs. |
| `charging.socLimit` | Lesen | Globale Einstellung **Laden bis** in Prozent oder unbekannt `null`. |
| `charging.targetSoc` | Wunsch | `50`, `60`, `70`, `80`, `90`, `100` oder `null`. |
| `charging.reducedAcCurrent` | Lesen | Reduzierter AC-Ladestrom: Boolean oder `null`. |
| `charging.targetReducedAcCurrent` | Wunsch | `true` an, `false` aus, `null` beibehalten. |
| `charging.autoUnlockAc` | Lesen | AC-Stecker automatisch entriegeln: Boolean oder `null`. |
| `charging.targetAutoUnlockAc` | Wunsch | `true` an, `false` aus, `null` beibehalten. |
| `charging.optimizedBatteryUse` | Lesen | Optimierte Batterienutzung: Boolean oder `null`. |
| `charging.targetOptimizedBatteryUse` | Wunsch | `true` an, `false` aus, `null` beibehalten. |
| `charging.targetSettingsError` | Lesen | Auswahl-/Speicherfehler der globalen Ladewünsche mit betroffenem Feld. |
| `charging.mode` | Lesen | `immediate`, `departure` oder `departureClimate` laut App; anfangs unbekannt `null`. Bei historischen Werten Qualität prüfen. |
| `charging.modeObservedAt` | Lesen | ISO-UTC-Zeit der letzten erfolgreichen Modus-Auslesung oder leer; keine Fahrzeugmesszeit. |
| `charging.targetMode` | Wunsch | `immediate`, `departure`, `departureClimate` oder `null`; unabhängig von den vier globalen Ladewünschen. |
| `charging.targetModeError` | Lesen | Fester Auswahl-/Speicherfehler des Moduswunschs; leer nach gültiger gespeicherter Auswahl oder Löschen. |

Übernehmen: `commands.applyChargingSettings`. Wünsche löschen: `commands.clearChargingSettings`. Auslesen: `commands.refreshCharging`. Die Aktualität aller Batterie- und globalen Ladewerte steht unter `refresh.charging`.

Für den Modus gelten die eigenen Befehle `commands.applyChargingMode` und `commands.clearChargingMode`. Er wird mit derselben regelmäßigen Ladeabfrage erneuert, besitzt aber seine tatsächliche erfolgreiche Snapshotzeit `charging.modeObservedAt`. Ist nur der Modus unlesbar oder fehlt dessen gültiger Zeitstempel, bleiben der letzte Modus und seine Zeit historisch erhalten; `charging.mode` bekommt ungültige Qualität (`q=0x82`). Batterie und `refresh.charging.status` können gleichzeitig frisch sein. Auch ein nach seiner eigenen Zeit zu alter Modus wird ungültig. Fehler, Zeitablauf und Neustart schreiben die letzte erfolgreiche Moduszeit nicht fort.

### 4.5 Türen Fenster Kofferraum und Verriegelung

Alle folgenden Datenpunkte sind **nur lesbar**. Bei Öffnungen bedeutet `true` offen und `false` geschlossen. `null` bedeutet unbekannt. Links und rechts gelten in Fahrtrichtung.

| Pfad ab `vw-app.0.` | Bedeutung |
| --- | --- |
| `vehicleAccess.doors.frontLeftOpen` | Tür vorne links, Fahrertür beim Referenzfahrzeug. |
| `vehicleAccess.doors.frontRightOpen` | Tür vorne rechts. |
| `vehicleAccess.doors.rearLeftOpen` | Tür hinten links. |
| `vehicleAccess.doors.rearRightOpen` | Tür hinten rechts. |
| `vehicleAccess.windows.frontLeftOpen` | Fenster vorne links. |
| `vehicleAccess.windows.frontRightOpen` | Fenster vorne rechts. |
| `vehicleAccess.windows.rearLeftOpen` | Fenster hinten links. |
| `vehicleAccess.windows.rearRightOpen` | Fenster hinten rechts. |
| `vehicleAccess.trunkOpen` | Kofferraum offen/geschlossen. |
| `vehicleAccess.locked` | `true` verriegelt, `false` entriegelt, `null` unbekannt. |
| `vehicleAccess.warningText` | Auslesbarer Warnhinweis zu offenen/eingeschalteten Komponenten, gegebenenfalls leer. |
| `vehicleAccess.synchronizationText` | Synchronisationshinweis der App auf der Startseite. |
| `vehicleAccess.observedAt` | Zeitpunkt der erfolgreichen App-Auslesung. |

Geschlossene Türen und Fenster bedeuten nicht automatisch verriegelt. Die Auslesung unter `commands.refreshVehicleAccess` öffnet oder schließt nichts. Die Aktualität steht unter `refresh.vehicleAccess`.

### 4.6 FIN

| Pfad ab `vw-app.0.` | Art | Inhalt |
| --- | --- | --- |
| `vehicleInfo.vin` | Lesen | 17-stellige Fahrzeug-Identifizierungsnummer aus der Fahrzeugverwaltung der App. |
| `vehicleInfo.observedAt` | Lesen | Zeitpunkt der erfolgreichen FIN-Auslesung. |

Auslesen: `commands.refreshVehicleInfo`. Regelmäßige Abfragen lesen die FIN ebenfalls. Der Adapter öffnet die Fahrzeugverwaltung, prüft die eindeutig aktive Fahrzeugkarte und kehrt zurück. Er wählt kein anderes Fahrzeug. Bei Fehlern bleibt eine vorhandene FIN als ungültige historische Beobachtung erhalten. Aktualität: `refresh.vehicleInfo`.

### 4.7 Fahrzeugzustandsbericht

Alle Berichtdaten sind **nur lesbar**. Auslösen mit `commands.refreshVehicleReport`; Aktualität unter `refresh.vehicleReport`.

| Pfad ab `vw-app.0.` | Inhalt |
| --- | --- |
| `vehicleReport.odometerText` | Kilometerstand als App-Text. |
| `vehicleReport.odometerKm` | Eindeutig abgeleiteter Kilometerstand in km, sonst `null`. |
| `vehicleReport.nextServiceText` | Nächster Service als App-Text. |
| `vehicleReport.nextServiceDays` | Eindeutig abgeleitete Servicefrist in Tagen, sonst `null`. |
| `vehicleReport.nextServiceKm` | Eindeutig abgeleitete verbleibende Strecke bis Service in km, sonst `null`. |
| `vehicleReport.summary` | Zusammenfassung des Berichts. |
| `vehicleReport.hasMessages` | Aus erkannter Zusammenfassung abgeleitet: Meldungen vorhanden; Boolean oder `null`. |
| `vehicleReport.messageCount` | Eindeutig erkannte Anzahl der Meldungen, sonst `null`. |
| `vehicleReport.synchronizationText` | Synchronisationshinweis im Bericht. |
| `vehicleReport.notice` | Allgemeiner Hinweistext des Berichts. |
| `vehicleReport.additionalTexts` | Weitere Berichttexte als JSON-Array-Zeichenfolge. |
| `vehicleReport.json` | Vollständiger normalisierter Bericht als JSON-Zeichenfolge. |
| `vehicleReport.observedAt` | Zeitpunkt der erfolgreichen vollständigen Berichtsauslesung. |

Jede der folgenden Kategorien besitzt genau zwei Datenpunkte:

| Statuspfad ab `vw-app.0.` | Textpfad ab `vw-app.0.` | Kategorie |
| --- | --- | --- |
| `vehicleReport.engine.status` | `vehicleReport.engine.texts` | Antrieb |
| `vehicleReport.assistance.status` | `vehicleReport.assistance.texts` | Assistenten |
| `vehicleReport.brakes.status` | `vehicleReport.brakes.texts` | Bremsen |
| `vehicleReport.lighting.status` | `vehicleReport.lighting.texts` | Fahrlicht |
| `vehicleReport.comfort.status` | `vehicleReport.comfort.texts` | Komfort |
| `vehicleReport.tires.status` | `vehicleReport.tires.texts` | Reifen |
| `vehicleReport.other.status` | `vehicleReport.other.texts` | Sonstige |

`status` enthält `no_messages` oder `unknown`; `texts` enthält die zugehörigen gelesenen App-Texte als JSON-Array-Zeichenfolge. `no_messages` bedeutet, dass die App dort keine Meldungen anzeigt. Unbekannte Texte werden erhalten; der Adapter erfindet aus namenlosen Symbolen keine Warnstufe. Der Bericht ersetzt keine Fahrzeugdiagnose.

### 4.8 Klima Abfahrtszeiten

`departures.climate.observedAt` ist die letzte erfolgreiche Auslesezeit beider Klimatimer. Ihre gemeinsamen Aktualitätsdaten liegen unter `refresh.departureClimate`.

Die folgende Tabelle gilt unter beiden vollständigen Basispfaden:

- **`vw-app.0.departures.climate.timer1`**
- **`vw-app.0.departures.climate.timer2`**

Hänge das jeweilige Feld mit einem Punkt an, zum Beispiel `vw-app.0.departures.climate.timer1.targetTime`.

| Feld unter dem Timer | Art | Inhalt oder erlaubte Auswahl |
| --- | --- | --- |
| `enabled` | Lesen | Timer aktiviert: Boolean. |
| `time` | Lesen | Uhrzeit als Text `HH:mm`. |
| `days` | Lesen | Wochentage als JSON-Array-Zeichenfolge mit `mon`, `tue`, `wed`, `thu`, `fri`, `sat`, `sun`. |
| `repeat` | Lesen | `true` wiederkehrend, `false` einmalig. |
| `date` | Lesen | Lokales Kalenderdatum des Einmaltimers `YYYY-MM-DD`; bei wiederkehrendem Timer `null`. |
| `vehicleOffset` | Lesen | Von der App gelieferter Zeitversatz; siehe Zeitmetadaten unten. |
| `isLocalVehicleTime` | Lesen | Boolean: App kennzeichnet die Zeit als lokale Fahrzeugzeit. |
| `source` | Lesen | Kennung der Beobachtungsquelle. |
| `daysSummary` | Lesen | Roher Wochentagshinweis aus der Timerübersicht. |
| `daysSummaryRecognized` | Lesen | Boolean: Dieser Hinweis wurde eindeutig erkannt. |
| `targetEnabled` | Wunsch | Boolean oder `null`. |
| `targetTime` | Wunsch | Text `HH:mm`, Fünf-Minuten-Schritte, oder `null`. |
| `targetDays` | Wunsch | Nicht leere JSON-Array-Zeichenfolge mit 1 bis 7 verschiedenen Tageskennungen oder echter Nullwert. |
| `targetRepeat` | Wunsch | Boolean oder `null`. Einmaltimer benötigen genau einen Tag. |
| `targetError` | Lesen | Auswahl-/Speicher-/Zuordnungsfehler dieser Timergruppe, sonst leer. |
| `commands.apply` | Befehl | Die Nicht-null-Wünsche nur dieses Timers speichern und zurücklesen. |
| `commands.clear` | Befehl | Die vier Wünsche nur dieses Timers löschen; App-Timer bleibt bestehen. |

### 4.9 Ladeortliste und Ortsdaten

Die folgenden drei nur lesbaren Datenpunkte beschreiben die gesamte Liste. Ihr Aktualitätsbereich heißt `refresh.departureLocations`.

| Pfad ab `vw-app.0.` | Inhalt |
| --- | --- |
| `chargingLocations.count` | Anzahl der aktuell erkannten Ladeorte, 0 bis 5; vor der ersten Beobachtung `null`. Historische Ortszweige zählen nicht mit. |
| `chargingLocations.json` | Liste als JSON-Zeichenfolge. Jeder Eintrag enthält `localKey`, `name` und `activeCount` (0 bis 3 aktive Timer). |
| `chargingLocations.observedAt` | Zeitpunkt der letzten erfolgreichen Bestandsaufnahme der Ladeortliste. |

Jeder erkannte Ladeort erhält einen stabilen Zweig **`vw-app.0.chargingLocations.loc_<24hex>`**. Die nachfolgenden Tabellen gelten für jeden dieser bis zu fünf Zweige. Der Schlüssel folgt der internen Ortskennung innerhalb des bestätigten Fahrzeugprofils, nicht der Listenposition. Verwende den sichtbaren `name`, um den richtigen Zweig zu finden.

| Feld unter dem Ortszweig | Art | Inhalt oder Funktion |
| --- | --- | --- |
| `name` | Lesen | Anzeigename des Ladeorts. |
| `present` | Lesen | Boolean: Ort ist in der zuletzt gelesenen Liste vorhanden. |
| `activeTimerCount` | Lesen | In der Liste erkannte Anzahl aktiver Timer. |
| `bindingStatus` | Lesen | `unknown` unbekannt, `bound` zugeordnet, `removed` entfernt. Ein alter Wert allein bestätigt nach Neustart keine frische Zuordnung. |
| `observedAt` | Lesen | Zeitpunkt der letzten erfolgreichen vollständigen Ortsabfrage. |
| `commands.refresh` | Befehl | Drei Timer, Einstellungen und vier bevorzugte Zeitfenster dieses Ortes lesen. |

Die vollständige Ortsabfrage besitzt einen eigenen Aktualitätsbereich **`vw-app.0.refresh.departureLocation_loc_<24hex>`**. Historische Ortszweige können nach dem Entfernen erhalten bleiben. Vor Schreibaufträgen muss der Ort vorhanden und seine Zuordnung frisch bestätigt sein.

Die Ortsfelder `name`, `present` und `activeTimerCount` werden mit der **Ladeortliste** aktualisiert. Timer, Einstellungen und bevorzugte Zeiten gehören zur **Detailabfrage dieses Ortes**. Sie können deshalb vorübergehend unterschiedliche Auslesezeitpunkte haben.

### 4.10 Drei Ladetimer je Ladeort

Unter jedem Ortszweig existieren **`timer1`**, **`timer2`** und **`timer3`**, beispielsweise **`vw-app.0.chargingLocations.loc_<24hex>.timer1`**. Jeder besitzt sämtliche 17 Felder aus der Klimatimer-Tabelle in Abschnitt 4.8. Die Bedienfolge ist identisch; der Befehl liegt immer am jeweiligen Timer.

Zusätzlich hat jeder Ladetimer diese **nur lesbaren** Felder:

| Feld unter dem Ladetimer | Inhalt |
| --- | --- |
| `climatisation` | Boolesche zusätzliche Klimatisierungsangabe des Ladetimers. |
| `profileId` | Profilkennung der App als Dezimalzeichenfolge; nicht verändern. |
| `isPreferredTimesAvailable` | Boolean: Die App meldet bevorzugte Zeiten für diesen Timer als verfügbar. |

Diese Zusatzfelder lassen sich nicht über die vier Timerwünsche verändern. Für geplantes Laden muss zusätzlich `charging.mode` gültig als `departure` oder `departureClimate` beobachtet sein. Timeraktivierung allein bestätigt keinen späteren Ladeablauf und ist kein sofortiger Lade- oder Klimastart; sie ändert den Lademodus nicht.

### 4.11 Einstellungen je Ladeort

Vollständiger Basispfad: **`vw-app.0.chargingLocations.loc_<24hex>.settings`**.

| Feld unter `settings` | Art | Inhalt oder erlaubte Auswahl |
| --- | --- | --- |
| `name` | Lesen | Name in den Ortseinstellungen. |
| `reducedAcCurrent` | Lesen | Reduzierter AC-Ladestrom an diesem Ort: Boolean. |
| `autoUnlockAc` | Lesen | AC-Stecker automatisch entriegeln an diesem Ort: Boolean. |
| `directSoc` | Lesen | Ortsgrenze **Direkt laden bis**; derzeit `null` mit ungültiger Qualität. |
| `socLimit` | Lesen | Ortsgrenze **Laden bis**; derzeit `null` mit ungültiger Qualität. |
| `socReadCapability` | Lesen | Derzeit `not_exposed_by_app`: Zahlenwerte der Ortsgrenzen werden von der App nicht auslesbar bereitgestellt. |
| `targetName` | Wunsch | Neuer eindeutiger Name, 1 bis 128 Zeichen ohne äußere Leerzeichen/Steuerzeichen, oder `null`. Keine reservierten Menütitel wie Abfahrtszeiten, Zeit einstellen, Ladeeinstellungen oder Bevorzugte Zeiten. |
| `targetReducedAcCurrent` | Wunsch | Boolean oder `null`. |
| `targetAutoUnlockAc` | Wunsch | Boolean oder `null`. |
| `targetError` | Lesen | Auswahl-/Speicher-/Zuordnungsfehler dieser Gruppe, sonst leer. |
| `commands.apply` | Befehl | Die drei Nicht-null-Wünsche dieser Einstellungen übernehmen. |
| `commands.clear` | Befehl | Nur diese drei Wünsche löschen. |

### 4.12 Bevorzugte Zeitfenster je Ladeort

Vollständiger Basispfad: **`vw-app.0.chargingLocations.loc_<24hex>.preferredTimes`**.

| Feld unter `preferredTimes` | Art | Inhalt oder Funktion |
| --- | --- | --- |
| `notice` | Lesen | App-Hinweis zur Einrichtung der genauen Zeitfenster im Fahrzeug. |
| `targetError` | Lesen | Auswahl-/Speicher-/Zuordnungsfehler der gemeinsamen Gruppe, sonst leer. |
| `commands.apply` | Befehl | Die vier Nicht-null-Schalterwünsche gemeinsam übernehmen. |
| `commands.clear` | Befehl | Alle vier Schalterwünsche dieser Gruppe löschen. |

Darunter existieren **`window1`**, **`window2`**, **`window3`** und **`window4`**. Jedes Fenster hat diese Felder, beispielsweise `vw-app.0.chargingLocations.loc_<24hex>.preferredTimes.window1.start`:

| Feld unter jedem Fenster | Art | Inhalt |
| --- | --- | --- |
| `start` | Lesen | Beginn des Zeitfensters als App-Uhrzeit. |
| `end` | Lesen | Ende des Zeitfensters als App-Uhrzeit. |
| `enabled` | Lesen | Zeitfenster aktiviert: Boolean. |
| `editable` | Lesen | Derzeit `false`: genaue Zeitspanne wird im Fahrzeug festgelegt. Kein zusätzlicher Schreibbefehl. |
| `targetEnabled` | Wunsch | Boolean oder `null`; übernehmen mit dem gemeinsamen `preferredTimes.commands.apply`. |

### 4.13 Aktualitätsdaten aller Lesebereiche

| Pfad ab `vw-app.0.` | Art | Inhalt |
| --- | --- | --- |
| `refresh.autoBusy` | Lesen | Boolean: Ein automatischer Leseauftrag läuft. |

Für jeden Bereich existieren zusätzlich die folgenden sechs **nur lesbaren** Felder:

| Pfadmuster ab `vw-app.0.` | Inhalt |
| --- | --- |
| `refresh.<Bereich>.status` | `fresh`, `stale`, `error`, `unknown`. |
| `refresh.<Bereich>.lastReadAt` | Letzte erfolgreiche App-Auslesung als ISO-Zeit; leer vor der ersten erfolgreichen Auslesung. |
| `refresh.<Bereich>.ageSeconds` | Alter dieser erfolgreichen Auslesung in Sekunden; sonst `null`. |
| `refresh.<Bereich>.lastErrorCode` | Fester Fehlercode der letzten Abfrage, sonst leer. |
| `refresh.<Bereich>.lastDurationSeconds` | Dauer der letzten Abfrage in Sekunden. |
| `refresh.<Bereich>.maxAgeSeconds` | Tatsächlich verwendete Gültigkeitsgrenze in Sekunden. |

Ersetze `<Bereich>` durch einen dieser Namen:

| Bereich | Zugehörige Daten |
| --- | --- |
| `climate` | Klima-Istwerte einschließlich Temperatur und Optionen. |
| `charging` | Batterie-SOC, Reichweite und globale Ladeeinstellungen. |
| `vehicleReport` | Fahrzeugzustandsbericht. |
| `vehicleAccess` | Türen, Fenster, Kofferraum und Verriegelungszustand. |
| `vehicleInfo` | FIN. |
| `departureClimate` | Beide Klima-Abfahrtszeiten. |
| `departureLocations` | Ladeortliste und Zuordnungen. |
| `departureLocation_loc_<24hex>` | Vollständige Details genau dieses erkannten Ladeorts. |

Beispiel: **`vw-app.0.refresh.charging.lastReadAt`** gehört zu SOC, Reichweite und globalen Ladeeinstellungen. **`vw-app.0.refresh.departureClimate.status`** gehört zu beiden Klimatimern. Die Ortsliste und die vollständigen Ortsdetails haben unterschiedliche Aktualitätsbereiche.

### 4.14 Zeitmetadaten und zusätzliche Strukturen

Auslesezeiten wie `observedAt`, `lastReadAt` und `operation.lastUpdated` sind ISO-Zeichenfolgen in UTC mit `Z`. Admin oder deine Visualisierung kann sie in Ortszeit darstellen. Timerfelder `time` und `date` bleiben die lokalen App-/Fahrzeugangaben. `vehicleOffset` enthält `Z` oder einen UTC-Versatz wie `+01:00` (maximal 18 Stunden im Betrag), `isLocalVehicleTime` eine boolesche Kennzeichnung. `source` lautet derzeit `editor_initial_snapshot`: beim Öffnen gelesene Ausgangsdaten des Timereditors. Diese Angaben sind keine vom Adapter berechnete Zeitumstellung. Eine reine Zeitänderung eines Einmaltimers erhält sein bisheriges Datum; sie legt nicht automatisch den nächsten passenden Wochentag fest.

JSON-Datenpunkte enthalten **Text mit JSON-Inhalt**, beispielsweise `["mon","fri"]` oder eine Liste von Berichttexten. Für die Verarbeitung in einem Skript muss dieser Text als JSON eingelesen werden.

### 4.15 Optionale Datenpunkte aus einem früheren Prototyp

Bei einer Neuinstallation bleibt die Einstellung `legacyStatePrefix` leer. Der Adapter erzeugt dafür keine Objekte. Nur bei einer Migration kann ein bereits bestehender Zweig unter `0_userdata.0` angegeben werden. Der alte Steuerdienst und sein Skript müssen dann abgeschaltet sein.

Bei einem eingestellten Präfix `<Altpräfix>` berücksichtigt der Adapter folgende **bereits vorhandene** Datenpunkte:

| Pfad | Entsprechung oder Funktion |
| --- | --- |
| `<Altpräfix>.start` | Alter Startknopf, wie `vw-app.0.commands.start`. |
| `<Altpräfix>.stop` | Alter Stoppknopf, wie `vw-app.0.commands.stop`. |
| `<Altpräfix>.refresh` | Alter Klimaleseknopf, wie `vw-app.0.commands.refresh`. |
| `<Altpräfix>.busy` | Spiegel von `operation.busy`. |
| `<Altpräfix>.lastResult` | Spiegel von `operation.lastResult`. |
| `<Altpräfix>.lastError` | Spiegel von `operation.lastError`. |
| `<Altpräfix>.lastUpdated` | Spiegel von `operation.lastUpdated`. |
| `<Altpräfix>.appState` | Spiegel von `climate.appState`. |

Für neue Automatisierungen verwende die regulären Datenpunkte unter `vw-app.0`.

## 5 Fehler erkennen und beheben

| Anzeige oder Situation | Vorgehen |
| --- | --- |
| Wunsch ist bestätigt, App unverändert | Der Wunsch ist gespeichert. Anschließend den zuständigen Übernehmen-Befehl auslösen. |
| `invalid_temperature`, `temperature_selection_failed` | Gültige Temperatur ausdrücklich neu wählen oder `commands.clearTemperature` auslösen. Der wieder angezeigte alte Wert allein hebt den Auswahlfehler nicht auf. |
| `settings_selection_failed`, `charging_selection_failed`, `departure_selection_failed` | Das im Auswahlfehlerfeld genannte Feld gültig neu wählen oder die Wünsche genau dieser Gruppe löschen. Eine Änderung eines anderen Felds beseitigt den Fehler nicht. |
| `departure_binding_changed` | Ladeortliste neu lesen, richtigen Ort prüfen, betroffene Wünsche ausdrücklich neu wählen oder löschen. |
| `unsaved_settings` oder offener manueller Editor | Am Handy die eigenen Änderungen speichern oder verwerfen und zur Fahrzeugübersicht zurückgehen. Danach erneut lesen. |
| `busy` | Aktuellen Auftrag beenden lassen; erst danach den nächsten eigenen Befehl senden. |
| `outcome_unknown` oder Zeitlimit | Tatsächlichen App-/Fahrzeugzustand prüfen. Keine automatische Wiederholung eines Start-, Stopp-, Speichern- oder PIN-Auftrags einrichten. |
| `security.blocked=true` | App, Fahrzeugzustand und PIN prüfen; gegebenenfalls ausschließlich den Rücksetzknopf in den Adaptereinstellungen verwenden. |
| `refresh.<Bereich>.status=error` | Zugehörigen `lastErrorCode` lesen, Handy/Verbindung/App prüfen und diesen Bereich erneut lesen. |
| `stale` bei sichtbaren Werten | Werte sind historische Beobachtungen. Ursache für fehlende Aktualisierung prüfen, nicht als frisch verwenden. |
| App bleibt auf der Startseite | Das kann zwischen Aufträgen normal sein. Prüfe Intervall, `refresh.autoBusy`, `lastReadAt` und Fehler aller Bereiche; die letzte Bildschirmansicht allein zeigt den Abfragestatus nicht. |
| Nach Handyneustart keine Verbindung | Handy manuell entsperren, drahtloses Debugging und aktuellen Verbindungsport prüfen; gegebenenfalls den Port in den Adaptereinstellungen aktualisieren. |
| Andere App-Version als freigegeben | Neue Ansicht zuerst manuell prüfen und das Profil über die Einrichtung erneut bestätigen. Keine Schutzprüfung durch bloßes Ändern von Datenpunkten umgehen. |

Der Adapter muss bekannte Ansichten eindeutig erkennen. Eine offene PIN-Maske, ein manueller Entwurf oder eine unbekannte App-Ansicht wird nicht blind weggeklickt. Bei einem Problem genügen zunächst Version, betroffener Befehl und bereinigter Fehlercode. **Keine S-PIN, vollständigen Instanzkonfigurationen oder privaten Fahrzeugansichten veröffentlichen.** Maskierung und ioBroker-Verschlüsselung verhindern keinen Zugriff durch privilegierte Systemadministratoren; manche Admin-Versionen schreiben Konfiguration beim Speichern in die Browserkonsole. Solche Mitschnitte nicht weitergeben.

## 6 Automatisierungen erstellen

Verwende in einer Visualisierung oder Blockly getrennte Bedienelemente für Wunschwerte und Ausführen. Ein sinnvoller Ablauf ist: **Wünsche schreiben → Bestätigung und leere Fehlerfelder prüfen → genau einen Befehl auslösen → Auftragsende und Istwerte prüfen**. Ein Löschen-Knopf kann Wünsche ausdrücklich auf **App-Einstellungen beibehalten** zurücksetzen.

Für einen SOC-Hinweis verwende `battery.soc` zusammen mit `refresh.charging.status`. Für eine Offen-Warnung verwende die einzelnen Öffnungszustände zusammen mit `refresh.vehicleAccess.status` und gültiger Qualität. Bei unbekannten Daten zeige **unbekannt** oder **veraltet**, statt sie in **zu** oder **aus** umzudeuten.

Verknüpfe einen Zustandsunterschied nicht mit einer endlosen Nachregelung: Ein gespeicherter Temperatur-, Timer- oder Ladewunsch soll erst nach einem ausdrücklichen eigenen Auslöser angewendet werden. Verriegeln und Entriegeln bleiben einzelne Befehle ohne automatische Wiederholung bei Fehlern. Dadurch bleiben manuelle Änderungen in der Volkswagen-App möglich und werden anschließend als neue Istwerte sichtbar.

Für Einrichtung und Kopplung: [Installationsanleitung](INSTALLATION.de.md). Für technische Einstellungsdetails: [Einrichtungsreferenz](ADMIN-SETUP.md). Projekt und Rückmeldungen: [ioBroker.vw-app auf GitHub](https://github.com/Borilu/ioBroker.vw-app).
