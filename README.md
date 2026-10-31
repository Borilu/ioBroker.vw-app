# Isolierter HTTPS-Admin-Pilot

**Prüfstand, keine Freigabe für die laufende Anlage.** Der CLI-Treiber, die ioBroker-Integration und die genaue Login-Weiterleitung wurden nicht mit einer echten Instanz ausgeführt. Die Netzfreigabe `lan` ist experimentell; sie ist kein Teil des vorbereiteten Loopback-Tests und darf ohne gesonderte Prüfung nicht verwendet werden.

Die normalen Admin-Instanzen, vorhandenen Zertifikate und die Fahrzeugadapter sollen unverändert bleiben. Eine zweite Admin-Instanz nutzt dieselbe Datenbank; sie ist keine isolierte ioBroker-Umgebung. Laut installiertem Controller-Code lädt `iobroker add admin` gemeinsame Admin-Dateien erneut hoch. Die Auswirkungen dieses Uploads sind vor dem praktischen Einsatz gesondert zu bewerten.

## Verhalten

Ein Aufruf ohne `--execute` führt nichts aus. `stage` prüft freie Instanz/Port, Dateien, Zertifikate und Aliasfreiheit, journalisiert vor jedem Schreibschritt und legt die neue Instanz zunächst deaktiviert an. Danach setzt er Authentifizierung, HTTPS, Bindung `127.0.0.1` und Logstufe INFO, ergänzt genau zwei zufällige neue Zertifikatsnamen mit Dateipfaden und überprüft den Zustand erneut. Er gibt weder Zertifikatobjekte noch Schlüssel aus.

`start` überprüft diese Bedingungen erneut und startet nur auf Loopback. Anschließend werden ein echter TLS-Handshake, IP-SAN, explizit gepinntes Vertrauenszertifikat und gepinnter Serverfingerabdruck geprüft. Falscher Name und leerer Vertrauensspeicher müssen aus dem jeweils korrekten Zertifikatsgrund scheitern; nach jeder Negativprüfung folgt erneut ein gültiger Handshake. Bei Verbindungsabbruch gilt die Prüfung als unklar. Anonyme HTTP-Abfragen prüfen `/auth`, `/session` und eine Weiterleitung zur Loginseite. **Diese HTTP-Indizien beweisen nicht, dass alle echten Admin-Endpunkte oder WebSocket-Befehle geschützt sind.** Der Ergebnisstatus lautet deshalb ausdrücklich `loopback_tls_verified_auth_unproven`; er ist keine Freigabe zur Anmeldung oder Netzöffnung. Falls die Start-CLI erfolgreich antwortet und ein nachfolgender Test misslingt, wird der Pilot genau einmal gestoppt. Ein gesetztes HTTPS-Flag allein ist kein Nachweis.

`stop` wirkt nur auf eine Instanz mit dem zur Journaldatei passenden Pilot-Marker und eindeutig bestätigter Startreihenfolge. Eine nur vorbereitete und nie gestartete Instanz ist bereits deaktiviert; für sie wird kein frischer Stopp behauptet oder angefordert. Der Ablauf beobachtet zweimal einen frischen, bestätigten `.alive=false`-Zustand, das Fehlen eines eigenen nichtkompakten Admin-Prozesses und das Fehlen sämtlicher gegenüber dem Vorher-Snapshot neu aufgetretener TCP-Listener, einschließlich eines möglichen Ausweichports. Schon vor Erstellung wird geprüft, dass kein alter Prozess mit derselben Instanzkennung läuft. Unbeteiligte neue Listener blockieren konservativ. Der SSH-Benutzer darf die Dateideskriptoren des ioBroker-Dienstes nicht lesen; die Listener lassen sich deshalb nicht direkt einem PID zuordnen. Trotz dieser Indizien ist die Beobachtung keine atomare Garantie gegen einen verspäteten Controllerauftrag. Das Ergebnis heißt `stop_observed_entries_retained`, nicht endgültiger Nachweis. Zertifikatsnamen und Dateien bleiben erhalten.

Der Pilot-CLI und das Modul bieten absichtlich **keinen** LAN-Aufruf. Ohne zusätzlichen Schutz kann ein späterer Dienststart vor der TLS-Prüfung erreichbar sein oder nach einem unklaren Abbruch fortbestehen. Ein unabhängiger, ausfallsicherer Netzfilter steht für den aktuellen SSH-Nutzer nicht zur Verfügung. Niemand darf ein Passwort eingeben, bevor TLS und die Anmeldung tatsächlich vollständig geprüft sind.

## Beispiel für eine lokale, vertrauliche Konfiguration

Die Werte sind schematisch; weder diese Beispiele noch Testschlüssel sind für eine echte Instanz verwendbar. Konfigurationsdatei und existierendes Journalverzeichnis müssen dem ausführenden Linux-Benutzer gehören und die Rechte `0600` bzw. `0700` haben. Nur Pfade zu PEM-Dateien, niemals private Schlüssel selbst eintragen.

```json
{
  "journalDir": "/home/operator/private-pilot",
  "pilot": {
    "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "instance": 17,
    "port": 19081,
    "bind": "127.0.0.1",
    "expectedIp": "192.168.0.2",
    "publicAlias": "pilot_pub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "privateAlias": "pilot_key_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "publicPath": "/home/operator/pilot-files/server.pem",
    "privatePath": "/home/operator/pilot-files/server.key",
    "caPath": "/home/operator/pilot-files/server.pem",
    "caSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "serverCertSha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "serviceUid": 1001,
    "serviceGid": 1001,
    "trustMode": "leaf"
  }
}
```

