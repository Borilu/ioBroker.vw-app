package de.borilu.wirelessguardian;

public final class RetryPolicyTest {
    private static void expect(long actual, long expected) {
        if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        expect(RetryPolicy.waitMillis(0, 0, 0), 0);
        expect(RetryPolicy.waitMillis(1, 1000, 1000), 30000);
        expect(RetryPolicy.waitMillis(1, 1000, 11000), 20000);
        expect(RetryPolicy.waitMillis(1, 1000, 31000), 0);
        expect(RetryPolicy.waitMillis(2, 1000, 1000), 60000);
        expect(RetryPolicy.waitMillis(3, 1000, 1000), 120000);
        expect(RetryPolicy.waitMillis(4, 1000, 1000), 120000);
        expect(RetryPolicy.waitMillis(4, 1000, 500), 120000);
        System.out.println("RetryPolicy tests passed");
    }
}
