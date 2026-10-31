# Guardian: Kopplung und Portauskunft

Diese Notizen beschreiben den erprobten Prototyp 0.6.0 und keine veröffentlichte Schnittstellengarantie. Die Bedienung steht in [README.md](README.md).

## Kopplung

Der Adapter erzeugt den gemeinsamen Zufallsschlüssel und speichert ihn zunächst geschützt mit ausgeschalteter Guardian-Portsuche. Ein Instanzneustart nach dieser Speicherung setzt die Kopplung nicht automatisch fort. Erst eine weitere ausdrückliche Bedienung im Adapter und ein einmalig freigegebenes, höchstens 60 Sekunden offenes Fenster in Guardian erlauben die Übertragung.

Der Android-Provider ist exportiert, aber die verwendeten Methoden prüfen die Android-Shell-UID. Zuvor prüft der Adapter die freigegebene APK und die Identität des regulär gekoppelten Handys. Ein an eine frische Transaktionskennung gebundener Binder-Datenstrom transportiert den Schlüssel über die Standardeingabe der bestehenden ADB-Verbindung. Er wird nicht als Befehlsargument übergeben. Das Telefon hält ihn zunächst nur im Speicher; erst ein Commit innerhalb desselben Fensters kann die Portkonfiguration speichern. Die App verweigert die Erstkopplung, falls bereits eine Portkonfiguration oder entsprechende Reste vorhanden sind.

Abbruch, Aktivitätspause, Fristablauf, Stoppen des Dienstes, Prozessende oder Neustart verwerfen die noch nicht übernommene Vorbereitung. Vor dem Speichern prüft Guardian unter Sperre erneut den Dienstzustand, die Frist, die Berechtigungen und eine vorhandene Konfiguration. Ein Speicherfehler wird als unklarer Ausgang behandelt. Ein erfolgreiches Speichern ist keine Bestätigung eines laufenden Netzwerkdienstes. Die Adapterseite prüft anschließend die authentifizierte Portantwort und erneut das gekoppelte Gerät, bevor sie die Portsuche aktiviert. Bei fehlender Bestätigung erfolgt keine automatische Wiederholung.

Der separate synthetische Test verwendet einen festen künstlichen Wert und speichert weder Schlüssel noch Portfreigabe. Der lesende Portstatus meldet nur Kategorien; er kann nach einem Speicherfehler die Dauerhaftigkeit eines vorausgegangenen Löschvorgangs nicht allein beweisen. Die Wiederherstellung verlangt daher die ausdrücklich vom Nutzer ausgelöste und erfolgreich bestätigte Abschaltung in Guardian sowie den gesonderten Wiederherstellungsschritt im Adapter.

## WLAN-Portauskunft

Bei gültiger Freigabe bindet Guardian den UDP-Dienst an die aktuelle WLAN-IPv4-Adresse und nimmt nur Nachrichten von der konfigurierten privaten ioBroker-Adresse an. Zusätzlich authentifiziert das Protokoll beide Seiten mit HMAC-SHA256 und frischen Zufallswerten. Die Quell-IP-Filterung allein ist keine Authentifizierung. Eine akzeptierte Anfrage kann Androids lokale Suche nach dem eigenen `_adb-tls-connect._tcp`-Dienst starten. Bei fehlendem oder mehrdeutigem Ergebnis wird kein Port bestätigt. Ein WLAN-Wechsel beendet die alte Bindung.

Die Antwort enthält nur einen Port, keine Fahrzeugdaten. Die Portnummer und Multicast-Suche sind im lokalen Netzwerk beobachtbar; das Protokoll schützt nicht vor einer Dienstblockade oder vor Zugriff durch privilegierte Host- oder Geräteadministratoren. Die reguläre ADB-Kopplung und die Geräteidentitätsprüfung bleiben erforderlich.

Der Guardian-Dienst kann auf unterstützten Versionen bei verbundenem WLAN versuchen, das Debugging wieder einzuschalten. Er umgeht keine Android-Systemdialoge und verwaltet keine ADB-Schlüssel. Nach begrenzten Versuchen wartet er auf eine manuelle oder von Android erteilte Freigabe. Eine aktivierte Debugging-Einstellung beweist weder eine erreichbare ADB-Verbindung noch frische Fahrzeugdaten.

## Pflege und Prüfung

Der getestete APK-Hash ist im Adapter fest hinterlegt. Änderungen an Quellcode, Build oder Signatur erfordern eine neue, geprüfte und zum Adapter passende Freigabe; eine selbst gebaute APK wird nicht allein wegen gleicher Versionsnummer akzeptiert. Signierschlüssel, echte Schlüssel, Geräteansichten und Konfigurationsdaten nicht in Veröffentlichungen übernehmen. Vor einer allgemeinen Veröffentlichung sind Gerätekompatibilität, Abbruch- und Wiederherstellungsszenarien, Berechtigungsentzug, Netzwerkwechsel sowie Updates und Rollback erneut zu prüfen.
