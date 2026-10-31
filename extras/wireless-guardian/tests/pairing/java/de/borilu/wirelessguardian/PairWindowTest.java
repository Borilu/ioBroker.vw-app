package de.borilu.wirelessguardian;
import android.app.Activity;
import android.os.SystemClock;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
public final class PairWindowTest {
    private static final String NONCE = "0123456789abcdef0123456789abcdef";
    private static void check(boolean ok) { if (!ok) throw new AssertionError(); }
    private static PairPayload frame() {
        byte[] magic = "VWGPREP2".getBytes(StandardCharsets.US_ASCII), host = "192.168.88.3".getBytes(StandardCharsets.US_ASCII);
        byte[] data = new byte[9 + host.length + 32]; System.arraycopy(magic, 0, data, 0, 8); data[8] = (byte) host.length;
        System.arraycopy(host, 0, data, 9, host.length); Arrays.fill(data, 9 + host.length, data.length, (byte) 0x42);
        return PairPayload.parse(data, data.length);
    }
    public static void main(String[] args) {
        Activity a = new Activity(); SystemClock.now = 1000;
        check(PairPayload.parse(new byte[0], 0) == null);
        check(PairWindow.portResetStatus(a).equals("inactive_closed"));
        PairPayload parsed = frame(); check(parsed != null && parsed.key.length == 32 && parsed.host.equals("192.168.88.3"));
        parsed.close(); for (byte b : parsed.key) check(b == 0);
        byte[] invalid = new byte[48]; Arrays.fill(invalid, (byte) 0x42);
        check(PairPayload.parse(invalid, 48) == null);
        byte[] magic = "VWGPREP2".getBytes(StandardCharsets.US_ASCII);
        System.arraycopy(magic, 0, invalid, 0, 8); invalid[8] = 7;
        System.arraycopy("8.8.8.8".getBytes(StandardCharsets.US_ASCII), 0, invalid, 9, 7);
        check(PairPayload.parse(invalid, 48) == null); // public IP is never accepted
        check(PairPayload.parse(invalid, 47) == null);
        check(PairPayload.parse(new byte[57], 57) == null);

        a.prefs.enabled = true; check(!new PairWindow(a, false).start()); a.prefs.enabled = false;
        a.prefs.generation = "stale"; check(!new PairWindow(a, false).start());
        check(PairWindow.portResetStatus(a).equals("not_resettable")); a.prefs.generation = null;
        PairWindow w = new PairWindow(a, false); check(w.start());
        check(PairWindow.portResetStatus(a).equals("not_resettable"));
        check(PairWindow.claim(NONCE, true) == null); check(PairWindow.claim("bad", false) == null);
        check(PairWindow.commit(NONCE).equals("closed"));
        check(PairWindow.claim(NONCE, false) == w); check(PairWindow.claim(NONCE, false) == null);
        try (PairPayload p = frame()) { w.prepare(p); }
        check(PairWindow.result(NONCE).equals("prepared"));
        check(PairWindow.commit("fedcba9876543210fedcba9876543210").equals("closed"));
        check(!a.prefs.enabled && PortSecretStore.saves == 0);
        check(PairWindow.commit(NONCE).equals("committed")); check(a.prefs.enabled && PortSecretStore.saves == 1);
        check(PairWindow.commit(NONCE).equals("closed")); w.close(PairWindowStatus.Phase.PAUSED); a.prefs.enabled = false; a.prefs.generation = null;

        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        w.close(PairWindowStatus.Phase.PAUSED); check(PairWindow.commit(NONCE).equals("closed")); check(!a.prefs.enabled);

        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        SystemClock.now += 60001; check(PairWindow.commit(NONCE).equals("closed")); check(!a.prefs.enabled);
        w.close(PairWindowStatus.Phase.EXPIRED);

        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        State.active = false; check(PairWindow.commit(NONCE).equals("closed")); check(!a.prefs.enabled);
        State.active = true; w.close(PairWindowStatus.Phase.STOPPED);

        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        PairWindow.invalidateAll();
        check(PairWindow.commit(NONCE).equals("closed")); check(!a.prefs.enabled);

        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        a.prefs.enabled = true; check(PairWindow.commit(NONCE).equals("rejected"));
        check(PortSecretStore.saves == 1); w.close(PairWindowStatus.Phase.STOPPED); a.prefs.enabled = false;

        PortSecretStore.allowSave = false;
        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        check(PairWindow.commit(NONCE).equals("store_uncertain")); check(!a.prefs.enabled);
        w.close(PairWindowStatus.Phase.STOPPED);
        PortSecretStore.allowDisable = false;
        w = new PairWindow(a, false); check(w.start()); check(PairWindow.claim(NONCE, false) == w);
        try (PairPayload p = frame()) { w.prepare(p); }
        check(PairWindow.commit(NONCE).equals("store_uncertain"));
        w.close(PairWindowStatus.Phase.STOPPED); PortSecretStore.allowSave = true; PortSecretStore.allowDisable = true;
        System.out.println("PairWindow two-phase tests passed");
    }
}
