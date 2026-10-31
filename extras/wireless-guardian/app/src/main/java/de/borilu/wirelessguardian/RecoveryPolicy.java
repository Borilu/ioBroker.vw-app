package de.borilu.wirelessguardian;

/** Pure decisions for the retry lock and the one-time 0.1.0 migration. */
final class RecoveryPolicy {
    enum OffAction { WAIT_BACKOFF, WAIT_USER, ATTEMPT }
    static final String LEGACY_RETRY_FAILURE = "Aktivierung nicht bestätigt. WLAN-Freigabe und Entwickleroptionen prüfen; dann manuell neu starten.";
    static boolean isWaitingForUser(int attempts) { return attempts >= 4; }
    static OffAction offAction(int attempts, long lastAttempt, long now) {
        if (RetryPolicy.waitMillis(attempts, lastAttempt, now) > 0) return OffAction.WAIT_BACKOFF;
        if (isWaitingForUser(attempts)) return OffAction.WAIT_USER;
        return OffAction.ATTEMPT;
    }
    static boolean canResetBudget(int attempts, long onSince, long now) {
        return attempts > 0 && onSince > 0 && now >= onSince && now - onSince >= 300_000;
    }
    static boolean isLegacyRetryFailure(boolean enabled, String status, int attempts) {
        return !enabled && isWaitingForUser(attempts) && LEGACY_RETRY_FAILURE.equals(status);
    }
    private RecoveryPolicy() {}
}
