# Beta-Kandidat 0.12.0-beta.1

Dieser Stand ist ein **unveröffentlichter Prüfstand**, keine fertige Veröffentlichung. Er ergänzt den Adapter um die optional freigegebene Android-App Wireless Guardian, eine geschützte Ersteinrichtung und eine Wartungspause für geplante Arbeiten. Die bisherigen Fahrzeugfunktionen benötigen Guardian nicht.

Der getestete Guardian-Build ist nicht im Quellcode oder npm-Paket enthalten. Vor einer späteren Freigabe muss die geprüfte APK als separates Releaseasset bereitgestellt werden. Für den getesteten Stand gilt:

- APK-SHA-256: `7af7fcf134919c54db0004fbe31d6646fa90822649e9656509a3019ee1886b30`
- Öffentliches Signaturzertifikat, SHA-256: `cbdf2b8619574944d52f64d6eac38fbf8ad9dac637c61e496c7c385254c50257`
- Die Signatur der lokal geprüften APK ist gültig. Ein neuer Build mit gleicher Versionsnummer kann eine andere Prüfsumme haben und wird bei der Kopplung abgelehnt.

Die automatische Kopplung und Wiederverbindung wurden auf einem Android-16-Testgerät geprüft. Das ist kein Nachweis für andere Geräte, WLAN-Umgebungen oder dauerhafte unbeaufsichtigte Funktion. Beim Start können zunächst Fehlversuche auftreten; Android kann weiterhin eine Geräteentsperrung oder eine Netzwerkfreigabe verlangen.

Auf dem Moto-Testgerät wurde die zuvor entzogene Android-Sonderberechtigung mit dem Adapterknopf einer früheren Testfassung erfolgreich neu erteilt und unabhängig überprüft. Das ersetzt keinen Test einer vollständig neuen Installation. Die nachträglich gehärteten Abbruch- und Fehlerpfade sind bislang nur künstlich getestet.

**Einschränkung für den Prüfstand:** Ein Steuerhandy darf nur von genau einer Adapterinstanz auf einem einzigen Host verwendet werden. Die Sperrvermerke für unklare Berechtigungs- und Kopplungsvorgänge gelten nur pro Instanz; sie verhindern keinen parallelen Versuch einer anderen Instanz oder eines anderen Hosts. Sie dürfen nicht durch Löschen, Zurückspielen eines Backups oder Wechsel der Instanz umgangen werden. Ein allgemein sicherer Wiederherstellungsweg und eine hostübergreifende Absicherung sind noch nicht nachgewiesen.

**Isolierter Runtime-Prototyp:** Bei ungeklärten Android-Aufträgen hält ein dauerhafter, instanzlokaler Marker weitere Aufträge an; Android-Shellaufrufe benötigen einen Abschlussnachweis. Dieser kombinierte Stand ist noch nicht am echten Gerät geprüft und kein veröffentlichungsfähiger Beta-Stand. Er schützt nicht vor anderen Instanzen, Hosts oder bereits autorisierten fremden ADB-Clients.

**Bestehende Installationen:** Ein fehlender neuer Marker beweist nicht, dass ein früherer Auftrag abgeschlossen ist. Alte Guardian-Bestätigungen können nicht automatisch als sicher migriert werden und werden vorsorglich gesperrt; dies betrifft auch die bisherige Moto-Testinstanz. Es gibt noch keinen nachgewiesen sicheren Ablauf zur Wiederherstellung oder Migration. Vor Klärung diesen Stand nicht auf bestehenden Systemen installieren, keine Journale löschen oder zurücksetzen, keine andere Instanz als Umgehung verwenden und kein neues Guardian-Kopplungsfenster öffnen, wenn der vorherige Vorgang unklar ist.

**Benutzerprüfung im Prototyp:** Sicherheitsrelevante Einrichtungs-, Guardian-, Wartungs- und Recovery-Status-Schaltflächen bleiben bei ausgeschalteter Admin-Authentifizierung, fehlendem Benutzerkontext oder fehlender Mitgliedschaft in der Administratorgruppe gesperrt. Benötigt werden ein angemeldeter Administrator sowie ein kompatibler Admin-/Socket-Stand und js-controller ab 7.2.5. Die Überprüfung setzt vertrauenswürdige ioBroker-Komponenten voraus: Nachrichtenfelder sind kein kryptografischer Identitätsnachweis gegenüber privilegierten Adaptern. Der zusätzliche Schutz und die Anmeldewege sind noch nicht praktisch freigegeben.

Wireless Guardian benötigt `WRITE_SECURE_SETTINGS`, eine weitreichende Sonderberechtigung, und Netzwerkzugriff. Der geprüfte Code nutzt die Sonderberechtigung für drahtloses Debugging; die Portauskunft wird gesondert aktiviert und authentifiziert. Android-Debugging erlaubt gekoppelten Computern weitreichenden Zugriff auf das Handy. Auf einem Gerät ohne Bildschirmsperre sind angemeldete Konten für Personen mit physischem Zugriff zugänglich. Einrichtung, Grenzen und Wiederherstellung stehen in der [Guardian-Anleitung](../extras/wireless-guardian/README.md) und der [Adapter-Installation](INSTALLATION.de.md).

## Veröffentlichungsschutz

Ein Beta-Tag veröffentlicht dieses Paket nicht automatisch über den vorhandenen GitHub-Workflow auf npm. Der automatische Deploy-Job akzeptiert ausschließlich stabile Versionsnummern ohne Präversion. Vor jeder späteren Veröffentlichung müssen die zu veröffentlichenden APK- und Paketdateien, Signatur, Lizenz-/Datenschutzhinweise, Tests und Versionsbeziehungen gesondert geprüft werden. Die Beta-Version ist absichtlich nicht im ioBroker-Releaseverzeichnis eingetragen. Bestehende Versionen und Archive bleiben unverändert.
