package de.borilu.wirelessguardian;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/** Restore only an existing user's monitoring choice after our own APK update. */
public final class UpdateReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())) return;
        SharedPreferences prefs = context.getSharedPreferences(State.PREFS, 0);
        boolean enabled = prefs.getBoolean("enabled", false);
        boolean legacyRetryFailure = RecoveryPolicy.isLegacyRetryFailure(enabled,
            prefs.getString("status", ""), prefs.getInt("attempts", 0));
        if (!enabled && !legacyRetryFailure) return;
        // A legacy migration is not consent for the experimental Android 16 implementation.
        if (android.os.Build.VERSION.SDK_INT == 36 && legacyRetryFailure) return;
        if (!State.readyForAutomaticStart(context)) {
            prefs.edit().putBoolean("enabled", false)
                .putString("status", "Überwachung nach Update nicht gestartet: Systemversion oder Berechtigung prüfen.").commit();
            return;
        }
        if (legacyRetryFailure && !prefs.edit().putBoolean("enabled", true)
            .putString("status", "Überwachung nach Update wird gestartet.").commit()) return;
        try { context.startForegroundService(new Intent(context, GuardianService.class)); }
        catch (RuntimeException e) {
            prefs.edit().putBoolean("enabled", false)
                .putString("status", "Automatischer Start nach Update fehlgeschlagen. App bitte öffnen und Überwachung einschalten.").commit();
        }
    }
}
