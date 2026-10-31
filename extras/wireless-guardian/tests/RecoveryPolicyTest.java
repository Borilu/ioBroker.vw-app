package de.borilu.wirelessguardian;

public final class RecoveryPolicyTest {
    private static void expect(boolean actual, boolean expected) {
        if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        expect(RecoveryPolicy.isWaitingForUser(0), false);
        expect(RecoveryPolicy.isWaitingForUser(3), false);
        expect(RecoveryPolicy.isWaitingForUser(4), true);
        expect(RecoveryPolicy.isWaitingForUser(5), true);
        String oldFailure = "Aktivierung nicht bestätigt. WLAN-Freigabe und Entwickleroptionen prüfen; dann manuell neu starten.";
        expect(RecoveryPolicy.isLegacyRetryFailure(false, oldFailure, 4), true);
        expect(RecoveryPolicy.isLegacyRetryFailure(false, oldFailure, 3), false);
        expect(RecoveryPolicy.isLegacyRetryFailure(true, oldFailure, 4), false);
        expect(RecoveryPolicy.isLegacyRetryFailure(false, "Überwachung ausgeschaltet", 4), false);
        expect(RecoveryPolicy.isLegacyRetryFailure(false, "", 4), false);
        expect(RecoveryPolicy.isLegacyRetryFailure(false, null, 4), false);
        expect(RecoveryPolicy.canResetBudget(4, 1000, 300999), false);
        expect(RecoveryPolicy.canResetBudget(4, 1000, 301000), true);
        expect(RecoveryPolicy.canResetBudget(4, 1000, 500), false);
        expect(RecoveryPolicy.canResetBudget(0, 1000, 301000), false);
        expect(RecoveryPolicy.canResetBudget(4, 0, 301000), false);
        if (RecoveryPolicy.offAction(3, 1000, 121000) != RecoveryPolicy.OffAction.ATTEMPT)
            throw new AssertionError("A permitted attempt after its backoff was not offered");
        for (long now = 1000; now < 20_000_000; now += 437) {
            if (RecoveryPolicy.offAction(4, 1000, now) == RecoveryPolicy.OffAction.ATTEMPT)
                throw new AssertionError("Event storm or restart permitted a fifth write");
        }
        if (RecoveryPolicy.offAction(0, 0, 301000) != RecoveryPolicy.OffAction.ATTEMPT)
            throw new AssertionError("Attempts did not resume after a stable-on budget reset");
        System.out.println("RecoveryPolicy tests passed");
    }
}
