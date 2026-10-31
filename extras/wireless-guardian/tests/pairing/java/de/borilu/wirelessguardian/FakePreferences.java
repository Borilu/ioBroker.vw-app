package de.borilu.wirelessguardian;
import android.content.SharedPreferences;
public final class FakePreferences implements SharedPreferences {
    public boolean enabled;
    public String generation;
    public boolean getBoolean(String key, boolean fallback) { return key.equals("portEnabled") ? enabled : fallback; }
    public String getString(String key, String fallback) { return key.equals("portGeneration") && generation != null ? generation : fallback; }
    public boolean contains(String key) { return key.equals("portGeneration") && generation != null; }
}
