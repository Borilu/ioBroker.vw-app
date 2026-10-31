package de.borilu.wirelessguardian;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;

/** Loopback-only synthetic test harness, never used by the Android app. */
public final class PortInteropServer {
    public static void main(String[] args) throws Exception {
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0xab);
        try (DatagramSocket socket = new DatagramSocket(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0));
             PortProtocol protocol = new PortProtocol(key)) {
            Arrays.fill(key, (byte) 0); socket.setSoTimeout(5000);
            System.out.println(socket.getLocalPort()); System.out.flush();
            byte[] b = new byte[193]; DatagramPacket q = new DatagramPacket(b, b.length); socket.receive(q);
            byte[] c = protocol.begin(Arrays.copyOf(b, q.getLength()), "34".repeat(16));
            if (c == null) throw new AssertionError("invalid synthetic query");
            socket.send(new DatagramPacket(c, c.length, q.getAddress(), q.getPort()));
            b = new byte[193]; DatagramPacket ack = new DatagramPacket(b, b.length); socket.receive(ack);
            if (!q.getAddress().equals(ack.getAddress()) || q.getPort() != ack.getPort() || !protocol.acceptAck(Arrays.copyOf(b, ack.getLength()))) throw new AssertionError("invalid acknowledgement");
            byte[] r = protocol.makeReply(49122);
            socket.send(new DatagramPacket(r, r.length, q.getAddress(), q.getPort()));
        }
    }
}
