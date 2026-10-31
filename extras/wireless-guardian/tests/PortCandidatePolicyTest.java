package de.borilu.wirelessguardian;

import java.util.Arrays;
import java.util.Collections;

public final class PortCandidatePolicyTest {
    public static void main(String[] args) {
        if (PortCandidatePolicy.choose(false, 0, Collections.singletonList(49122)) != 49122) throw new AssertionError();
        if (PortCandidatePolicy.choose(true, 0, Collections.singletonList(49122)) != 0) throw new AssertionError();
        if (PortCandidatePolicy.choose(false, 1, Collections.singletonList(49122)) != 0) throw new AssertionError();
        if (PortCandidatePolicy.choose(false, 0, Arrays.asList(49122, 49122)) != 0) throw new AssertionError();
        if (PortCandidatePolicy.choose(false, 0, Arrays.asList(49122, 49123)) != 0) throw new AssertionError();
        for (Integer value : Arrays.asList(0, -1, 65536, null))
            if (PortCandidatePolicy.choose(false, 0, Collections.singletonList(value)) != 0) throw new AssertionError();
        if (PortCandidatePolicy.choose(false, 0, Collections.emptyList()) != 0) throw new AssertionError();
        System.out.println("PortCandidatePolicy tests passed");
    }
}
