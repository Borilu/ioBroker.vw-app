package de.borilu.wirelessguardian;
import android.app.Activity;
public final class State {
    static final String PREFS = "guardian";
    static boolean active = true;
    static boolean enabled(Activity activity) { return active; }
    static boolean readyForAutomaticStart(Activity activity) { return active; }
    static void setStatus(Activity activity, String text) {}
}
