package de.borilu.wirelessguardian;

/** Deliberately narrow: API 36 support is experimental. */
final class VersionPolicy {
    static boolean supported(int api) { return api == 31 || api == 32 || api == 36; }
    static boolean ready(int api, boolean permission, boolean optedIn, boolean visible, boolean userStopped) {
        if (!supported(api) || !permission) return false;
        return api != 36 || (optedIn && visible && !userStopped);
    }
    static boolean stopAfterOptIn(long optIn, int reason, long exitAt, int userRequestedReason) {
        return optIn <= 0 || (reason == userRequestedReason && exitAt >= optIn);
    }
    private VersionPolicy() {}
}