Bei `leaf` muss `caPath` das exakt identische, selbstsignierte `CA:FALSE`-Serverzertifikat enthalten. `caSha256` ist der SHA-256 der unveränderten PEM-Datei; `serverCertSha256` der SHA-256 des DER-kodierten Serverzertifikats. Die tatsächliche VM-IP muss im Zertifikat als IP-SAN stehen, auch wenn beim ersten Test nur Loopback genutzt wird.

Der private Schlüssel darf ausschließlich entweder dem ioBroker-Dienstbenutzer mit `0600` gehören oder dem ausführenden Benutzer mit Gruppe des ioBroker-Dienstes und `0640`. Der Code prüft Dienstbenutzer/Gruppen sowie Lesbarkeit sämtlicher Pfadkomponenten; privilegierte Hostnutzer und andere Prozesse unter dem ioBroker-Dienstbenutzer können weiterhin zugreifen. Der prüfende Benutzer muss den Schlüssel ebenfalls lesen können. Alle Verzeichnisse und Dateien dürfen keine symbolischen Links enthalten. Das Zertifikat und die CA-Datei sind öffentlich; der Schlüssel und das ausführliche Zertifikatobjekt dürfen nicht in Terminal, Protokollen oder Chat erscheinen.

```text
node pilot.cjs stage /absolute/path/pilot-config.json --execute
node pilot.cjs start /absolute/path/pilot-config.json --execute
node pilot.cjs stop  /absolute/path/pilot-config.json --execute
```

Die ausführende Person muss vorher Instanznummer und Port eindeutig reservieren und für die gesamte kurze Einrichtung sicherstellen, dass keine andere Person, kein Adapter und kein Dienst die Zertifikatsverwaltung gleichzeitig verändert. Die derzeit installierte Datenbankimplementierung schreibt `system.certificates` mittels Read/Modify/Write ohne atomaren Vergleich. Vorher-/Nachher-Digests erkennen manche Konflikte, verhindern aber keinen verlorenen konkurrierenden Schreibvorgang. Bei der Bestandsprüfung wurden kein ACME-/Zertifikatsadapter, kein passender automatischer Prozess und kein Timer gefunden; ein anderer privilegierter Akteur bleibt möglich.

Die installierte Webserver-Bibliothek kann ein Zertifikatobjekt einschließlich Serverschlüssel auf DEBUG ausgeben. Die Pilotinstanz ist deshalb ausdrücklich auf INFO festgelegt; auch übergeordnete Konfiguration und fremde Logweiterleitungen sind vor dem Start auf Debug zu prüfen. Unzulässige oder verdächtige Protokolle keinesfalls ungefiltert ausgeben.

## Unterbrechung und Rückfall

Vor jedem möglicherweise schreibenden Schritt steht eine dauerhafte `*_attempting`-Phase. Ein Fehler oder Abbruch lässt die separate Verzeichnissperre stehen; keine Wiederholung, keine manuelle Löschung der Sperre und kein Neustart auf Verdacht. Zunächst gezielt prüfen, ob noch ein CLI-/Controllerauftrag läuft, welche Phase dauerhaft vorliegt und ob die Instanz den exakten Pilot-Marker sowie die erwarteten Zertifikatsnamen trägt. Nur bei eindeutiger Zuordnung und erledigtem vorherigen Auftrag kann die einzelne Pilotinstanz kontrolliert gestoppt und deren Portfreigabe überprüft werden. Im unklaren Fall ist sie ausschließlich auf Loopback konfiguriert; andere Instanzen, Zertifikate und Schlüssel nicht anfassen.

Ein Prozess kann zwischen abgeschicktem `start` und seiner Antwort abbrechen. Der tatsächliche Zustand ist dann nicht aus dem Exitcode ableitbar. Das Journal und die Sperre verlangen eine gezielte Untersuchung; ein automatischer Stopp könnte einen verspäteten Start überholen. Im LAN-Experiment wäre dies besonders kritisch; daher ist dieses Experiment noch nicht freigegeben.

## Prüfstand

Die Tests verwenden synthetische ioBroker-Treiber und temporäre Testzertifikate. Sie prüfen unter anderem bestehende Einträge, Alias- und Portkollisionen, unklare Schreibaufrufe, Zertifikatskonflikte, erneute TLS-/Auth-Prüfung, einmaligen Stopp sowie echte TLS-Positiv-/Negativtests. Sie belegen **nicht** die CLI-Semantik auf der VM, die tatsächliche Admin-Anmeldung, die Betriebssystemrechte oder die Abwesenheit konkurrierender Änderungen.

```powershell
$env:OPENSSL_BIN = 'C:\Program Files\Git\usr\bin\openssl.exe'
node --test provision.test.cjs tls-probe.test.cjs stop-evidence.test.cjs
```
# Experimental HTTP/1.1 CI control

The disposable controller integration test explicitly sets `native.http2=false` only on its own disabled marked synthetic instance. It then starts it, checks the instance value, offers both `h2` and `http/1.1` to the real test server and rejects an `h2` negotiation. It retains the existing pinned TLS identity/trust negative checks and the synthetic unauthenticated socket negative control. The ALPN check is one observation of that test instance and is not proof about any other connection, browser, installation, or production service. No live instance is changed. The isolated job and its HTTP/1.1 extension must succeed before considering any separate live change.

