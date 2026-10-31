package de.borilu.wirelessguardian;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;

public final class PortProtocolTest {
    private static void expect(boolean value) { if (!value) throw new AssertionError(); }
    private static byte[] ascii(String s) { return s.getBytes(StandardCharsets.US_ASCII); }
    public static void main(String[] args) {
        // Independent Node.js test vectors; all values deliberately synthetic.
        byte[] key = new byte[32]; Arrays.fill(key, (byte) 0xab);
        String client = "12".repeat(16), server = "34".repeat(16);
        String query = "VWAG2 Q " + client + " 2a8e73c769529d27b3ad38e8cfa51c1808d58b20a91a1f614b28e76bffaa965c";
        String challenge = "VWAG2 C " + client + " " + server + " 1f1a808d2491f25cd03b391d5e30eb9f65c43729277fe749b360253b8d1e8f65";
        String ack = "VWAG2 A " + client + " " + server + " 302ad6c7ab17720aedfccc02ae022fe1b34c0dbc6964c948e5e5288da0c54af3";
        String response = "VWAG2 R " + client + " " + server + " 49122 25c76d5514c747a9a1f1de5c5bc671f3068a7a6560d17f2e5b84f6ffb23290b6";
        PortProtocol protocol = new PortProtocol(key); key[0] = 0; // private copy
        expect(protocol.makeReply(49122) == null);
        expect(protocol.begin(ascii(query + "\n"), server) == null);
        expect(protocol.begin(ascii(query.toUpperCase()), server) == null);
        expect(protocol.begin(ascii(query.replace("2a8", "3a8")), server) == null);
        expect(new String(protocol.begin(ascii(query), server), StandardCharsets.US_ASCII).equals(challenge));
        expect(protocol.begin(ascii(query), server) == null); // one session
        expect(!protocol.acceptAck(ascii(ack + "\n")));
        expect(!protocol.acceptAck(ascii(ack.replace(server, "56".repeat(16)))));
        expect(!protocol.acceptAck(ascii(ack.replace("302a", "402a"))));
        expect(protocol.makeReply(49122) == null); // no NSD response before authenticated A
        expect(protocol.acceptAck(ascii(ack)));
        expect(!protocol.acceptAck(ascii(ack))); // no second A
        expect(protocol.makeReply(0) == null && protocol.makeReply(65536) == null);
        expect(new String(protocol.makeReply(49122), StandardCharsets.US_ASCII).equals(response));
        expect(protocol.makeReply(49122) == null);
        protocol.close(); expect(!protocol.acceptAck(ascii(ack)) && protocol.makeReply(49122) == null);
        // A captured old Q can elicit a new challenge, but the captured A from a
        // previous process cannot trigger NSD when the server nonce is fresh.
        Arrays.fill(key, (byte) 0xab); PortProtocol restarted = new PortProtocol(key);
        expect(restarted.begin(ascii(query), "56".repeat(16)) != null);
        expect(!restarted.acceptAck(ascii(ack)) && restarted.makeReply(49122) == null);
        restarted.close(); Arrays.fill(key, (byte) 0);
        boolean badKey = false; try { new PortProtocol(new byte[31]); } catch (IllegalArgumentException e) { badKey = true; }
        expect(badKey);
        System.out.println("VWAG2 protocol tests passed");
    }
}
