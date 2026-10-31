package android.os;
public final class Handler {
    public Handler(Looper looper) {}
    public boolean postDelayed(Runnable runnable, long delay) { return true; }
    public boolean post(Runnable runnable) { runnable.run(); return true; }
    public void removeCallbacks(Runnable runnable) {}
}
