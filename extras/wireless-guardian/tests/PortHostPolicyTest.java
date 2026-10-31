package de.borilu.wirelessguardian;

public final class PortHostPolicyTest {
    public static void main(String[] args) {
        for (String host : new String[]{"192.168.88.3", "10.0.0.1", "172.16.2.3", "172.31.254.254"})
            if (!PortHostPolicy.validHost(host)) throw new AssertionError("valid LAN host rejected");
        for (String host : new String[]{"", "localhost", "192.168.88.03", "192.168.88.255", "192.168.88.0", "127.0.0.1",
                "8.8.8.8", "169.254.1.1", "172.15.1.1", "172.32.1.1", "192.169.1.1", "10.0.0.999", "[::1]", "10.0.0.1:99"})
            if (PortHostPolicy.validHost(host)) throw new AssertionError("invalid host accepted");
        if (PortHostPolicy.validHost(null)) throw new AssertionError("null host accepted");
        System.out.println("PortHostPolicy tests passed");
    }
}
