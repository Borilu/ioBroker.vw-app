package de.borilu.wirelessguardian;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Parse a bounded binary frame. Never persist or render the input. */
final class PairPayload implements AutoCloseable {
    final String host;
    final byte[] key;
    private PairPayload(String host, byte[] key) { this.host = host; this.key = key; }
    static PairPayload parse(byte[] frame, int size) {
        byte[] magic = "VWGPREP2".getBytes(StandardCharsets.US_ASCII);
        if (frame == null || size < 48 || size > 56 || frame.length < size) return null;
        for (int i = 0; i < magic.length; i++) if (frame[i] != magic[i]) return null;
        int hostLength = frame[8] & 255;
        if (hostLength < 7 || hostLength > 15 || size != 9 + hostLength + 32) return null;
        String host = new String(frame, 9, hostLength, StandardCharsets.US_ASCII);
        if (!PortHostPolicy.validHost(host)) return null;
        return new PairPayload(host, Arrays.copyOfRange(frame, 9 + hostLength, size));
    }
    @Override public void close() { Arrays.fill(key, (byte) 0); }
}
