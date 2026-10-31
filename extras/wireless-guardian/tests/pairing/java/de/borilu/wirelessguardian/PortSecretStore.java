package de.borilu.wirelessguardian;
import android.app.Activity;
public final class PortSecretStore {
    static final Object LOCK = new Object();
    static boolean allowSave = true;
    static boolean allowDisable = true;
    static int saves;
    static boolean save(Activity activity, byte[] key, String host, int port) {
        saves++; activity.prefs.enabled = true; activity.prefs.generation = "test-generation";
        return allowSave;
    }
    static boolean disable(Activity activity) { activity.prefs.enabled = false; activity.prefs.generation = null; return allowDisable; }
}
