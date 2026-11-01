import { DebugServer } from './debug-server';

const PKG = 'ecs';

const server = new DebugServer(() => {
    try {
        Editor.Message.broadcast('ecs:debug-clients', server.list());
    } catch {
        // editor shutting down
    }
});

function status() {
    return { clients: server.list(), port: server.port, host: server.host, error: server.error, running: server.running };
}

export const methods: Record<string, (...args: any[]) => any> = {
    openPanel() {
        Editor.Panel.open(PKG);
    },

    /** Connected games and the server's state. */
    debugStatus() {
        return status();
    },

    /** Forwards a request of the Entities window to a game (clientId 0: the first one). */
    debugRequest(clientId: number, what: string, params: any) {
        return server.request(clientId, what, params);
    },

    /** Accept games from other devices on the network (phones running a preview). */
    async setLan(on: boolean) {
        try {
            await Editor.Profile.setConfig(PKG, 'lan', !!on, 'global');
        } catch {
            // not saved
        }
        await server.start(!!on);
        return status();
    },
};

export async function load() {
    let lan = false;
    try {
        lan = !!(await Editor.Profile.getConfig(PKG, 'lan'));
    } catch {
        // default
    }
    await server.start(lan);
    if (!server.running) console.warn(`[ECS] Debug server could not start: ${server.error}`);
}

export async function unload() {
    await server.stop();
}
