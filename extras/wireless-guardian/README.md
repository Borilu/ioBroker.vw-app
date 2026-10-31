# Wireless Guardian für den ioBroker-Adapter vw-app

Wireless Guardian ist eine Android-Begleit-App für ein dauerhaft eingeschaltetes Steuerhandy. Sie kann nach ausdrücklicher Freigabe das drahtlose Debugging wieder einschalten. Eine zusätzliche, separat freigegebene Portauskunft hilft dem ioBroker-Adapter, nach einem Neustart einen geänderten Debugging-Port zu finden. Die App steuert weder die VW-App noch das Fahrzeug; das übernimmt der Adapter.

**Stand: erprobter Prototyp, noch keine allgemeine Veröffentlichung.** Diese Quellfassung gehört zum getesteten Guardian 0.6.0. Für andere Geräte oder Installationen sind Einrichtung und Verhalten noch gesondert zu prüfen. Der zugehörige Adapterstand muss die Guardian-Kopplung bereits unterstützen. Version 0.11.5 von npm enthält diese hier beschriebene Kopplung nicht automatisch.

## Was wurde getestet?

Am 31. Oktober 2026 wurden die automatische Kopplung und die Wiederverbindung auf einem Moto g67 mit Android 16 praktisch geprüft. Nach einem weiteren Geräteneustart belegte die Diagnose, dass der Adapter den geänderten Port über die authentifizierte Guardian-Portauskunft fand und die Identität des bereits gekoppelten Handys bestätigte. Anschließend wurden Fahrzeugbereiche erneut automatisch ausgelesen. Für den beobachteten Neustart war kein Nutzereingriff am Handy erforderlich; zunächst schlugen Verbindungsversuche während des Hochfahrens fehl. Das belegt keine dauerhafte Verfügbarkeit und ist kein allgemeiner Kompatibilitätsnachweis für andere Handys, Android-Versionen oder Netzwerkbedingungen.

Der getestete APK-SHA-256 lautete `7af7fcf134919c54db0004fbe31d6646fa90822649e9656509a3019ee1886b30`. Die APK ist nicht im Quellcode- oder npm-Paket enthalten. Vor einer Veröffentlichung muss das exakt geprüfte Artefakt als separates GitHub-Releaseasset bereitgestellt und anhand der vollständigen Prüfsumme sowie des öffentlichen Signaturzertifikats geprüft werden. Ein Neu-Build kann trotz gleichen Dateinamens eine andere Prüfsumme haben; der Adapter akzeptiert bei der automatischen Kopplung nur die für ihn ausdrücklich freigegebene APK-Prüfsumme. Eine andere APK muss daher erst geprüft und zusammen mit einem passenden Adapterstand bereitgestellt werden.

## Voraussetzungen und Sicherheit

- Ein dediziertes Android-Handy, das im vertrauenswürdigen WLAN eingeschaltet ist. Die Überwachung unterstützt Android 12, 12L und experimentell Android 16; die automatische Portauskunft und Guardian-Kopplung sind hier auf Android 16 begrenzt.
- Ein bereits regulär mit dem Handy gekoppelter Computer und eine funktionierende ADB-Verbindung. Für die Ersteinrichtung muss drahtloses Debugging manuell aktiviert und ein neuer Computer einmalig gekoppelt werden. Android kann außerdem eine eigene Netzwerkfreigabe verlangen; Guardian bestätigt diese nicht.
- Die Android-Sonderberechtigung `WRITE_SECURE_SETTINGS`, die grundsätzlich weitreichende Änderungen geschützter Systemeinstellungen ermöglicht. Der Überwachungscode verwendet sie für die Einstellung des drahtlosen Debuggings. Sie wird einmalig über eine bereits zugelassene ADB-Verbindung erteilt. Auf Android 16 sind zudem sichtbare Benachrichtigungen erforderlich.
- Die Android-Berechtigung `INTERNET` erlaubt grundsätzlich weitreichenden Netzwerkzugriff. Die Portauskunft nutzt einen authentifizierten UDP-Dienst im WLAN und kann eine lokale mDNS-Abfrage auslösen. Andere Geräte im WLAN können den Dienst beziehungsweise die Multicast-Abfrage sehen. Die App benötigt keine Standort- oder Bedienungshilfeberechtigung.
- Drahtloses Debugging ermöglicht bereits zugelassenen Computern weitreichenden Zugriff auf das Handy. Guardian unterscheidet Heim- und fremde WLANs nicht und kann Debugging bei jeder WLAN-Verbindung aktivieren, die Android zulässt. Vor fremden WLANs die Überwachung stoppen und Debugging bei Bedarf selbst ausschalten; das Stoppen allein verändert den Android-Schalter nicht.
- Der zufällige gemeinsame Guardian-Schlüssel wird in Android mit einem Android-Keystore-Schlüssel verschlüsselt und in ioBroker geschützt gespeichert. Er wird bei der automatischen Einrichtung über die bestehende ADB-Verbindung übertragen und muss nicht abgetippt werden. Schlüssel, S-PIN, Kopplungscodes und Konfigurationsexporte gehören nicht in Chat, Screenshots oder Protokolle. Privilegierte Administratoren des Hosts oder Geräts bleiben eine Vertrauensgrenze.

