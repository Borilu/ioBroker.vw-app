package de.borilu.wirelessguardian;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class BootReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) || !State.enabled(context)) return;
        if (!State.readyForAutomaticStart(context)) {
            boolean saved = State.setEnabled(context, false);
            State.setStatus(context, saved ? "Überwachung nach Neustart nicht gestartet: Freigabe, Benachrichtigungen oder Berechtigung prüfen." : "Überwachung nicht gestartet; Abschaltung konnte nicht dauerhaft gespeichert werden.");
            return;
        }
        try { context.startForegroundService(new Intent(context, GuardianService.class)); }
        catch (RuntimeException e) { boolean saved = State.setEnabled(context, false); State.setStatus(context, saved ? "Automatischer Start fehlgeschlagen. App bitte öffnen und Überwachung einschalten." : "Automatischer Start fehlgeschlagen; Abschaltung konnte nicht gespeichert werden."); }
    }
}
