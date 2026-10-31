package de.borilu.wirelessguardian;

/** Fixed, non-sensitive UI categories for one explicit pairing window. */
final class PairWindowStatus {
    enum Phase { NOT_OPEN, OPEN, EXPIRED, PAUSED, STOPPED, BIND_FAILED, IO_FAILED, REJECTED, TEST_DONE, PAIR_DONE, STORE_FAILED }
    private Phase phase = Phase.NOT_OPEN;
    private long deadline;

    synchronized void opened(long deadline) { this.deadline = deadline; phase = Phase.OPEN; }
    synchronized void end(Phase reason, long now) {
        if (phase == Phase.OPEN) phase = PairDeadline.active(now, deadline) ? reason : Phase.EXPIRED;
        else if (phase == Phase.NOT_OPEN) phase = reason;
    }
    synchronized Phase phase(long now) {
        if (phase == Phase.OPEN && !PairDeadline.active(now, deadline)) return Phase.EXPIRED;
        return phase;
    }
    synchronized String label(long now) {
        Phase value = phase(now);
        switch (value) {
            case OPEN: return "offen (noch " + Math.max(0, (deadline - now + 999) / 1000) + " Sekunden)";
            case EXPIRED: return "abgelaufen";
            case PAUSED: return "geschlossen, weil Guardian verlassen wurde";
            case STOPPED: return "vom Nutzer oder System geschlossen";
            case BIND_FAILED: return "konnte nicht geöffnet werden";
            case IO_FAILED: return "wegen eines lokalen Verbindungsfehlers geschlossen";
            case REJECTED: return "nach abgelehnten Verbindungsversuchen geschlossen";
            case TEST_DONE: return "Diagnosetest abgeschlossen; kein Schlüssel gespeichert";
            case PAIR_DONE: return "Schlüssel auf dem Handy gespeichert; ioBroker muss noch bestätigen";
            case STORE_FAILED: return "Speicherstatus unklar; Portauskunft in Guardian prüfen und gegebenenfalls ausschalten";
            default: return "nicht geöffnet";
        }
    }
}
