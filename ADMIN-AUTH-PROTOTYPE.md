# Prototyp: Benutzerprüfung für ioBroker-Admin-Aktionen

Dieser Arbeitsstand ist nicht zur Installation oder Veröffentlichung
freigegeben. Die bestehende Prüfung des Absendernamens allein identifiziert
keinen angemeldeten Menschen. Das gilt auch für den Rücksetzknopf der
S-PIN-Sicherheitssperre und für die Guardian-Sonderberechtigung.

Der Prototyp verlangt für alle Einrichtungs-, Guardian-, Wartungs- und
Recovery-Status-Nachrichten zusätzlich einen gültigen `obj.user`, einen
aktivierten Benutzer in der Gruppe `system.group.administrator` und eine
laufende, nach ihrer letzten Konfigurationsänderung neu gestartete Admin-Instanz
mit eingeschalteter Authentifizierung. Fehlende Informationen, ältere
Nachrichten ohne Benutzerkontext, nicht eindeutige Werte und Datenbankfehler
blockieren die Aktion. Die normalen Datenpunktbefehle sind nicht Teil dieser
Prüfung; sie bleiben von den ioBroker-Datenpunktberechtigungen abhängig.

Die lokale Prüfung nutzt `alive.lc` als konservativen Hinweis auf einen
Neustart nach der gespeicherten Änderung. Fehlende Zeitstempel blockieren.
Sie belegt nicht, wie ein Benutzer tatsächlich angemeldet wurde; insbesondere
müssen SSO, interne Zugänge, Reverse-Proxy-Konfiguration und die
Sitzungsabsicherung des Admin getrennt überprüft werden. Die hier gemeldete
Nutzerkennung und `from` sind keine kryptografisch signierten Angaben. Ein
privilegierter oder bösartiger ioBroker-Adapter bzw. Datenbank-/Hostzugriff
kann Nachrichtenfelder und Zustände fälschen; dagegen schützt dieser Prototyp
nicht. Für eine belastbare Freigabe ist ein entsprechendes Vertrauensmodell
oder ein zusätzlich authentifizierter Kanal erforderlich.

Ein Hinzufügen von `obj.user` erfordert laut ioBroker Socket-Klassen ab 2.7.0
und js-controller ab 7.2.5;
die passenden tatsächlich verwendeten Socket-Klassen müssen ebenfalls aktiv
sein. Die bisherigen allgemeinen Paket-Mindestversionen wurden nicht erhöht;
auf älteren Kombinationen funktionieren die betroffenen Schaltflächen mit
diesem Prototyp folglich nicht.

Tests verwenden ausschließlich künstliche Benutzer, Gruppen und Instanzen.
Eine reale Benutzeranmeldung, die Auswirkung des Admin-Neustarts, die
Absicherung interner Zugänge und das Verhalten über verschiedene Controller-
und Admin-Versionen wurden nicht praktisch geprüft.
