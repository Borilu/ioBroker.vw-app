# VW-App in ioBroker installieren und einrichten

Mit `vw-app` bedient ioBroker die offizielle Volkswagen-App auf einem Android-Handy. Das Handy bleibt zu Hause im WLAN und am Ladegerät. Die Anmeldung bei Volkswagen erfolgt auf dem Handy.

**Stand der Einrichtungsschritte: Adapter 0.11.1.** Die Installation aus GitHub ist bereits möglich. Die Aufnahme in die normale ioBroker-Adapterliste ist beantragt und noch nicht freigegeben. Hinweise zur automatischen Porterkennung unten beziehen sich auf den aktuellen Quellstand; die fest verlinkte ältere Version 0.11.1 enthält sie noch nicht.

[Einrichtungsanleitung als PDF herunterladen](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.9.2/VW-App-Installation-und-Kopplung.pdf) (PDF für 0.9.2, gleicher Kopplungsablauf) · [Projekt auf GitHub](https://github.com/Borilu/ioBroker.vw-app)

Nach der Einrichtung hilft die [Bedienungsanleitung mit vollständiger Datenpunktreferenz und Bedienfolgen](BEDIENUNG.de.md), auch [als PDF für 0.10.0](https://github.com/Borilu/ioBroker.vw-app/releases/download/v0.10.0/VW-App-Bedienungsanleitung.pdf). Dieses ältere PDF enthält die Lademodi noch nicht; die Online-Anleitung ist für 0.11.1 aktualisiert.

Die Screenshots stammen aus den offiziellen ioBroker- und Android-Anleitungen. Android zeigt hier englische Beispielansichten; Samsung und andere Hersteller können anders aussehen. **Alle abgebildeten Adressen, Ports und Codes sind Beispiele. Verwende immer die Angaben deines eigenen Handys.**

## Vor dem Start

- **ioBroker auf Linux x64 mit Intel- oder AMD-Prozessor.** Benötigt werden Node.js ab 22.19.0, js-controller ab 6.0.11 und Admin ab 7.6.20. Ein Raspberry Pi mit ARM-Prozessor gehört nicht zum hier beschriebenen einfachen Installationsweg.
- **Android-Handy mit Android 11 oder neuer und dem Menüpunkt „Drahtloses Debugging“.** Bewährt ist die Kombination Galaxy A31, Android 12, deutsche Volkswagen-App 4.8.1 und ID.7 GTX Tourer. Andere App-Ansichten und Fahrzeuge sind gesondert zu prüfen.
- **Volkswagen-App eingerichtet.** Melde dich an und prüfe, ob du dein Fahrzeug bereits manuell über die App bedienen kannst. Erforderliche Volkswagen-Dienste müssen für dein Fahrzeug verfügbar sein.
- **Erreichbares Heimnetz und Internetzugang.** Handy und ioBroker müssen miteinander kommunizieren können. Die VM darf per Netzwerkkabel angebunden sein. Gast-WLAN und abgeschottete Netze können die Verbindung verhindern.
- **Ein Ladegerät für den dauerhaften Betrieb.** Ein USB-Kabel zur VM ist nicht erforderlich.

Für die Grundeinrichtung brauchst du weder dein Volkswagen-Passwort noch die S-PIN in ioBroker einzutragen.

## 1 Den Adapter installieren

### Jetzt aus GitHub installieren

1. Öffne die ioBroker-Verwaltung im Browser und gehe zu **Adapter**.
2. Aktiviere bei Bedarf den **Expertenmodus**, falls das Symbol für eigene Quellen fehlt.
3. Klicke oben auf das **Octocat-Symbol** für **Aus eigener Quelle installieren**. Im folgenden Bild ist es mit **6** markiert.

![ioBroker Werkzeugleiste mit Nummer 6 für eigene Quellen](images/setup/iobroker-adapter-toolbar.png)

4. Wähle im geöffneten Dialog **Benutzerdefiniert**. Der Screenshot zeigt den gleichen Dialog zunächst mit dem Reiter „Von npm“.

![Offizieller ioBroker Dialog mit den Reitern Von npm, Von GitHub, Benutzerdefiniert und Aus Datei](images/setup/iobroker-install-source.png)

5. Trage diese Adresse für die veröffentlichte Version 0.11.1 ein:

   ```text
   https://github.com/Borilu/ioBroker.vw-app/tree/v0.11.1
   ```

6. Lass **Instanz erstellen, wenn noch keine existiert** eingeschaltet und starte **Installieren**. Warte, bis ioBroker die Installation abgeschlossen hat.
7. Öffne **Instanzen** und dort die Einstellungen von **vw-app.0**. Falls keine Instanz vorhanden ist, füge auf der Adapterkachel eine hinzu. Starte die Instanz, falls sie ausgeschaltet ist.

Bei einer Installation aus eigener Quelle prüft ioBroker die Adapter-Abhängigkeiten nicht vollständig. Prüfe deshalb die Voraussetzungen oben vor der Installation. Der Reiter **Von GitHub** kann einen aktuellen Entwicklungsstand installieren; der feste Versionslink oben wählt gezielt 0.11.1.

### Später aus der normalen Adapterliste installieren

Dieser Weg funktioniert erst nach der Aufnahme in das verwendete Adapterverzeichnis:

1. Öffne **Adapter** und aktualisiere die Adapterliste.
2. Suche nach **vw-app**.
3. Öffne das Menü der Kachel und wähle **Instanz hinzufügen**. ioBroker installiert dabei den Adapter, falls er noch fehlt.
4. Öffne anschließend unter **Instanzen** die Einstellungen von **vw-app.0**.

Eine Freigabe für **Latest/Beta** macht den Adapter zunächst nur in diesem Verzeichnis sichtbar. Die Aufnahme in **Stable** erfolgt separat. Lege bei einer bereits vorhandenen Installation keine zweite Instanz für dasselbe Handy an.

## 2 Das Android-Handy vorbereiten

1. Verbinde das Handy mit deinem Heim-WLAN.
2. Öffne bei Samsung **Einstellungen → Telefoninfo → Softwareinformationen**.
3. Tippe **siebenmal auf Buildnummer** und bestätige gegebenenfalls die Bildschirmsperre.
4. Gehe zurück in die Einstellungen und öffne **Entwickleroptionen → Drahtloses Debugging**.
5. Schalte **Drahtloses Debugging** ein. Erlaube die Verbindung für dein eigenes vertrauenswürdiges WLAN, wenn Android danach fragt.

![Offizielle Android Beispielansicht für drahtloses Debugging](images/setup/android-wireless-debugging.png)

**Orientierung im Bild:** „IP address & Port“ bezeichnet die Adresse für die spätere Verbindung. „Pair device with pairing code“ öffnet die einmalige Kopplung. Bei Samsung heißen diese Punkte sinngemäß **IP-Adresse und Port** sowie **Gerät mit Kopplungscode koppeln**.

## 3 Die Android-Werkzeuge im Adapter einrichten

1. Öffne die Einstellungen von **vw-app.0**. Die Instanz muss laufen; eine Handyverbindung ist dafür noch nicht nötig.
2. Setze **Automatische App-Abfragen: Mindestabstand je Bereich** für die Einrichtung vorübergehend auf **0**. Speichere und warte den Neustart der Instanz ab. Öffne die Einstellungen anschließend wieder.
3. Lass **Android-Werkzeuge für diese Instanz verwenden** eingeschaltet.
4. Öffne den Link zur **Google-SDK-Lizenz**. Wenn du zustimmst, aktiviere **Ich habe die Google-SDK-Lizenz gelesen und akzeptiere sie**.
5. Klicke auf **Android-Werkzeuge herunterladen und installieren** und warte auf die Erfolgsmeldung.

Damit stellt der Adapter seine benötigten Werkzeuge selbst bereit. Ein zusätzliches Steuerprogramm auf der VM ist nicht erforderlich. Das bloße Einschalten der Werkzeug-Option startet noch keinen Download.

## 4 Das Handy einmalig koppeln

**Kopplungsport und Verbindungsport sind zwei verschiedene Werte.** Die Zahl hinter dem Doppelpunkt ist jeweils der Port.

| Angabe auf dem Handy | Feld in den Adaptereinstellungen |
| --- | --- |
| IP-Adresse ohne den Teil hinter dem Doppelpunkt | **IP-Adresse des Android-Handys** |
| Port im geöffneten Kopplungscode-Dialog | **Kopplungsport aus dem Code-Dialog** |
| Sechs Ziffern im Kopplungscode-Dialog | **Sechsstelliger Kopplungscode** |
| Port auf der Hauptseite von Drahtloses Debugging | **Verbindungsport auf der Hauptseite** |

1. Trage die **IP-Adresse des Handys ohne Port** im Adapter ein.
2. Öffne auf dem Handy **Gerät mit Kopplungscode koppeln** und lass diesen Dialog offen.

![Öffentlicher Android Beispielbildschirm mit sechsstelliger Kennung und eigenem Kopplungsport](images/setup/android-pairing-dialog.png)

Dieses Bild und das Bild der Hauptseite stammen von verschiedenen Beispielgeräten. Übernimm keine der gezeigten Zahlen.

3. Trage den **Kopplungsport** und den **sechsstelligen Code** aus deinem offenen Handy-Dialog in die passenden Adapterfelder ein. Führende Nullen gehören zum Code.
4. Klicke auf **Jetzt mit dem Handy koppeln**, solange der Dialog auf dem Handy geöffnet ist. Warte auf die Erfolgsmeldung.
5. Schließe auf dem Handy **nur den Kopplungscode-Dialog**. Lass drahtloses Debugging eingeschaltet.
6. Lies auf dessen Hauptseite den **Verbindungsport** ab. Trage ihn unter **Verbindungsport auf der Hauptseite** ein und **speichere** die Adaptereinstellungen.
7. Warte den Neustart ab, öffne die Einstellungen wieder und klicke auf **Verbindung und App-Version prüfen**.

Der Kopplungscode wird nicht dauerhaft als Adaptereinstellung gespeichert. Leere sein Feld nach erfolgreicher Kopplung oder schließe das Formular.

## 5 Das Display beim Laden eingeschaltet lassen

1. Stecke das Handy ans Ladegerät und entsperre es.
2. Klicke in den Adaptereinstellungen auf **Beim Laden wachhalten jetzt aktivieren**.
3. Aktiviere zusätzlich **Handy bei Verbindung am Ladekabel wachhalten** und speichere.

Das Display bleibt damit beim Laden eingeschaltet. Nach einem Neustart oder einer manuell aktivierten Bildschirmsperre musst du das Handy weiterhin selbst entsperren. Das Wachhalten garantiert nicht, dass drahtloses Debugging dauerhaft eingeschaltet bleibt.

## 6 Die Volkswagen-App und das Fahrzeug übernehmen

1. Entsperre das Handy und öffne die **Volkswagen-App**.
2. Wähle das gewünschte Fahrzeug und öffne dessen **Startseite beziehungsweise Fahrzeugübersicht**. Schließe offene Dialoge.
3. Klicke in den Adaptereinstellungen auf **App und Fahrzeug übernehmen**.
4. Prüfe die vorgeschlagene **Geprüfte Volkswagen-App-Version** und den **Vollständigen Fahrzeugtext aus der App**. Es muss dein gewünschtes Fahrzeug sein.
5. **Speichere** die Einstellungen und warte den Neustart ab.

„Verbindung und App-Version prüfen“ allein ersetzt diesen Schritt nicht. Der Adapter benötigt die ausdrückliche Übernahme von App und Fahrzeug.

## 7 Zuerst das Lesen prüfen

1. Öffne in ioBroker **Objekte → vw-app.0 → commands**.
2. Betätige **refreshCharging** einmal. Falls ein Werte-Dialog erscheint, schreibe **true** und lass **Bestätigt / ack** ausgeschaltet.
3. Warte, bis der Auftrag abgeschlossen ist. Gehe dann zu **Objekte → vw-app.0 → battery**. Vergleiche dort **soc** und **rangeKm** mit dem Ladestand und der Restreichweite in der Volkswagen-App.
4. Öffne wieder die Adaptereinstellungen und setze **Automatische App-Abfragen: Mindestabstand je Bereich** auf **15**. Speichere.

**15 Sekunden sind der Mindestabstand je Bereich nach dessen letzter Abfrage.** Der Adapter arbeitet die Bereiche nacheinander ab; ein kompletter Durchlauf kann deutlich länger dauern. Lass **App-Auslesung als veraltet markieren nach** zunächst auf **0 = automatisch**.

Die Werte stammen aus der App. Ein frisch ausgelesener App-Wert muss noch keine neue Messung am Auto sein. Regelmäßiges Lesen übernimmt keine gespeicherten Änderungswünsche und startet keine Klimatisierung.

Unter **vehicleInfo.vin** findest du außerdem die FIN des ausgewählten Fahrzeugs. Sie wird regelmäßig aus „Meine Fahrzeuge“ gelesen. Mit **commands.refreshVehicleInfo** lässt sie sich auch gezielt abfragen; **vehicleInfo.observedAt** zeigt die letzte erfolgreiche App-Auslesung.

## 8 Bei Bedarf die Bedienung freigeben

Für Klima- und Einstellungsänderungen aktiviere **Klimastart, Stopp und Änderungen der Fahrzeugeinstellungen erlauben** und speichere. Erst diese Freigabe erlaubt tatsächliche Änderungen. Starte den ersten Klimatest bewusst und prüfe die Rückmeldung in App und Fahrzeug; die Ausführung kann etwas dauern.

**Verriegeln und Entriegeln sind optional:** Beide Funktionen müssen bereits manuell in deiner Volkswagen-App funktionieren. Trage die vierstellige **Volkswagen S-PIN ausschließlich im maskierten Feld der Adaptereinstellungen** ein und aktiviere **Fahrzeug verriegeln und entriegeln erlauben**. Speichere anschließend. Die S-PIN gehört niemals in Skripte, Chatnachrichten oder öffentliche Screenshots. Administratoren deines ioBroker-Systems können auf sensible Konfigurationen zugreifen; gib keine Konfigurations- oder Konsolenmitschnitte mit hinterlegter PIN weiter.

Eine unklare Befehlsrückmeldung ist kein Anlass, den Befehl wiederholt zu drücken. Prüfe zuerst die Volkswagen-App und den tatsächlichen Fahrzeugzustand.

## Wireless Guardian für die automatische Portsuche (experimentell)

Dieser optionale Weg wird aktuell mit einer separat installierten **Wireless-Guardian-Testversion 0.6 für Android 16** erprobt. Die App gehört nicht zum Adapterpaket; ein allgemein verfügbarer Installationsweg steht noch nicht bereit. Der Adapter akzeptiert für die automatische Einrichtung ausschließlich die für diesen Test freigegebene App-Version. Die übliche Android-Kopplung und die Prüfung der Handyidentität müssen zuvor erfolgreich sein.

Wireless Guardian benötigt die Android-Berechtigung für geschützte Systemeinstellungen, damit er drahtloses Debugging überwachen und gegebenenfalls aktivieren kann. Nach ausdrücklicher Freigabe bietet er zusätzlich eine durch einen individuellen Schlüssel geschützte Portauskunft im lokalen WLAN an. Die App benötigt dafür Netzwerkzugriff. Die Android-Kopplung und die Prüfung der Handyidentität bleiben erforderlich; ein gemeldeter Port allein ist kein Verbindungsnachweis. Verwende dafür ein vertrauenswürdiges WLAN. Die Portauskunft ist standardmäßig ausgeschaltet.

**Einschränkung des Prüfstands:** Ein Steuerhandy darf nur von genau einer Adapterinstanz auf einem einzigen Host verwendet werden. Sperrvermerke für unklare Vorgänge gelten nur pro Instanz; sie verhindern keinen anderen Versuch durch eine weitere Instanz oder einen weiteren Host. Sie dürfen nicht durch Löschen, Zurückspielen alter Journale oder Wechsel der Instanz umgangen werden. Eine technische Absicherung über mehrere Instanzen oder Hosts hinweg ist noch nicht nachgewiesen.

**Android-Sonderberechtigung einrichten:** Nach der normalen Android-Kopplung und der Installation der freigegebenen Guardian-Test-App lies den Hinweis in den Adaptereinstellungen. Wenn du zustimmst, aktiviere **Ich verstehe und erlaube diese Android-Berechtigung für Wireless Guardian ausdrücklich** und wähle **Android-Berechtigung für Wireless Guardian einrichten**. Der Adapter prüft das gekoppelte Handy, Android 16 und die freigegebene Guardian-App und nutzt seine eigene Android-Verbindung. Die Berechtigung erlaubt der App grundsätzlich das Ändern geschützter Android-Einstellungen; sie ist nicht auf das drahtlose Debugging beschränkt. Die Test-App ist außerdem nicht auf ein bestimmtes WLAN begrenzt. Eine bereits erteilte Berechtigung wird nur geprüft. Das Einschalten der Guardian-Überwachung und gegebenenfalls die Android-Benachrichtigungsfreigabe sind eigene Schritte am Handy.

Bei einer unterbrochenen oder unklaren Rückmeldung bleibt der Versuch gesperrt, auch wenn Android die Berechtigung inzwischen als erteilt anzeigt. Ein möglicherweise noch laufender älterer ADB-Auftrag kann sonst später eintreffen. Den Knopf nicht erneut betätigen, keine lokalen Journaldateien löschen und den Zustand mit einer Administration untersuchen. Ein bloßes Auslesen oder ein Neustart allein hebt die Sperre nicht auf; eine allgemein sichere automatische Wiederherstellung steht derzeit nicht zur Verfügung. Die Berechtigung wird nicht nach einem Neustart oder App-Update automatisch erneut erteilt.

Bei einem älteren Journal mit Status „bestätigt“ wird eine vorhandene Berechtigung nur lesend angezeigt. Der alte Status kann auch nach einem unklaren Versuch entstanden sein. Deshalb wird das Journal nicht automatisch aktualisiert; fehlt die Berechtigung später, bleibt eine Neuerteilung gesperrt und muss mit einer Administration gesondert untersucht werden.

1. Öffne die Adaptereinstellungen und lasse den Guardian-Port auf **37457** stehen. Bestehende Guardian-Verbindungen oder bereits gespeicherte Schlüssel werden durch die automatische Erstkopplung nicht ersetzt.
2. Öffne am Handy in Wireless Guardian **Kopplungsweg ohne Schlüssel testen** und erlaube den Test. Starte innerhalb von 60 Sekunden in ioBroker **Guardian-Kopplungsweg ohne Schlüssel testen**. Dabei wird kein Schlüssel gespeichert und keine Portauskunft freigeschaltet.
3. Wähle in ioBroker **Verschlüsselten Schlüssel in ioBroker vorbereiten**. Der Adapter kann dabei neu starten. Lade die Einstellungsseite anschließend neu und prüfe den Kopplungsstatus. Ein älteres noch geöffnetes Einstellungsfenster nicht speichern.
4. Öffne am Handy **Automatisch mit ioBroker koppeln** und erlaube die einmalige Kopplung. Lass Guardian sichtbar und starte innerhalb von 60 Sekunden in ioBroker die Übertragung. Der zufällige Schlüssel wird über die bereits gekoppelte Android-Verbindung übertragen; er muss nicht abgetippt werden. Nach der Übertragung prüft der Adapter die authentifizierte Portauskunft und die gespeicherte Handyidentität.
5. Lade nach einem erneuten Adapterneustart die Einstellungen neu und wähle **Aktive Guardian-Verbindung prüfen**. Eine beim Neustart unterbrochene Rückmeldung allein belegt weder Erfolg noch Misserfolg.

Der Schlüssel wird durch ioBroker geschützt gespeichert und gehört nicht in Chatnachrichten, Screenshots oder Protokolle. Privilegierte Administratoren des Hosts können auf geschützte Daten zugreifen. Die Kopplung verändert keine S-PIN und löst keinen Fahrzeugbefehl aus.

**Unklarer Ausgang:** Nicht erneut übertragen und kein neues Kopplungsfenster öffnen. Ein möglicherweise verzögerter älterer Auftrag könnte ein neues Fenster beanspruchen. Die Bereinigung am Handy oder ein Neustart allein beweist nicht, dass alle alten Aufträge beendet sind. Die Wiederherstellung ist deshalb gesperrt; den Zustand mit einer Administration untersuchen und keine lokalen Journaldateien löschen.

Frühere Testversionen haben den lokalen Kopplungsstatus teilweise ohne Schlüsselbindung gespeichert. Eine bereits eingeschaltete und funktionierende Portauskunft bleibt beim Update unverändert nutzbar; der Status wird nicht automatisch migriert. Unklare frühere Kopplungen und bereits erteilte Wiederherstellungsfreigaben bleiben gesperrt. Das Löschen lokaler Dateien oder blindes erneutes Koppeln kann den Zustand weiter verunklaren.

Die Wiederverbindung und das erneute Aktivieren von drahtlosem Debugging hängen von Android, WLAN und den App-Berechtigungen ab. Es kann nach einem Neustart eine Weile dauern; eine Android-Abfrage oder eine Gerätesperre kann weiterhin eine manuelle Eingabe verlangen. Die regelmäßige Auslesung und ihre einstellbaren Intervalle arbeiten unabhängig von der Guardian-Kopplung weiter. Frischeangaben beziehen sich auf das Lesen der Volkswagen-App, nicht auf einen garantierten neuen Messzeitpunkt im Fahrzeug.

## Updates und häufige Fragen

**Adapter aktualisieren:** Nach der Aufnahme in dein verwendetes Verzeichnis werden verfügbare Updates auf der Adapterseite angeboten. Bis dahin installierst du die gewünschte veröffentlichte Version erneut über **Aus eigener Quelle → Benutzerdefiniert**, mit dem passenden Versionslink aus den GitHub-Releases. Die vorhandene Instanz bleibt bestehen; füge für ein Update keine neue hinzu.

**Volkswagen-App aktualisiert:** Öffne die Fahrzeugübersicht und führe **App und Fahrzeug übernehmen** erneut aus. Geänderte Ansichten können eine Anpassung des Adapters erfordern.

**Verbindungsport geändert:** Im aktuellen Quellstand kann der Adapter bei Verbindungsausfall den neuen Port für das bereits identifizierte Handy an der eingestellten IPv4-Adresse automatisch suchen. Falls die übliche Erkennung und eine direkte Abfrage keinen Port finden, kann er eine zeitlich begrenzte mDNS-Multicast-Abfrage im lokalen Netz senden. Andere Geräte können diese Frage empfangen; nur eindeutige Antworten von der eingestellten Handy-IP werden ausgewertet. Der Adapter durchsucht keine anderen Geräte im Heimnetz, prüft die Gerätekennung und speichert den gefundenen Port nur vorübergehend im laufenden Adapter. Falls die Suche im eigenen Netz nicht funktioniert, den Port wie bei der Einrichtung auf der Hauptseite von **Drahtloses Debugging** ablesen, im Adapter eintragen und speichern. Das Handy muss weiterhin gekoppelt, entsperrt und im WLAN erreichbar sein. Android kann das drahtlose Debugging selbst ausschalten; dann musst du es am Handy wieder einschalten.

| Problem | Was du prüfen solltest |
| --- | --- |
| vw-app fehlt in der Adapterliste | Bis zur Verzeichnisfreigabe den GitHub-Weg aus Schritt 1 verwenden. |
| Einrichtungsschaltflächen antworten nicht | Läuft die Instanz? Dauerhafte Einstellungen speichern und den Neustart abwarten. |
| Kopplung schlägt fehl | Kopplungscode-Dialog offen halten; aktuellen Code und dessen Kopplungsport verwenden. |
| Gekoppelt, aber keine Verbindung | Den anderen Port von der Hauptseite übernehmen, speichern und die Verbindung prüfen. |
| Nach Handyneustart keine Verbindung | Handy entsperren, drahtloses Debugging einschalten und den aktuellen Verbindungsport prüfen. Bei fehlgeschlagener automatischer Suche den Port in den Adaptereinstellungen aktualisieren. Nur bei verlorener Kopplung erneut koppeln. |
| Handy ist im WLAN, aber unerreichbar | Gast-WLAN, Geräteisolation, VM-Netz und Firewall prüfen. mDNS oder die direkte Abfrage können durch Netzfilter ausfallen, beispielsweise in VM- oder Container-Netzen. Keine Portfreigabe ins Internet einrichten. |
| App lässt sich nicht auslesen | Handy entsperren, Fahrzeugübersicht öffnen, offene Dialoge schließen und App/Fahrzeug erneut übernehmen. |
| Display wird dunkel | Ladegerät angeschlossen? Wachhalten aus Schritt 5 aktiviert? Eine Bildschirmsperre selbst entsperren. |
| Werte ändern sich verzögert | Die App kann ältere Fahrzeugdaten anzeigen; zusätzlich benötigt der vollständige Adapter-Rundlauf Zeit. |

## Weiterführende Hilfe und Bildnachweise

- [Ausführliche Adapterbeschreibung und Datenpunkte](ADMIN-SETUP.md)
- [ioBroker Anleitung zur Adapterseite und Installation aus eigener Quelle](https://www.iobroker.com/docs/admin/adapter.md?lang=de)
- [Android Anleitung für drahtloses Debugging](https://developer.android.com/tools/adb#wireless-android11)
- [Android Entwickleroptionen](https://developer.android.com/studio/debug/dev-options)
- [Veröffentlichte Versionen](https://github.com/Borilu/ioBroker.vw-app/releases)
- [Fehler melden](https://github.com/Borilu/ioBroker.vw-app/issues) - ohne S-PIN, Kopplungscode oder private Fahrzeugdaten.

Die beiden ioBroker-Screenshots stammen von **ioBroker.docs**, Copyright (c) 2014-2026 bluefox, MIT-Lizenz. Die Android-Screenshots stammen aus der Dokumentation von **Android Developers / Android Open Source Project**, Apache License 2.0. Die Bilder sind unverändert. [Genaue Bildquellen](images/setup/SOURCES.md) und [vollständige Lizenztexte](images/setup/LICENSES.txt) liegen bei. Im PDF sind die Lizenztexte zusätzlich als Dateianlage enthalten.
