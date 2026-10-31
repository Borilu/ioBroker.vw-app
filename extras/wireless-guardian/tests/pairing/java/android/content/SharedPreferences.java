package android.content;
public interface SharedPreferences {
    boolean getBoolean(String key, boolean fallback);
    String getString(String key, String fallback);
    boolean contains(String key);
}
