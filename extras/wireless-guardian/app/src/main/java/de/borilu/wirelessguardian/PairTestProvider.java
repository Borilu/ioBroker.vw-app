package de.borilu.wirelessguardian;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Binder;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import java.io.FileNotFoundException;
import java.io.InputStream;
import java.util.Arrays;

/** Explicit one-use ADB-shell-only exchange; the only secret input is stdin. */
public final class PairTestProvider extends ContentProvider {
    private static final int SHELL_UID = 2000;
    private static void requireShell() { if (Binder.getCallingUid() != SHELL_UID) throw new SecurityException("Shell only"); }
    @Override public boolean onCreate() { return true; }
    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        requireShell();
        boolean test = "/synthetic".equals(uri.getPath());
        if (!(test || "/prepare".equals(uri.getPath())) || !("w".equals(mode) || "wt".equals(mode))) throw new FileNotFoundException();
        PairWindow window = PairWindow.claim(uri.getQueryParameter("token"), test);
        if (window == null) throw new FileNotFoundException();
        try {
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            Handler handler = new Handler(Looper.getMainLooper());
            Runnable timeout = () -> { try { pipe[0].close(); } catch (Exception ignored) {} };
            handler.postDelayed(timeout, 5000);
            Thread reader = new Thread(() -> {
                byte[] payload = new byte[test ? 33 : 57]; boolean ioOk = false; int size = 0;
                try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(pipe[0])) {
                    int n; while (size < payload.length && (n = input.read(payload, size, payload.length - size)) > 0) size += n;
                    ioOk = true;
                } catch (Exception ignored) { ioOk = false; }
                finally {
                    try {
                        if (test) {
                            boolean valid = ioOk && size == 32;
                            for (int i = 0; i < 32; i++) valid &= payload[i] == 0x42;
                            window.finish(valid);
                        } else {
                            try (PairPayload frame = ioOk ? PairPayload.parse(payload, size) : null) { window.prepare(frame); }
                        }
                    } finally { Arrays.fill(payload, (byte) 0); handler.removeCallbacks(timeout); }
                }
            }, "guardian-binder-pair");
            reader.setDaemon(true); reader.start(); return pipe[1];
        } catch (Exception ignored) { if (test) window.finish(false); else window.prepare(null); throw new FileNotFoundException(); }
    }
    @Override public Bundle call(String method, String arg, Bundle extras) {
        requireShell(); Bundle response = new Bundle();
        if ("synthetic_status".equals(method) || "pair_status".equals(method)) response.putString("result", PairWindow.result(arg));
        else if ("pair_commit".equals(method)) response.putString("result", PairWindow.commit(arg));
        else if ("port_status".equals(method)) response.putString("result", PairWindow.portResetStatus(getContext()));
        else throw new IllegalArgumentException();
        return response;
    }
    @Override public String getType(Uri uri) { requireShell(); return null; }
    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { requireShell(); return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { requireShell(); throw new UnsupportedOperationException(); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { requireShell(); throw new UnsupportedOperationException(); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { requireShell(); throw new UnsupportedOperationException(); }
}
