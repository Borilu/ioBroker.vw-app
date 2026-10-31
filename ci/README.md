# Isolierter Controller- und Socket-Test

**Vorbereitet, bisher nicht bei GitHub ausgeführt.** Dieser lokale Prüfstand ist kein Release und kein Beleg für die Funktion auf der tatsächlichen VM oder in Edge. Das Workflow-Beispiel liegt im eigenen lokalen Repository; es wurde nichts gepusht oder veröffentlicht.

## Prüfumfang

Die Workflow-Datei startet auf einem kurzlebigen GitHub-Runner einen separaten ioBroker-Docker-Container ohne Host-Portfreigabe, Bind-Mounts und Anmeldedaten. Die Docker-Version `v12.0.0` unterstützt laut Image-Dokumentation Node 24; ihr amd64-Manifest ist auf den bei Docker Hub veröffentlichten SHA-256-Digest festgelegt. Im Wegwerfcontainer werden anschließend js-controller **7.2.5** und Admin **8.3.5** per npm installiert. Der Test prüft zusätzlich die in ioBroker registrierte Admin-Version und die tatsächlich von Admin aufgelösten Versionen von `@iobroker/socket-classes` **2.10.0**, `@iobroker/ws-server` **4.5.2**, `@iobroker/webserver` **3.4.0** sowie das für ws-server aufgelöste `ws` **8.22.0**; bei Abweichung wird abgebrochen. Transitive npm-Abhängigkeiten sind nicht vollständig lockfile-gepinnt; weitere Abhängigkeiten können abweichen.

Während der Image-/npm-Installation ist der Container am Bridge-Netz; anschließend wird er davon getrennt. Vor dem Test prüft der Workflow Mounts, Portfreigaben und Docker-Privilegierung; das Skript prüft zusätzlich explizite CI-Markierungen, Benutzer, Hostname und ausschließlich interne Netzinterfaces. Diese Schutzmerkmale mindern Fehlbedienung, sind aber keine beweissichere Attestierung gegen einen manipulierten Docker-Host. Die Prüfung läuft per `docker exec` und Loopback; weder Anwendergeräte noch die produktive ioBroker-VM, Nutzerdaten oder Konten sind eingebunden. Das temporäre Zertifikat, der Schlüssel und die IP sind ausschließlich synthetisch. Der Container wird anhand seines eindeutigen Namens und zufälligen Labels mit eigenen anonymen Volumes entfernt; ein abgebrochener GitHub-Runner kann Cleanup jedoch verhindern.

Der reale Pilot würde ein neues deaktiviertes Admin-Objekt erstellen, ausschließlich auf Loopback starten, TLS/öffentliche Teilindikatoren prüfen und kontrolliert stoppen. Der Socket-Test verwendet das tatsächlich installierte `@iobroker/ws-server`-Protokoll: Ohne Token müssen `reauthenticate` und `___ready___` eintreffen; eine harmlose Anfrage mit leerem Token belegt zweimal die Socket-Lebendigkeit. Dazwischen wird ein lesender Zugriff auf **den Alive-Zustand der synthetischen Testinstanz** versucht. Ein ausdrückliches `permissionError` wird unterschieden von einem innerhalb des Beobachtungsfensters ausbleibenden Callback. Verbindungsabbrüche, unerwartete Zustandsdaten, ungültige Zertifikate und fehlende Kontrollantworten führen zum Fehler.

Für die tatsächlich von Admin aufgelöste `@iobroker/webserver`-Version 3.4.0 wurde anhand des Quellcodes bestätigt, dass fehlende Zertifikate einen HTTP-Rückfall auslösen und Debug-Serialisierung den privaten Serverschlüssel erfassen kann. Der Pilot verlangt deshalb INFO für seine Instanz, der CI-Test blockiert explizite globale Debug-/Silly-Vorgaben; der Verbindungstest verlangt trotzdem echtes TLS. Im Wegwerfcontainer sind nur synthetische Schlüssel enthalten. Kein Debug-Log oder vollständiges Zertifikatobjekt wird ausgegeben. Diese Kontrollen ersetzen vor einem späteren echten Einsatz nicht die Prüfung weiterer Logtransport- und Host-Einstellungen.

Als Negativkontrolle schaltet der Test **nur im Wegwerfcontainer** die Testinstanz nach dem ersten Stopp explizit auf `auth=false`, startet sie und prüft, dass derselbe Alive-Zustand nun tatsächlich lesbar ist. Die unauthentifizierte Sicherheitsprobe muss diese unsichere Gegenprobe ablehnen. Anschließend wird die Wegwerfinstanz gestoppt. Weder das Umschalten noch die negative Kontrolle dürfen auf der produktiven VM ausgeführt werden.

Der Socket-Test untersucht einen einzelnen repräsentativen `getState`-Aufruf und nur ein begrenztes Zeitfenster. Schweigen ist keine lückenlose Garantie, dass später nie eine Antwort oder auf einem anderen Endpunkt Daten geliefert werden. Der Probe-Status ist deshalb weiterhin **keine vollständige Authentifizierungsfreigabe** und erlaubt weder LAN-Freigabe noch Passworteingabe.

## Workflow-Sicherheit und Ausführung

Der vorbereitete Workflow besitzt ausschließlich `contents: read`, speichert keine Checkout-Credentials, verwendet keine Secrets, hat keinen Schreib-/Publish-/Release-Job und wird nur manuell oder durch den speziell benannten Branch `ci/https-pilot-*` ausgelöst. Ein solcher Branch wäre in einem öffentlichen Repository sichtbar. Der übergeordnete Agent entscheidet separat, ob/wie der geprüfte Stand dorthin übertragen wird. **Keine** echten Zertifikate, PEM-Dateien, Schlüssel, ioBroker-Konfigurationen, FIN, S-PIN oder Fahrzeugansichten hochladen. Der vorhandene Adapter-Releaseworkflow muss separat darauf geprüft werden, dass ein Testbranch keinen Tag/Release auslöst.

Auf diesem Windows-PC existieren kein WSL und kein Docker; auf der produktiven VM fehlen Docker/Podman und funktionierende unprivilegierte Namespaces. Deshalb darf der echte Controller-Test dort nicht ersatzweise gestartet werden. Die vorbereitete Docker-/npm-Installation und CLI-Semantik konnten hier nur anhand offizieller Quellen und der verfügbaren Paket-/Tag-Metadaten geprüft werden, nicht durch einen echten Lauf.

Lokal wurden die Socket-Tests mit einem temporär bezogenen `ws`-Testpaket und synthetischem TLS-Server geprüft: gesicherte Gegenstelle mit ausbleibender Antwort, explizite Ablehnung, unerlaubte Datenfreigabe, Abbruch, falsches Zertifikat und positive ungesicherte Kontrolle. Diese Tests benutzen keine ioBroker-Instanz.

Zum lokalen Nachstellen mit vorhandenen Testabhängigkeiten:

```powershell
$env:OPENSSL_BIN = 'C:\Program Files\Git\usr\bin\openssl.exe'
$env:WS_FIXTURE_PATH = '<absoluter Pfad zum temporären ws-Paket>'
node --test provision.test.cjs tls-probe.test.cjs stop-evidence.test.cjs ci/auth-socket-probe.test.cjs
```

Ein erfolgreicher späterer CI-Lauf muss einzeln auf exakte Versionen, bereitgestellte isolation, alle Teiltests und vollständiges Cleanup geprüft werden; ein Workflowstart allein beweist nichts. Er ersetzt keine unabhängige Prüfung des globalen Zertifikatobjekts und keinen Test des konkreten Windows-/VM-Zugangs.
