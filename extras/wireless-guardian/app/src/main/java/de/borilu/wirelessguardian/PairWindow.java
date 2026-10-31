package de.borilu.wirelessguardian;

import android.app.Activity;
import android.content.Intent;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import java.util.Arrays;

/** Foreground-only, one-use transaction; pending keys exist only in process memory. */
final class PairWindow {
    static final Object LOCK = new Object();
    static PairWindow current;
    private final Activity activity;
    private final boolean testOnly;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final PairWindowStatus status = new PairWindowStatus();
    private final Runnable expiry = () -> close(PairWindowStatus.Phase.EXPIRED);
    private long deadline;
    private boolean open;
    private boolean claimed;
    private String token;
    private byte[] pendingKey;
    private String pendingHost;
    private String result = "unknown";
    PairWindow(Activity activity, boolean testOnly) { this.activity = activity; this.testOnly = testOnly; }
    private static boolean hasPortSetup(SharedPreferences prefs) {
        return prefs.getBoolean("portEnabled", false) || prefs.contains("portIv") || prefs.contains("portSecret")
            || prefs.contains("portHost") || prefs.contains("portListen") || prefs.contains("portGeneration");
    }
    boolean start() {
        synchronized (LOCK) {
            synchronized (PortSecretStore.LOCK) {
                if (!GuardianService.running || !State.enabled(activity) || !State.readyForAutomaticStart(activity) || current != null
                    || (!testOnly && hasPortSetup(activity.getSharedPreferences(State.PREFS, 0)))) {
                    status.end(PairWindowStatus.Phase.STOPPED, SystemClock.elapsedRealtime()); return false;
                }
            }
            long now = SystemClock.elapsedRealtime();
            if (now < 0 || now > Long.MAX_VALUE - 60000) return false;
            deadline = now + 60000; open = true; current = this; status.opened(deadline);
            main.postDelayed(expiry, 60000); return true;
        }
    }
    static PairWindow claim(String requestToken) { return claim(requestToken, true); }
    static PairWindow claim(String requestToken, boolean test) {
        synchronized (LOCK) {
            PairWindow p = current;
            if (p == null || !p.open || p.claimed || p.testOnly != test || !p.active()
                || requestToken == null || !requestToken.matches("[a-f0-9]{32}")) return null;
            p.claimed = true; p.token = requestToken; p.result = "pending"; return p;
        }
    }
    private boolean active() {
        return PairDeadline.active(SystemClock.elapsedRealtime(), deadline) && GuardianService.running
            && State.enabled(activity) && State.readyForAutomaticStart(activity);
    }
    void finish(boolean valid) {
        synchronized (LOCK) {
            if (current != this || !open || !claimed || !testOnly || !active()) return;
            open = false; result = valid ? "test_ok" : "rejected";
            status.end(valid ? PairWindowStatus.Phase.TEST_DONE : PairWindowStatus.Phase.REJECTED, SystemClock.elapsedRealtime());
            main.removeCallbacks(expiry);
        }
    }
    void prepare(PairPayload payload) {
        synchronized (LOCK) {
            if (payload == null || current != this || !open || !claimed || testOnly || !active()) {
                reject(); return;
            }
            pendingKey = Arrays.copyOf(payload.key, payload.key.length); pendingHost = payload.host;
            result = "prepared";
        }
    }
    private void clearKey() { if (pendingKey != null) Arrays.fill(pendingKey, (byte) 0); pendingKey = null; pendingHost = null; }
    private void reject() {
        if (current != this || !open) return;
        clearKey(); open = false; result = "rejected";
        status.end(PairWindowStatus.Phase.REJECTED, SystemClock.elapsedRealtime()); main.removeCallbacks(expiry);
    }
    static String result(String requestToken) {
        synchronized (LOCK) {
            PairWindow p = current;
            if (p == null || p.token == null || !p.token.equals(requestToken)) return "unknown";
            if (p.open && !p.active()) return "closed";
            return p.result;
        }
    }
    static String commit(String requestToken) {
        synchronized (LOCK) {
            PairWindow p = current;
            if (p == null || p.testOnly || !p.open || !p.claimed || !"prepared".equals(p.result)
                || p.token == null || !p.token.equals(requestToken) || !p.active()) return "closed";
            boolean ok;
            String generation = null;
            synchronized (PortSecretStore.LOCK) {
                SharedPreferences prefs = p.activity.getSharedPreferences(State.PREFS, 0);
                if (!p.active() || hasPortSetup(prefs)) { p.reject(); return "rejected"; }
                ok = PortSecretStore.save(p.activity, p.pendingKey, p.pendingHost, 37457);
                if (ok) generation = prefs.getString("portGeneration", null);
                // SharedPreferences may update its in-memory view even when disk commit fails.
                // Disabling under the same lock prevents any listener response after failure.
                if (!ok) PortSecretStore.disable(p.activity);
            }
            // A failed persistence plus a failed rollback has an unknowable on-disk outcome.
            // Report every storage failure as uncertain and leave host recovery explicit.
            p.clearKey(); p.open = false; p.result = ok ? "committed" : "store_uncertain";
            p.status.end(ok ? PairWindowStatus.Phase.PAIR_DONE : PairWindowStatus.Phase.STORE_FAILED, SystemClock.elapsedRealtime());
            p.main.removeCallbacks(p.expiry);
            final String savedGeneration = generation;
            if (ok && savedGeneration != null) p.main.post(() -> {
                synchronized (PortSecretStore.LOCK) {
                    SharedPreferences prefs = p.activity.getSharedPreferences(State.PREFS, 0);
                    if (!GuardianService.running || !State.enabled(p.activity) || !prefs.getBoolean("portEnabled", false)
                        || !savedGeneration.equals(prefs.getString("portGeneration", null))) return;
                    try { p.activity.startForegroundService(new Intent(p.activity, GuardianService.class)); }
                    catch (RuntimeException ignored) { State.setStatus(p.activity, "Portauskunft gespeichert; Dienststart nicht bestätigt."); }
                }
            });
            return p.result;
        }
    }
    /** Read-only observation, not proof that a previous failed disk write persisted. */
    static String portResetStatus(Context context) {
        synchronized (LOCK) {
            synchronized (PortSecretStore.LOCK) {
                SharedPreferences prefs = context.getSharedPreferences(State.PREFS, 0);
                if (current != null || hasPortSetup(prefs)) return "not_resettable";
                return "inactive_closed";
            }
        }
    }
    String label() { return status.label(SystemClock.elapsedRealtime()); }
    static void invalidateAll() {
        synchronized (LOCK) { if (current != null) current.close(PairWindowStatus.Phase.STOPPED); }
    }
    void close(PairWindowStatus.Phase reason) {
        synchronized (LOCK) {
            clearKey();
            if (open) { open = false; status.end(reason, SystemClock.elapsedRealtime()); }
            if (current == this) current = null;
            main.removeCallbacks(expiry);
        }
    }
}
