package de.borilu.wirelessguardian;

/** Monotonic deadline; negative or invalid observations fail closed. */
final class PairDeadline {
    static boolean active(long now, long deadline) { return now >= 0 && deadline > 0 && now < deadline; }
    private PairDeadline() { }
}