## Einrichtung des getesteten Prototyps

Diese Schritte beschreiben die erprobte Reihenfolge. Die getestete APK und der passende Adapterstand sind bislang nicht allgemein veröffentlicht.

1. Handy mit dem vertrauten WLAN verbinden. VW-App installieren, sich selbst anmelden und das Fahrzeug auf der Startseite anzeigen. Das Handy regulär über Androids **Drahtloses Debugging** mit dem ioBroker-Rechner koppeln; anschließend die Verbindung und das richtige Fahrzeug im Adapter prüfen.
2. Die passende, signierte Guardian-APK installieren. In der experimentellen Adapterfassung kann die Sonderberechtigung über **„Android-Berechtigung für Wireless Guardian einrichten“** nach ausdrücklicher Bestätigung erteilt werden. Der Adapter prüft dabei das gekoppelte Gerät, Android 16 und die freigegebene APK. Die tatsächliche Neuerteilung über diesen Knopf ist noch nicht am Gerät getestet; auf dem Moto wurde die vorhandene Berechtigung lesend bestätigt. Alternativ kann ein bereits mit dem richtigen Handy gekoppelter ADB-Server den folgenden Befehl verwenden. **Wichtig:** Der Adapter verwendet einen eigenen ADB-Server mit eigener Kopplung. Ein gewöhnlicher `adb`-Aufruf auf derselben VM verwendet diese Kopplung nicht automatisch:

   ```sh
   adb shell pm grant de.borilu.wirelessguardian android.permission.WRITE_SECURE_SETTINGS
   ```

   Falls mehrere Geräte verbunden sind, muss vor `shell` mit `-s` das richtige Gerät ausgewählt werden. Danach Guardian öffnen, Benachrichtigungen erlauben und **„Überwachung ausdrücklich einschalten“** wählen. Den Hinweis in der App lesen.
3. In ioBroker die Einstellungen der richtigen `vw-app`-Instanz öffnen. Die Verbindung zum Handy muss bereits eingerichtet und die Schutzprüfung für den Guardian-Schlüssel erfolgreich sein. Vorhandene Guardian-Kopplungen werden bei dieser Erstkopplung nicht ersetzt.
4. Optional zuerst in Guardian **„Kopplungsweg ohne Schlüssel testen“** öffnen und **„Einmalige Kopplung erlauben“** bestätigen. Guardian sichtbar lassen und innerhalb von 60 Sekunden in ioBroker **„0. Guardian-Kopplungsweg ohne Schlüssel testen“** auslösen. Dabei wird kein Schlüssel gespeichert und keine Portauskunft freigegeben.
5. In ioBroker **„1. Verschlüsselten Schlüssel in ioBroker vorbereiten“** auslösen. Der Adapter kann dadurch neu starten. Danach die Adaptereinstellungen neu laden und über **„Status der Guardian-Kopplung anzeigen“** prüfen, ob die Vorbereitung bereit ist. Ein vor dem Neustart geöffnetes altes Einstellungsfenster nicht speichern.
6. In Guardian **„Automatisch mit ioBroker koppeln“** und anschließend **„Einmalige Kopplung erlauben“** wählen. Guardian sichtbar lassen und innerhalb von 60 Sekunden in ioBroker **„2. Guardian-Kopplung übertragen und prüfen“** auslösen. Das Kopplungsfenster wird beim Verlassen der App, bei Ablauf oder beim Stoppen geschlossen. Es erfolgt keine automatische Wiederholung.
7. Nach einem möglichen Adapterneustart die Einstellungen erneut laden und die aktive Guardian-Verbindung mit **„Aktive Guardian-Verbindung prüfen“** kontrollieren. Eine erfolgreiche Portauskunft ersetzt nicht die ADB-Geräteprüfung. Für den automatischen Neustart muss Android nach dem Hochfahren ohne weitere notwendige Eingabe den Benutzer starten können; eine eingerichtete Gerätesperre kann eine einmalige Entsperrung verlangen und Konten sind ohne Gerätesperre bei physischem Zugriff zugänglich.

