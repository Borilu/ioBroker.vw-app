package de.borilu.wirelessguardian;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Android-private preferences contain only an authenticated ciphertext. */
final class PortSecretStore {
    static final Object LOCK = new Object();
    private static final String KEY_ALIAS = "guardian-port-v1";
    private static final byte[] AAD = "guardian-port-config-v1".getBytes(StandardCharsets.UTF_8);
    private static SecretKey key() throws Exception {
        KeyStore keys = KeyStore.getInstance("AndroidKeyStore"); keys.load(null);
        if (!keys.containsAlias(KEY_ALIAS)) {
            KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
            gen.generateKey();
        }
        return (SecretKey) keys.getKey(KEY_ALIAS, null);
    }
    static boolean save(Context c, byte[] secret, String host, int port) {
        if (secret == null || secret.length != 32 || !PortBridge.validHost(host) || port < 1 || port > 65535) return false;
        synchronized (LOCK) {
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key()); cipher.updateAAD(AAD);
            String iv = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP);
            String encrypted = Base64.encodeToString(cipher.doFinal(secret), Base64.NO_WRAP);
            return c.getSharedPreferences(State.PREFS, 0).edit().putString("portIv", iv).putString("portSecret", encrypted)
                .putString("portHost", host).putInt("portListen", port).putString("portGeneration", java.util.UUID.randomUUID().toString())
                .putBoolean("portEnabled", true).commit();
        } catch (Exception error) { return false; }
        }
    }
    static byte[] load(Context c) {
        SharedPreferences p = c.getSharedPreferences(State.PREFS, 0);
        try {
            byte[] iv = Base64.decode(p.getString("portIv", ""), Base64.NO_WRAP);
            byte[] encrypted = Base64.decode(p.getString("portSecret", ""), Base64.NO_WRAP);
            if (iv.length != 12 || encrypted.length != 48) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
            cipher.updateAAD(AAD); byte[] result = cipher.doFinal(encrypted);
            return result.length == 32 ? result : null;
        } catch (Exception error) { return null; }
    }
    static boolean disable(Context c) {
        synchronized (LOCK) {
            return c.getSharedPreferences(State.PREFS, 0).edit().putBoolean("portEnabled", false)
                .remove("portIv").remove("portSecret").remove("portHost").remove("portListen").remove("portGeneration").commit();
        }
    }
    private PortSecretStore() { }
}
