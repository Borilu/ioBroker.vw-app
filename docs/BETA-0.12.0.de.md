# Beta-Kandidat 0.12.0-beta.1

Dieser Stand ist ein **unveröffentlichter Prüfstand**, keine fertige Veröffentlichung. Er ergänzt den Adapter um die optional freigegebene Android-App Wireless Guardian, eine geschützte Ersteinrichtung und eine Wartungspause für geplante Arbeiten. Die bisherigen Fahrzeugfunktionen benötigen Guardian nicht.

Der getestete Guardian-Build ist nicht im Quellcode oder npm-Paket enthalten. Vor einer späteren Freigabe muss die geprüfte APK als separates Releaseasset bereitgestellt werden. Für den getesteten Stand gilt:

- APK-SHA-256: `7af7fcf134919c54db0004fbe31d6646fa90822649e9656509a3019ee1886b30`
- Öffentliches Signaturzertifikat, SHA-256: `cbdf2b8619574944d52f64d6eac38fbf8ad9dac637c61e496c7c385254c50257`
- Die Signatur der lokal geprüften APK ist gültig. Ein neuer Build mit gleicher Versionsnummer kann eine andere Prüfsumme haben und wird bei der Kopplung abgelehnt.

Die automatische Kopplung und Wiederverbindung wurden auf einem Android-16-Testgerät geprüft. Das ist kein Nachweis für andere Geräte, WLAN-Umgebungen oder dauerhafte unbeaufsichtigte Funktion. Beim Start können zunächst Fehlversuche auftreten; Android kann weiterhin eine Geräteentsperrung oder eine Netzwerkfreigabe verlangen.

Wireless Guardian benötigt `WRITE_SECURE_SETTINGS`, eine weitreichende Sonderberechtigung, und Netzwerkzugriff. Der geprüfte Code nutzt die Sonderberechtigung für drahtloses Debugging; die Portauskunft wird gesondert aktiviert und authentifiziert. Android-Debugging erlaubt gekoppelten Computern weitreichenden Zugriff auf das Handy. Auf einem Gerät ohne Bildschirmsperre sind angemeldete Konten für Personen mit physischem Zugriff zugänglich. Einrichtung, Grenzen und Wiederherstellung stehen in der [Guardian-Anleitung](../extras/wireless-guardian/README.md) und der [Adapter-Installation](INSTALLATION.de.md).

## Veröffentlichungsschutz

Ein Beta-Tag veröffentlicht dieses Paket nicht automatisch über den vorhandenen GitHub-Workflow auf npm. Der automatische Deploy-Job akzeptiert ausschließlich stabile Versionsnummern ohne Präversion. Vor jeder späteren Veröffentlichung müssen die zu veröffentlichenden APK- und Paketdateien, Signatur, Lizenz-/Datenschutzhinweise, Tests und Versionsbeziehungen gesondert geprüft werden. Die Beta-Version ist absichtlich nicht im ioBroker-Releaseverzeichnis eingetragen. Bestehende Versionen und Archive bleiben unverändert.