Die für die Portauskunft verwendete Verbindung ist standardmäßig ausgeschaltet und kann unabhängig von der Überwachung in Guardian über **„Portauskunft ausschalten und Schlüssel löschen“** deaktiviert werden. Die Überwachung selbst lässt sich in der App oder in ihrer Benachrichtigung stoppen. Nach einem ausdrücklichen Nutzerstopp oder bei fehlenden Benachrichtigungen und Berechtigungen startet der Dienst nicht zuverlässig automatisch wieder; die App zeigt den jeweiligen Zustand an.

## Wenn ein Kopplungsversuch unklar endet

Bei Abbruch, Zeitüberschreitung, verlorener Bestätigung oder einem Speicherfehler kann unklar sein, ob die Android-Seite schon gespeichert hat. Nicht automatisch erneut koppeln. In Guardian **„Portauskunft ausschalten und Schlüssel löschen“** wählen und die dortige Erfolgsmeldung abwarten. Das Kopplungsfenster schließen. Danach in den Adaptereinstellungen die bestätigte Wiederherstellung auswählen und **„Neuen Guardian-Versuch nach Bereinigung am Handy erlauben“** auslösen; erst dann ein neues Fenster öffnen und die Übertragung ausdrücklich starten. Bei fehlender Erfolgsmeldung oder weiter unklarem Zustand zuerst die Ursache prüfen.

Der nur lesende Android-Status kann sichtbare Portreste und offene Fenster erkennen. Nach einem Speicherfehler belegt dieser Status allein nicht, dass das vorherige Löschen dauerhaft auf dem Datenträger angekommen ist. Auch eine Meldung, dass Android den Schlüssel gespeichert hat, belegt für sich noch keinen laufenden UDP-Dienst: Der Adapter prüft danach zusätzlich eine authentifizierte Antwort und die Identität des Handys.

## Update, Build und lokale Tests

Das npm-Paket enthält nur diese Dokumente, keine Android-Quell- oder Testdateien und keine APK. Der vollständige Android-Quellstand ist nach Veröffentlichung im [Projekt auf GitHub](https://github.com/Borilu/ioBroker.vw-app) unter `extras/wireless-guardian` verfügbar; bis zur Veröffentlichung ist dieser Betastand dort noch nicht vorhanden. Die folgenden Build- und Testschritte erfordern diesen vollständigen Quellstand.

Ein Android-Update erhält Daten und gewährte Berechtigungen grundsätzlich nur dann, wenn es dieselbe Paketkennung und dieselbe vertrauenswürdige Signatur verwendet und Android es als gültiges Update akzeptiert. Den privaten Signaturschlüssel sicher und getrennt vom Quellcode aufbewahren. Einen fremden Build nicht als identisch zum getesteten APK behandeln. Vor einem Update prüfen, dass sowohl APK als auch Adapter für dieselbe Version und APK-Prüfsumme freigegeben sind. Nach Installation und ggf. erforderlicher persönlicher Android-Bestätigung den Guardian-Status, die aktive Verbindung und das erneute Auslesen der App prüfen. Vor einem weiteren unbeaufsichtigten Neustarttest offene Android-Abfragen und die Umgebung beachten. Die App nicht deinstallieren, um ein Update zu erzwingen: Dabei könnten ihre Daten und ihre Kopplung gelöscht werden.

Der lokale Build benötigt JDK 17, Android SDK Platform 36, Build Tools 35 und die bereits vorhandene Guardian-Signatur. In PowerShell im Projektverzeichnis:

```powershell
./tools/build-local.ps1
./tests/pairing/run.ps1
./tests/run-port-tests.ps1
```

Das Buildskript installiert oder veröffentlicht nichts. Es verweigert den Build, falls die vorhandene lokale Signaturidentität nicht verfügbar ist; es erzeugt keine neue Identität. Die Tests verwenden ausschließlich künstliche Schlüssel. Der Java/Node-Interoperabilitätstest benötigt Node.js und das Adapterrepository mit dieser Quelle unter `extras/wireless-guardian`. Die gezeigten Skripte sind für die vorhandene Windows-Entwicklungsumgebung vorbereitet. Die Build- und Testausgaben entstehen unter `build/`; bestehende versionierte Archive dürfen nicht überschrieben werden. Die Tests ersetzen keine Prüfung am realen Gerät. Technische Details zum Protokoll und zu den Grenzen stehen in [PAIRING-TECHNIK.md](PAIRING-TECHNIK.md).

Android Studio kann das Projekt zum Entwickeln öffnen und eine eigene Debug-APK erstellen. Eine eigene Debug-Signatur ist eine andere Identität: Sie aktualisiert die getestete Installation nicht und ihre APK wird vom Adapter nicht als der freigegebene Build akzeptiert. Den privaten Signaturschlüssel des Releaseinhabers niemals kopieren oder veröffentlichen.
