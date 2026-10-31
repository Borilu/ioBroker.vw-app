'use strict';

// This check assumes the controller, Admin and other privileged ioBroker
// components are trusted. An adapter with message/database privileges can
// forge message fields; obj.user is not a cryptographic credential.
async function authenticatedAdminMessage(adapter, obj) {
    try {
        if (typeof obj?.from !== 'string' || !/^system\.adapter\.admin\.[0-9]+$/.test(obj.from) ||
            typeof obj.user !== 'string' || obj.user.length > 160 || !/^system\.user\.[A-Za-z0-9_.-]+$/.test(obj.user)) return false;
        const [instance, alive, user, group] = await Promise.all([
            adapter.getForeignObjectAsync(obj.from),
            adapter.getForeignStateAsync(obj.from + '.alive'),
            adapter.getForeignObjectAsync(obj.user),
            adapter.getForeignObjectAsync('system.group.administrator'),
        ]);
        // The saved configuration alone does not prove the currently running
        // Admin process adopted it. Require a subsequent alive transition.
        if (instance?._id !== obj.from || instance?.type !== 'instance' || instance.common?.enabled !== true ||
            instance.native?.auth !== true || !Number.isSafeInteger(instance.ts) || instance.ts <= 0 ||
            alive?.val !== true || !Number.isSafeInteger(alive.lc) || alive.lc < instance.ts) return false;
        if (user?._id !== obj.user || user?.type !== 'user' || user.common?.enabled !== true ||
            group?._id !== 'system.group.administrator' || group?.type !== 'group' || group.common?.enabled === false ||
            !Array.isArray(group.common?.members) || !group.common.members.includes(obj.user)) return false;
        return true;
    } catch (_) { return false; }
}

module.exports = { authenticatedAdminMessage };
