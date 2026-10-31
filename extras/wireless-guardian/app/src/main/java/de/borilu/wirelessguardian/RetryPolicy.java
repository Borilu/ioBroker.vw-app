package de.borilu.wirelessguardian;

/** Independent retry budget; persisted attempt counts are owned by the service. */
final class RetryPolicy {
    private static final long[] DELAYS = { 30_000, 60_000, 120_000, 120_000 };
    static long waitMillis(int attempts, long lastAttempt, long now) {
        if (attempts <= 0) return 0;
        // Clock changes into the past conservatively restart the wait, rather than allowing a write.
        long elapsed = Math.max(0, now - lastAttempt);
        return Math.max(0, DELAYS[Math.min(attempts, DELAYS.length) - 1] - elapsed);
    }
    private RetryPolicy() {}
}
