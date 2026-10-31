package android.content;
import de.borilu.wirelessguardian.FakePreferences;
public class Context {
    public final FakePreferences prefs = new FakePreferences();
    public FakePreferences getSharedPreferences(String name, int mode) { return prefs; }
}
