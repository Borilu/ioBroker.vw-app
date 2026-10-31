package de.borilu.wirelessguardian;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.database.ContentObserver;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkRequest;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;

public final class GuardianService extends Service {
    static volatile boolean running;
    private static final String STOP = "de.borilu.wirelessguardian.STOP";
    private static final String CHANNEL = "monitor";
    private static final int NOTIFICATION_ID = 1;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private ConnectivityManager connectivity;
    private volatile boolean destroyed;
    private boolean initialized;
    private ContentObserver observer;
    private ConnectivityManager.NetworkCallback callback;
    private PortBridge portBridge;
    private final Runnable check = this::evaluate;

    @Override public void onCreate() {
        super.onCreate();
        if (!State.enabled(this) || !State.readyForAutomaticStart(this)) {
            boolean saved = State.setEnabled(this, false);
            State.setStatus(this, saved ? "Überwachung nicht gestartet: Freigabe, Benachrichtigungen oder Berechtigung prüfen." : "Überwachung nicht gestartet; Abschaltung konnte nicht dauerhaft gespeichert werden.");
            stopSelf(); return;
        }
        getSharedPreferences(State.PREFS, 0).edit().putLong("onSince", 0).apply();
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Debugging-Überwachung", NotificationManager.IMPORTANCE_LOW));
        nm.cancel(2);
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification("Überwachung startet …"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(NOTIFICATION_ID, notification("Überwachung startet …"));
        } catch (RuntimeException e) {
            boolean saved = State.setEnabled(this, false);
            State.setStatus(this, saved ? "Überwachung konnte nicht als Vordergrunddienst gestartet werden." : "Dienststart fehlgeschlagen; Abschaltung konnte nicht dauerhaft gespeichert werden.");
            stopSelf(); return;
        }
        running = true;
        observer = new ContentObserver(handler) { @Override public void onChange(boolean selfChange) {
            if (!State.isDebugEnabled(GuardianService.this)) getSharedPreferences(State.PREFS, 0).edit().putLong("onSince", 0).apply();
            schedule(1000);
        } };
        getContentResolver().registerContentObserver(Settings.Global.getUriFor(State.WIFI_DEBUG), false, observer);
        connectivity = getSystemService(ConnectivityManager.class);
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network network) { handler.post(() -> schedule(1000)); }
            @Override public void onLost(Network network) { handler.post(() -> schedule(1000)); }
        };
        try {
            connectivity.registerNetworkCallback(new NetworkRequest.Builder().addTransportType(android.net.NetworkCapabilities.TRANSPORT_WIFI).build(), callback);
            initialized = true;
        } catch (RuntimeException e) {
            callback = null;
            fail("WLAN-Überwachung konnte nicht gestartet werden.");
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && STOP.equals(intent.getAction())) {
            boolean saved = State.setEnabled(this, false);
            State.setStatus(this, saved ? "Überwachung ausgeschaltet" : "Dienst wird gestoppt, aber Abschaltung konnte nicht dauerhaft gespeichert werden.");
            stopSelf(); return START_NOT_STICKY;
        }
        if (!initialized) { stopSelf(); return START_NOT_STICKY; }
        if (!State.enabled(this)) { stopSelf(); return START_NOT_STICKY; }
        // A fresh service start/reconfiguration replaces the optional listener;
        // stop and opt-out always close it rather than reviving it in background.
        if (portBridge != null) { portBridge.close(); portBridge = null; }
        if (Build.VERSION.SDK_INT == 36 && getSharedPreferences(State.PREFS, 0).getBoolean("portEnabled", false)) {
            portBridge = new PortBridge(this); portBridge.start();
        }
        schedule(0); return START_STICKY;
    }

    private void schedule(long delay) { if (destroyed) return; handler.removeCallbacks(check); handler.postDelayed(check, delay); }

    private void evaluate() {
        if (destroyed) return;
        if (!State.enabled(this)) { stopSelf(); return; }
        if (!State.readyForAutomaticStart(this)) {
            fail("Überwachung beendet: Freigabe, Benachrichtigungen oder Berechtigung prüfen."); return;
        }
        boolean wifi = State.hasWifi(this);
        if (!wifi) {
            getSharedPreferences(State.PREFS, 0).edit().putLong("onSince", 0).apply();
            show("Warte auf WLAN; keine Änderung vorgenommen.");
            schedule(60_000); return;
        }
        SharedPreferences prefs = getSharedPreferences(State.PREFS, 0);
        int attempts = prefs.getInt("attempts", 0);
        long lastAttempt = prefs.getLong("lastAttempt", 0);
        if (State.isDebugEnabled(this)) {
            // A transient "1" can be rejected later by Android's network trust check.
            // Only clear the retry budget after the setting has remained on long enough.
            long onSince = prefs.getLong("onSince", 0);
            // The stable observation window is monotonic, so wall-clock changes
            // cannot unlock the budget early. onSince is reset in onCreate.
            if (onSince == 0) prefs.edit().putLong("onSince", SystemClock.elapsedRealtime()).apply();
            else if (RecoveryPolicy.canResetBudget(attempts, onSince, SystemClock.elapsedRealtime()))
                prefs.edit().putInt("attempts", 0).putLong("lastAttempt", 0).apply();
            show("Drahtloses Debugging laut Einstellung eingeschaltet.");
            schedule(60_000); return;
        }
        prefs.edit().putLong("onSince", 0).apply();
        long now = System.currentTimeMillis();
        RecoveryPolicy.OffAction offAction = RecoveryPolicy.offAction(attempts, lastAttempt, now);
        if (offAction == RecoveryPolicy.OffAction.WAIT_BACKOFF) {
            show("Aktivierung nicht bestätigt; erneute Prüfung folgt.");
            schedule(RetryPolicy.waitMillis(attempts, lastAttempt, now)); return;
        }
        if (offAction == RecoveryPolicy.OffAction.WAIT_USER) {
            // Keep observing without writing. A user may still approve Android's
            // network prompt, or turn debugging on manually, after this point.
            // Only five minutes of observed stable-on state resets the budget.
            show("Warte auf Android-WLAN-Freigabe oder manuelle Aktivierung; keine weiteren Einschaltversuche.");
            schedule(60_000); return;
        }
        attempts++;
        // Persist before the write so a service restart cannot silently reset the limit.
        if (!prefs.edit().putInt("attempts", attempts).putLong("lastAttempt", System.currentTimeMillis()).commit()) {
            fail("Sicherheitszähler konnte nicht gespeichert werden. Keine Änderung vorgenommen."); return;
        }
        try {
            boolean written = Settings.Global.putInt(getContentResolver(), State.WIFI_DEBUG, 1);
            if (!written) { fail("Android hat die Änderung abgelehnt. Berechtigung und Entwickleroptionen prüfen."); return; }
            show("Aktivierung angefordert; Android prüft das WLAN.");
            schedule(5000);
        } catch (SecurityException e) {
            fail("Berechtigung fehlt oder wurde entzogen. Überwachung beendet.");
        } catch (RuntimeException e) {
            fail("Android-Einstellung konnte nicht geändert werden. Überwachung beendet.");
        }
    }

    private void show(String message) {
        State.setStatus(this, message);
        getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(message));
    }
    private void fail(String message) {
        boolean saved = State.setEnabled(this, false);
        if (!saved) message += " Abschaltung konnte nicht dauerhaft gespeichert werden.";
        State.setStatus(this, message);
        NotificationManager nm = getSystemService(NotificationManager.class);
        stopForeground(STOP_FOREGROUND_REMOVE);
        nm.notify(2, notification(message));
        stopSelf();
    }
    private Notification notification(String message) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, GuardianService.class).setAction(STOP), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (getSharedPreferences(State.PREFS, 0).getBoolean("portEnabled", false)) message += " Portauskunft freigegeben.";
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Wireless Guardian").setContentText(message).setStyle(new Notification.BigTextStyle().bigText(message))
            .setContentIntent(open).setOngoing(State.enabled(this))
            .addAction(new Notification.Action.Builder(null, "Überwachung stoppen", stop).build()).build();
    }
    @Override public void onDestroy() {
        destroyed = true;
        running = false;
        PairWindow.invalidateAll();
        if (portBridge != null) portBridge.close();
        handler.removeCallbacksAndMessages(null);
        if (observer != null) getContentResolver().unregisterContentObserver(observer);
        if (connectivity != null && callback != null) connectivity.unregisterNetworkCallback(callback);
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
