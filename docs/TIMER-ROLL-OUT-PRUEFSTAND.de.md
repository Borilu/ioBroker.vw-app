# Prüfstand: Timer-Rückkehr auf bestehender Installation

Dieser Stand ist nicht für die allgemeine Veröffentlichung oder Installation
freigegeben. Die Timer-Rückkehr und der neue Laufzeitzaun müssen zusammen
übernommen werden. Der Zaun erfasst nur Aufträge, die nach seiner Aktivierung
begonnen wurden. Ein fehlender Marker ist kein Nachweis dafür, dass ein älterer
Android-Auftrag beendet ist. Das Abschalten des lokalen ADB-Clients allein
beweist insbesondere nicht, dass die Gegenstelle den Auftrag beendet hat.

Vor einer erstmaligen Übernahme muss ein exklusives Wartungsfenster bestehen:

1. Den unveränderten Ausgangsstand und die Konfiguration sichern. Alle Adapter,
   sonstigen ADB-Clients und externen Automationen ausschließen, die dieses
   Handy bedienen können. Keine gespeicherten Fahrzeugwünsche ausführen.
2. Laufende und bereits zeitlich unklare ältere Aufträge auf dem Host und auf
   Android aufklären und nachweislich beenden. Ein kontrollierter Neustart des
   Handys bei angehaltener Steuerung kann dafür ein Baustein sein; er ersetzt
   weder die Prüfung des Hosts noch der übrigen Clients und Einrichtungsjournale.
3. Vorhandene Guardian-Kopplungen, Einrichtungs- und Sicherheitsjournale prüfen.
   Unklare Vorgänge nicht als erfolgreich behandeln und keine Marker löschen.
   Die bestehende Guardian-Konfiguration und Authentifizierung werden durch
   diesen Prüfstand nicht migriert oder automatisch zurückgesetzt.
4. Erst nach einer unabhängig geprüften, dokumentierten Stillstandsprüfung den
   neuen Stand einspielen und eine einzelne lesende Abfrage kontrollieren. Ein
   vollständiger Rundlauf muss anschließend alle vorhandenen Lesebereiche mit
   ihren eigenen Erfolgszeiten und Qualitätszuständen aktualisieren. Ein
   ausgelesener App-Wert beweist keine neue Fahrzeugtelemetrie.

Dieser Ablauf ist noch nicht praktisch erprobt und stellt keine automatisierte
Migration dar. Bei unklarer Stillstands- oder Auftragslage bleibt die Instanz
angehalten. Nach Aktivierung blockiert ein bleibender Laufzeitmarker weitere
Handyaufträge, bis seine Ursache sicher untersucht und geklärt wurde. Es gibt
hierfür in diesem Prüfstand keine automatische Rücksetzung.
