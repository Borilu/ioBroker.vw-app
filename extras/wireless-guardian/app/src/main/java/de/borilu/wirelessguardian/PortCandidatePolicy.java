package de.borilu.wirelessguardian;

import java.util.Collection;

/** Accept only a single completed, unambiguous local service. */
final class PortCandidatePolicy {
    static int choose(boolean failed, int pending, Collection<Integer> ownPorts) {
        if (failed || pending != 0 || ownPorts == null || ownPorts.size() != 1) return 0;
        Integer port = ownPorts.iterator().next();
        return port != null && port >= 1 && port <= 65535 ? port : 0;
    }
    private PortCandidatePolicy() { }
}
