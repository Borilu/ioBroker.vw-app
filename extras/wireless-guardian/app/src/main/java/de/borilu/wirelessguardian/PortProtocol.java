package de.borilu.wirelessguardian;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.util.Arrays;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/** One bounded, mutually authenticated UDP challenge; no Android dependencies. */
final class PortProtocol implements AutoCloseable {
    private final byte[] key;
    private String client, server;
    private boolean acknowledged, replied, closed;

    PortProtocol(byte[] key) {
        if (key == null || key.length != 32) throw new IllegalArgumentException("Invalid key");
        this.key = key.clone();
    }
    /** Accept one query and form challenge using a caller-generated fresh random nonce. */
    synchronized byte[] begin(byte[] packet, String freshServerNonce) {
        if (closed || client != null || packet == null || packet.length != 105 || freshServerNonce == null
                || !freshServerNonce.matches("[0-9a-f]{32}")) return null;
        String q = new String(packet, StandardCharsets.US_ASCII);
        if (!q.matches("VWAG2 Q [0-9a-f]{32} [0-9a-f]{64}")) return null;
        String candidate = q.substring(8, 40);
        if (!MessageDigest.isEqual(mac("vwapp.guardian.query.v2\n" + candidate), decodeHex(q.substring(41)))) return null;
        client = candidate; server = freshServerNonce;
        return ascii("VWAG2 C " + client + " " + server + " " + hex(mac("vwapp.guardian.challenge.v2\n" + client + "\n" + server)));
    }
    /** An old acknowledgement cannot match the fresh server nonce after restart. */
    synchronized boolean acceptAck(byte[] packet) {
        if (closed || client == null || acknowledged || packet == null || packet.length != 138) return false;
        String a = new String(packet, StandardCharsets.US_ASCII);
        if (!a.matches("VWAG2 A [0-9a-f]{32} [0-9a-f]{32} [0-9a-f]{64}")
                || !client.equals(a.substring(8, 40)) || !server.equals(a.substring(41, 73))) return false;
        if (!MessageDigest.isEqual(mac("vwapp.guardian.ack.v2\n" + client + "\n" + server), decodeHex(a.substring(74)))) return false;
        acknowledged = true; return true;
    }
    synchronized byte[] makeReply(int port) {
        if (closed || !acknowledged || replied || port < 1 || port > 65535) return null;
        replied = true; String value = Integer.toString(port);
        return ascii("VWAG2 R " + client + " " + server + " " + value + " "
            + hex(mac("vwapp.guardian.reply.v2\n" + client + "\n" + server + "\n" + value)));
    }
    private byte[] mac(String message) {
        try { Mac mac = Mac.getInstance("HmacSHA256"); mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return mac.doFinal(message.getBytes(StandardCharsets.UTF_8)); }
        catch (GeneralSecurityException error) { throw new IllegalStateException("HMAC unavailable"); }
    }
    private static byte[] ascii(String value) { return value.getBytes(StandardCharsets.US_ASCII); }
    private static byte[] decodeHex(String value) {
        byte[] out = new byte[value.length() / 2];
        for (int i = 0; i < out.length; i++) out[i] = (byte) Integer.parseInt(value.substring(i * 2, i * 2 + 2), 16);
        return out;
    }
    private static String hex(byte[] bytes) {
        char[] chars = new char[bytes.length * 2], alphabet = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) { chars[i * 2] = alphabet[(bytes[i] & 255) >>> 4]; chars[i * 2 + 1] = alphabet[bytes[i] & 15]; }
        return new String(chars);
    }
    @Override public synchronized void close() { closed = true; Arrays.fill(key, (byte) 0); client = null; server = null; }
}
