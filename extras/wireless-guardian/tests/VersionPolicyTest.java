package de.borilu.wirelessguardian;

public final class VersionPolicyTest {
    private static void check(boolean actual, boolean expected) {
        if (actual != expected) throw new AssertionError("Expected " + expected + ", got " + actual);
    }
    public static void main(String[] args) {
        for (int api = 29; api <= 38; api++) check(VersionPolicy.supported(api), api == 31 || api == 32 || api == 36);
        check(VersionPolicy.ready(31, true, false, false, true), true);
        check(VersionPolicy.ready(32, true, false, false, true), true);
        check(VersionPolicy.ready(36, true, true, true, false), true);
        check(VersionPolicy.ready(36, false, true, true, false), false);
        check(VersionPolicy.ready(36, true, false, true, false), false);
        check(VersionPolicy.ready(36, true, true, false, false), false);
        check(VersionPolicy.ready(36, true, true, true, true), false);
        check(VersionPolicy.ready(35, true, true, true, false), false);
        check(VersionPolicy.stopAfterOptIn(100, 10, 99, 10), false);
        check(VersionPolicy.stopAfterOptIn(100, 10, 100, 10), true);
        check(VersionPolicy.stopAfterOptIn(100, 10, 101, 10), true);
        check(VersionPolicy.stopAfterOptIn(100, 2, 101, 10), false);
        check(VersionPolicy.stopAfterOptIn(0, 2, 101, 10), true);
        System.out.println("VersionPolicy tests passed");
    }
}
