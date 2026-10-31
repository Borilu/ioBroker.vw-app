package de.borilu.wirelessguardian;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.SystemClock;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.SocketTimeoutException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Optional LAN-only port responder; never sends vehicle or Android control commands. */
final class PortBridge implements AutoCloseable {
    private static final String SERVICE = "_adb-tls-connect._tcp.";
    private final Context context;
    private volatile boolean stopped;
    private volatile DatagramSocket socket;
    private Thread thread;
    PortBridge(Context c) { context = c.getApplicationContext(); }
    synchronized void start() {
        if (thread != null) return;
        thread = new Thread(this::run, "guardian-port-listener"); thread.start();
    }
    static boolean validHost(String input) {
        return PortHostPolicy.validHost(input);
    }
    private static final class Wifi {
        final Network network; final InetAddress address;
        Wifi(Network network, InetAddress address) { this.network = network; this.address = address; }
    }
    private Wifi wifi() {
        ConnectivityManager cm = context.getSystemService(ConnectivityManager.class); if (cm == null) return null;
        Wifi only = null;
        for (Network network : cm.getAllNetworks()) {
            NetworkCapabilities caps = cm.getNetworkCapabilities(network);
            if (caps == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) continue;
            LinkProperties lp = cm.getLinkProperties(network); if (lp == null) continue;
            for (LinkAddress link : lp.getLinkAddresses()) {
                InetAddress ip = link.getAddress();
                if (!(ip instanceof Inet4Address) || ip.isLoopbackAddress() || ip.isLinkLocalAddress()) continue;
                if (only != null) return null;
                only = new Wifi(network, ip);
            }
        }
        return only;
    }
    private boolean allowed(String generation) {
        SharedPreferences config = context.getSharedPreferences(State.PREFS, 0);
        return !stopped && State.enabled(context) && State.readyForAutomaticStart(context)
            && config.getBoolean("portEnabled", false) && (generation == null || generation.equals(config.getString("portGeneration", "")))
            && State.isDebugEnabled(context);
    }
    private void run() {
        try {
            while (!stopped) {
                if (!allowed(null)) { Thread.sleep(1000); continue; }
                Wifi wifi = wifi(); SharedPreferences p = context.getSharedPreferences(State.PREFS, 0);
                String host = p.getString("portHost", ""); int port = p.getInt("portListen", 0);
                String generation = p.getString("portGeneration", "");
                byte[] key = PortSecretStore.load(context);
                if (wifi == null || !validHost(host) || generation.isEmpty() || !allowed(generation) || port < 1 || port > 65535 || key == null) {
                    if (key != null) Arrays.fill(key, (byte) 0);
                    Thread.sleep(1000); continue;
                }
                try (DatagramSocket s = new DatagramSocket(new InetSocketAddress(wifi.address, port))) {
                    socket = s; s.setSoTimeout(1000);
                    long lastChallenge = 0, lastDiscovery = 0; SecureRandom random = new SecureRandom();
                    while (allowed(generation)) {
                        Wifi current = wifi(); if (current == null || !wifi.network.equals(current.network) || !wifi.address.equals(current.address)) break;
                        byte[] input = new byte[193]; DatagramPacket packet = new DatagramPacket(input, input.length);
                        try { s.receive(packet); } catch (SocketTimeoutException e) { continue; }
                        if (packet.getLength() > 192 || !host.equals(packet.getAddress().getHostAddress()) || !allowed(generation)) continue;
                        long now = SystemClock.elapsedRealtime(); if (lastChallenge != 0 && now - lastChallenge < 1000) continue;
                        try (PortProtocol protocol = new PortProtocol(key)) {
                            byte[] randomBytes = new byte[16]; random.nextBytes(randomBytes);
                            char[] alphabet = "0123456789abcdef".toCharArray(), nonce = new char[32];
                            for (int i = 0; i < randomBytes.length; i++) { nonce[2*i] = alphabet[(randomBytes[i] & 255) >>> 4]; nonce[2*i+1] = alphabet[randomBytes[i] & 15]; }
                            Arrays.fill(randomBytes, (byte) 0);
                            byte[] challenge = protocol.begin(Arrays.copyOf(input, packet.getLength()), new String(nonce)); Arrays.fill(nonce, (char) 0);
                            if (challenge == null) continue;
                            lastChallenge = now;
                            synchronized (PortSecretStore.LOCK) {
                                if (!allowed(generation)) continue;
                                s.send(new DatagramPacket(challenge, challenge.length, packet.getAddress(), packet.getPort()));
                            }
                            boolean acked = false; long until = SystemClock.elapsedRealtime() + 1500;
                            try {
                                while (allowed(generation) && SystemClock.elapsedRealtime() < until) {
                                    s.setSoTimeout((int) Math.max(1, until - SystemClock.elapsedRealtime()));
                                    byte[] ackBytes = new byte[193]; DatagramPacket ack = new DatagramPacket(ackBytes, ackBytes.length);
                                    try { s.receive(ack); } catch (SocketTimeoutException e) { break; }
                                    if (ack.getLength() > 192 || !packet.getAddress().equals(ack.getAddress()) || packet.getPort() != ack.getPort()) continue;
                                    if (protocol.acceptAck(Arrays.copyOf(ackBytes, ack.getLength()))) { acked = true; break; }
                                }
                            } finally { s.setSoTimeout(1000); }
                            now = SystemClock.elapsedRealtime();
                            if (!acked || !allowed(generation) || (lastDiscovery != 0 && now - lastDiscovery < 10000)) continue;
                            lastDiscovery = now;
                            int candidate = discover(wifi, generation);
                            Wifi after = wifi();
                            if (candidate < 1 || !allowed(generation) || after == null || !wifi.network.equals(after.network) || !wifi.address.equals(after.address)) continue;
                            byte[] reply = protocol.makeReply(candidate);
                            synchronized (PortSecretStore.LOCK) {
                                // Rotation and user disable commit under the same lock;
                                // they cannot complete between this check and the send.
                                if (reply != null && allowed(generation)) s.send(new DatagramPacket(reply, reply.length, packet.getAddress(), packet.getPort()));
                            }
                        }
                    }
                } catch (Exception ignored) { Arrays.fill(key, (byte) 0); }
                finally { Arrays.fill(key, (byte) 0); socket = null; }
                if (!stopped) Thread.sleep(1000);
            }
        } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
    }
    private int discover(Wifi wifi, String generation) {
        NsdManager nsd = context.getSystemService(NsdManager.class); if (nsd == null || !allowed(generation)) return 0;
        CountDownLatch done = new CountDownLatch(1), stopConfirmed = new CountDownLatch(1);
        AtomicBoolean active = new AtomicBoolean(true), failed = new AtomicBoolean(false);
        List<NsdManager.ServiceInfoCallback> callbacks = new ArrayList<>();
        Set<NsdManager.ServiceInfoCallback> pending = ConcurrentHashMap.newKeySet();
        Map<NsdManager.ServiceInfoCallback, Integer> ports = new ConcurrentHashMap<>();
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String ignored) {
                if (!active.get()) try { nsd.stopServiceDiscovery(this); } catch (RuntimeException e) { failed.set(true); }
            }
            @Override public void onDiscoveryStopped(String ignored) { if (active.get()) failed.set(true); done.countDown(); stopConfirmed.countDown(); }
            @Override public void onStartDiscoveryFailed(String ignored, int code) { failed.set(true); done.countDown(); }
            @Override public void onStopDiscoveryFailed(String ignored, int code) { failed.set(true); done.countDown(); stopConfirmed.countDown(); }
            // Do not use an earlier candidate once an advertisement disappears.
            // Correlating opaque Android service objects here is not reliable.
            @Override public void onServiceLost(NsdServiceInfo ignored) { failed.set(true); done.countDown(); }
            @Override public void onServiceFound(NsdServiceInfo found) {
                if (!active.get() || !allowed(generation)) return;
                synchronized (callbacks) {
                    if (!active.get() || !allowed(generation)) return;
                    if (callbacks.size() >= 8) { failed.set(true); done.countDown(); return; }
                    NsdManager.ServiceInfoCallback cb = new NsdManager.ServiceInfoCallback() {
                        @Override public void onServiceInfoCallbackRegistrationFailed(int error) { failed.set(true); }
                        @Override public void onServiceUpdated(NsdServiceInfo info) {
                            synchronized (callbacks) {
                                if (!active.get()) {
                                    try { nsd.unregisterServiceInfoCallback(this); } catch (RuntimeException e) { failed.set(true); }
                                    return;
                                }
                                int port = info.getPort();
                                if (info.getNetwork() == null || info.getHostAddresses().isEmpty() || port < 1 || port > 65535) { pending.add(this); ports.remove(this); return; }
                                boolean own = wifi.network.equals(info.getNetwork()) && info.getHostAddresses().contains(wifi.address);
                                pending.remove(this); if (own) ports.put(this, port); else ports.remove(this);
                            }
                        }
                        @Override public void onServiceLost() { synchronized (callbacks) { if (active.get()) { ports.remove(this); pending.remove(this); failed.set(true); done.countDown(); } } }
                        @Override public void onServiceInfoCallbackUnregistered() { }
                    };
                    callbacks.add(cb); pending.add(cb);
                    try { nsd.registerServiceInfoCallback(found, context.getMainExecutor(), cb); } catch (RuntimeException e) { failed.set(true); done.countDown(); }
                }
            }
        };
        try {
            nsd.discoverServices(SERVICE, NsdManager.PROTOCOL_DNS_SD, wifi.network, context.getMainExecutor(), listener);
            done.await(12, TimeUnit.SECONDS);
        } catch (Exception ignored) { failed.set(true); }
        finally {
            synchronized (callbacks) { active.set(false); }
            try { nsd.stopServiceDiscovery(listener); } catch (RuntimeException ignored) { failed.set(true); stopConfirmed.countDown(); }
            synchronized (callbacks) { for (NsdManager.ServiceInfoCallback cb : callbacks) try { nsd.unregisterServiceInfoCallback(cb); } catch (RuntimeException ignored) { failed.set(true); } }
            try { if (!stopConfirmed.await(800, TimeUnit.MILLISECONDS)) failed.set(true); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); failed.set(true); }
        }
        // Exactly one resolved own service, not merely one distinct number;
        // duplicate/conflicting advertisements are intentionally ambiguous.
        return PortCandidatePolicy.choose(failed.get(), pending.size(), ports.values());
    }
    @Override public synchronized void close() {
        stopped = true; DatagramSocket current = socket; if (current != null) current.close();
        if (thread != null) thread.interrupt(); thread = null;
    }
}
