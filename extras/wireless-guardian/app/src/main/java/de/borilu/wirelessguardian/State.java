package de.borilu.wirelessguardian;

import android.content.Context;
import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.pm.PackageManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.provider.Settings;

final class State {
    static final String PREFS = "guardian";
    static final String WIFI_DEBUG = "adb_wifi_enabled";
    static boolean enabled(Context c) { return c.getSharedPreferences(PREFS, 0).getBoolean("enabled", false); }
    static boolean setEnabled(Context c, boolean value) {
        synchronized (PairWindow.LOCK) {
            if (!value) PairWindow.invalidateAll();
            synchronized (PortSecretStore.LOCK) { return c.getSharedPreferences(PREFS, 0).edit().putBoolean("enabled", value).commit(); }
        }
    }
    static void setStatus(Context c, String value) { c.getSharedPreferences(PREFS, 0).edit().putString("status", value).apply(); }
    static String status(Context c) { return c.getSharedPreferences(PREFS, 0).getString("status", "Überwachung ausgeschaltet"); }
    static boolean supported() { return VersionPolicy.supported(Build.VERSION.SDK_INT); }
    static boolean optedInForVersion(Context c) { return Build.VERSION.SDK_INT != 36 || c.getSharedPreferences(PREFS, 0).getBoolean("optInApi36", false); }
    static boolean notificationsVisible(Context c) {
        if (Build.VERSION.SDK_INT < 33) return true;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        if (nm == null || !nm.areNotificationsEnabled() || c.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED) return false;
        NotificationChannel channel = nm.getNotificationChannel("monitor");
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }
    static boolean userStoppedSinceOptIn(Context c) {
        if (Build.VERSION.SDK_INT != 36) return false;
        long optIn = c.getSharedPreferences(PREFS, 0).getLong("explicitStartAt", 0);
        if (optIn <= 0) return true;
        try {
            ActivityManager am = c.getSystemService(ActivityManager.class);
            if (am == null) return true;
            for (ApplicationExitInfo exit : am.getHistoricalProcessExitReasons(null, 0, 16)) {
                if (VersionPolicy.stopAfterOptIn(optIn, exit.getReason(), exit.getTimestamp(), ApplicationExitInfo.REASON_USER_REQUESTED)) return true;
            }
            return false;
        } catch (RuntimeException e) { return true; }
    }
    static boolean readyForAutomaticStart(Context c) {
        return VersionPolicy.ready(Build.VERSION.SDK_INT, permitted(c), optedInForVersion(c), notificationsVisible(c), userStoppedSinceOptIn(c));
    }
    static boolean permitted(Context c) { return c.checkSelfPermission("android.permission.WRITE_SECURE_SETTINGS") == PackageManager.PERMISSION_GRANTED; }
    static boolean isDebugEnabled(Context c) { return Settings.Global.getInt(c.getContentResolver(), WIFI_DEBUG, 0) == 1; }
    static boolean hasWifi(Context c) {
        ConnectivityManager cm = (ConnectivityManager) c.getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        for (Network network : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps != null && caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return true;
        }
        return false;
    }
    private State() {}
}
