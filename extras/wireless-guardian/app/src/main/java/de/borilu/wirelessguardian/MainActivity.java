package de.borilu.wirelessguardian;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.EditText;
import android.text.InputType;
import android.view.WindowManager;
import java.security.SecureRandom;
import java.util.Arrays;
import android.view.WindowInsets;

public final class MainActivity extends Activity {
    private PairWindow pairing;
    private final Handler handler = new Handler();
    private TextView status;
    private final Runnable update = new Runnable() {
        @Override public void run() {
            status.setText("Überwachung: " + (GuardianService.running ? "Dienst läuft" : State.enabled(MainActivity.this) ? "aktiviert, Dienst läuft derzeit nicht" : "ausgeschaltet")
                + "\n" + State.status(MainActivity.this)
                + "\nBerechtigung: " + (State.permitted(MainActivity.this) ? "vorhanden" : "fehlt")
                + "\nBenachrichtigungen: " + (State.notificationsVisible(MainActivity.this) ? "verfügbar" : "nicht verfügbar")
                + "\nWLAN: " + (State.hasWifi(MainActivity.this) ? "verbunden" : "nicht verbunden")
                + "\nDrahtloses Debugging: " + (State.isDebugEnabled(MainActivity.this) ? "laut Einstellung eingeschaltet" : "ausgeschaltet"));
            status.append("\nOptionale Portauskunft: " + (getSharedPreferences(State.PREFS, 0).getBoolean("portEnabled", false) ? "freigegeben" : "ausgeschaltet"));
            if (pairing != null) status.append("\nKopplungsfenster: " + pairing.label());
            handler.postDelayed(this, 1000);
        }
    };
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        ScrollView scroll = new ScrollView(this);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        layout.setPadding(padding, padding, padding, padding);
        scroll.addView(layout);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        TextView title = new TextView(this); title.setText("Wireless Guardian"); title.setTextSize(24); layout.addView(title);
        TextView about = new TextView(this);
        about.setText("TESTVERSION für Android 12, 12L und 16. Diese App kann drahtloses Debugging bei einer beliebigen WLAN-Verbindung automatisch wieder einschalten. Dadurch können zuvor zugelassene Computer das Handy steuern. Nur in vertrauenswürdigen Netzwerken nutzen. Android kann eine Bestätigung des WLANs verlangen; diese App bestätigt sie nicht.\n\nDie App benötigt eine besondere Systemberechtigung, die einmalig über ADB erteilt werden muss. Die Freigabe gilt allgemein für geschützte Systemeinstellungen; diese App ändert ausschließlich die Einstellung für drahtloses Debugging. Unter Android 16 sind sichtbare Benachrichtigungen erforderlich.\n\nWenn du die Überwachung ausschaltest, bleibt die aktuelle Android-Einstellung unverändert.");
        layout.addView(about);
        status = new TextView(this); status.setTextSize(17); status.setPadding(0, padding, 0, padding); layout.addView(status);
        if (Build.VERSION.SDK_INT >= 33) {
            Button notifications = new Button(this); notifications.setText("Benachrichtigungen erlauben"); notifications.setOnClickListener(v -> {
                if (checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
                } else {
                    Intent i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
                    try { startActivity(i); } catch (RuntimeException e) { State.setStatus(this, "Benachrichtigungen bitte in den Android-App-Einstellungen erlauben."); }
                }
            }); layout.addView(notifications);
        }
        Button start = new Button(this); start.setText("Überwachung ausdrücklich einschalten"); start.setOnClickListener(v -> {
            if (!State.supported()) { State.setStatus(this, "Diese Testversion unterstützt ausschließlich Android 12, 12L und 16."); return; }
            if (!State.permitted(this)) { State.setStatus(this, "Berechtigung fehlt. Bitte zuerst die Einrichtung in der Anleitung ausführen."); return; }
            if (!State.notificationsVisible(this)) { State.setStatus(this, "Bitte Benachrichtigungen und den Überwachungskanal in Android erlauben."); return; }
            if (!getSharedPreferences(State.PREFS, 0).edit().putInt("attempts", 0).putLong("lastAttempt", 0).putLong("onSince", 0)
                .putBoolean("optInApi36", Build.VERSION.SDK_INT == 36).putLong("explicitStartAt", System.currentTimeMillis())
                .putBoolean("enabled", true).commit()) { State.setStatus(this, "Freigabe konnte nicht gespeichert werden; Überwachung nicht gestartet."); return; }
            State.setStatus(this, "Überwachung startet …");
            try { startForegroundService(new Intent(this, GuardianService.class)); }
            catch (RuntimeException e) { boolean saved = State.setEnabled(this, false); State.setStatus(this, saved ? "Überwachung konnte nicht gestartet werden. Bitte erneut versuchen." : "Start fehlgeschlagen; Abschaltung konnte nicht gespeichert werden. Bitte Berechtigungen prüfen."); }
        }); layout.addView(start);
        Button stop = new Button(this); stop.setText("Überwachung ausschalten"); stop.setOnClickListener(v -> {
            if (pairing != null) pairing.close(PairWindowStatus.Phase.STOPPED);
            boolean saved = State.setEnabled(this, false); State.setStatus(this, saved ? "Überwachung ausgeschaltet" : "Dienst wird gestoppt, aber Abschaltung konnte nicht dauerhaft gespeichert werden.");
            stopService(new Intent(this, GuardianService.class));
        }); layout.addView(stop);
        if (Build.VERSION.SDK_INT == 36) {
            Button testPair = new Button(this); testPair.setText("Kopplungsweg ohne Schlüssel testen"); testPair.setOnClickListener(v -> confirmPair(true)); layout.addView(testPair);
            Button automatic = new Button(this); automatic.setText("Automatisch mit ioBroker koppeln"); automatic.setOnClickListener(v -> confirmPair(false)); layout.addView(automatic);
            Button port = new Button(this); port.setText("Optionale Portauskunft einrichten"); port.setOnClickListener(v -> configurePort()); layout.addView(port);
            Button portStop = new Button(this); portStop.setText("Portauskunft ausschalten und Schlüssel löschen"); portStop.setOnClickListener(v -> {
                if (pairing != null) pairing.close(PairWindowStatus.Phase.STOPPED);
                boolean saved = PortSecretStore.disable(this);
                State.setStatus(this, saved ? "Portauskunft ausgeschaltet und Schlüssel gelöscht." : "Portauskunft konnte nicht sicher ausgeschaltet werden.");
                if (GuardianService.running) startForegroundService(new Intent(this, GuardianService.class));
            }); layout.addView(portStop);
        }
        Button settings = new Button(this); settings.setText("Entwickleroptionen öffnen"); settings.setOnClickListener(v -> {
            try { startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
            catch (RuntimeException e) { State.setStatus(this, "Entwickleroptionen bitte manuell öffnen."); }
        }); layout.addView(settings);
        setContentView(scroll);
    }
    private void confirmPair(boolean testOnly) {
        if (!GuardianService.running || !State.enabled(this)) { State.setStatus(this, "Bitte zuerst die Überwachung ausdrücklich einschalten."); return; }
        new AlertDialog.Builder(this).setTitle("Automatische Port-Kopplung")
            .setMessage(testOnly
                ? "Ein über ADB bereits vertrauenswürdig verbundener Computer darf den Kopplungsweg einmal mit einem festen Testwert prüfen. Es wird kein Schlüssel und keine Portfreigabe gespeichert. Das Fenster bleibt höchstens eine Minute offen."
                : "Für eine Minute darf ein über ADB bereits vertrauenswürdig verbundener Computer den zuvor in ioBroker gespeicherten Schlüssel und seine Netzwerkadresse übertragen und die Portauskunft einmalig freigeben. Eine bereits aktive Portauskunft wird nicht ersetzt. Nur ausführen, wenn du die Einrichtung in ioBroker ausdrücklich gestartet hast.")
            .setNegativeButton("Abbrechen", (d, w) -> {})
            .setPositiveButton("Einmalige Kopplung erlauben", (d, w) -> {
                if (pairing != null) pairing.close(PairWindowStatus.Phase.STOPPED); pairing = new PairWindow(this, testOnly);
                if (pairing.start()) State.setStatus(this, "Einmalige Kopplungsbereitschaft angefordert.");
                else State.setStatus(this, "Kopplungsfenster konnte nicht geöffnet werden.");
            }).show();
    }
    private void configurePort() {
        if (pairing != null) pairing.close(PairWindowStatus.Phase.STOPPED);
        if (!GuardianService.running || !State.enabled(this)) { State.setStatus(this, "Bitte zuerst die Überwachung ausdrücklich einschalten."); return; }
        LinearLayout fields = new LinearLayout(this); fields.setOrientation(LinearLayout.VERTICAL);
        TextView explanation = new TextView(this);
        explanation.setText("TESTVERSION: Die App erhält INTERNET, eine grundsätzlich weitreichende Netzwerkberechtigung. Nach ausdrücklicher Freigabe kann sie am WLAN-Port 37457 auf authentifizierte Fragen der eingetragenen ioBroker-IP antworten. Eine Frage kann Androids lokale Multicast-Suche auslösen, die andere WLAN-Geräte sehen. Nur die Portnummer wird beantwortet; ADB-Kopplung und Handy-Identitätsprüfung bleiben erforderlich. Den individuellen Schlüssel vor dem Speichern privat in das maskierte Adapterfeld übertragen. Nie im Chat, Protokoll oder Screenshot teilen. Nur in einem vertrauenswürdigen WLAN verwenden.");
        fields.addView(explanation);
        EditText host = new EditText(this); host.setHint("IPv4-Adresse der ioBroker-VM (privates WLAN)"); host.setInputType(InputType.TYPE_CLASS_TEXT); fields.addView(host);
        EditText secret = new EditText(this); secret.setHint("Bitte zufälligen Schlüssel erzeugen");
        secret.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        secret.setKeyListener(null); secret.setLongClickable(false); secret.setTextIsSelectable(false);
        secret.setSaveEnabled(false); secret.setImportantForAutofill(android.view.View.IMPORTANT_FOR_AUTOFILL_NO); fields.addView(secret);
        Button generate = new Button(this); generate.setText("Zufälligen Schlüssel erzeugen"); generate.setOnClickListener(v -> {
            byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
            char[] alphabet = "0123456789abcdef".toCharArray(), out = new char[64];
            for (int i = 0; i < bytes.length; i++) { out[i * 2] = alphabet[(bytes[i] & 255) >>> 4]; out[i * 2 + 1] = alphabet[bytes[i] & 15]; }
            secret.setText(new String(out)); Arrays.fill(bytes, (byte) 0); Arrays.fill(out, (char) 0);
        }); fields.addView(generate);
        Runnable hideSecret = () -> secret.setTransformationMethod(android.text.method.PasswordTransformationMethod.getInstance());
        Button reveal = new Button(this); reveal.setText("Schlüssel 30 Sekunden anzeigen / verbergen"); reveal.setOnClickListener(v -> {
            boolean hidden = secret.getTransformationMethod() != null;
            secret.setTransformationMethod(hidden ? null : android.text.method.PasswordTransformationMethod.getInstance());
            handler.removeCallbacks(hideSecret); if (hidden) handler.postDelayed(hideSecret, 30000);
        }); fields.addView(reveal);
        ScrollView portScroll = new ScrollView(this); portScroll.addView(fields);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Portauskunft ausdrücklich freigeben").setView(portScroll)
            .setNegativeButton("Abbrechen", (d, w) -> secret.setText(""))
            .setPositiveButton("Freigeben und speichern", null).create();
        if (dialog.getWindow() == null) { State.setStatus(this, "Sicherer Einstellungsdialog nicht verfügbar."); return; }
        dialog.getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String ip = host.getText().toString().trim(); String raw = secret.getText().toString();
            if (!PortBridge.validHost(ip) || !raw.matches("[0-9a-f]{64}")) { secret.setError("Private IPv4-Adresse und 64 kleine Hexzeichen erforderlich."); return; }
            byte[] key = new byte[32]; for (int i = 0; i < key.length; i++) key[i] = (byte) Integer.parseInt(raw.substring(2 * i, 2 * i + 2), 16);
            boolean saved = PortSecretStore.save(this, key, ip, 37457); Arrays.fill(key, (byte) 0); secret.setText("");
            if (!saved) { State.setStatus(this, "Portauskunft konnte nicht sicher gespeichert werden."); return; }
            State.setStatus(this, "Portauskunft freigegeben. Gleichen Schlüssel privat in ioBroker eintragen.");
            try { startForegroundService(new Intent(this, GuardianService.class)); } catch (RuntimeException e) { State.setStatus(this, "Portauskunft konnte nicht gestartet werden."); }
            dialog.dismiss();
        }));
        dialog.setOnDismissListener(ignored -> { handler.removeCallbacks(hideSecret); secret.setText(""); }); dialog.show();
    }
    @Override protected void onResume() { super.onResume(); handler.post(update); }
    @Override protected void onPause() { if (pairing != null) pairing.close(PairWindowStatus.Phase.PAUSED); handler.removeCallbacks(update); super.onPause(); }
}
