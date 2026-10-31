package de.borilu.wirelessguardian;

/** Strict canonical RFC1918 endpoint only; callers must additionally bind WLAN. */
final class PortHostPolicy {
    static boolean validHost(String input) {
        if (input == null || !input.matches("(?:0|[1-9][0-9]{0,2})(?:\\.(?:0|[1-9][0-9]{0,2})){3}")) return false;
        String[] pieces = input.split("\\."); int[] v = new int[4];
        for (int i = 0; i < 4; i++) { v[i] = Integer.parseInt(pieces[i]); if (v[i] > 255) return false; }
        return v[3] != 0 && v[3] != 255 && (v[0] == 10 || (v[0] == 172 && v[1] >= 16 && v[1] <= 31) || (v[0] == 192 && v[1] == 168));
    }
    private PortHostPolicy() { }
}
