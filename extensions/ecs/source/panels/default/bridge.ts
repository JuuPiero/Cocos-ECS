/**
 * What the Entities window needs from the editor: the connected games and a
 * way to send them requests. Behind an interface so the window can run in a
 * plain page with a fake (tests/preview).
 */
export interface ClientInfo {
    id: number;
    runtime: string;
    url: string;
    agent: string;
    since: number;
}

export interface DebugStatus {
    clients: ClientInfo[];
    port: number;
    host: string;
    error: string;
    running: boolean;
}

export interface DebugBridge {
    status(): Promise<DebugStatus>;
    request(clientId: number, what: string, params?: any): Promise<any>;
    onClients(cb: (clients: ClientInfo[]) => void): () => void;
    setLan(on: boolean): Promise<DebugStatus>;
    loadSettings(): Promise<any>;
    saveSettings(s: any): void;
}

const PKG = 'ecs';

export function editorBridge(): DebugBridge {
    const req = (msg: string, ...args: any[]) => (Editor.Message.request as any)(PKG, msg, ...args);
    return {
        status: () => req('debug-status'),
        request: (clientId, what, params) => req('debug-request', clientId, what, params),
        onClients(cb) {
            const api = (Editor.Message as any).__protected__ || Editor.Message;
            const fn = (clients: ClientInfo[]) => cb(clients);
            api.addBroadcastListener?.('ecs:debug-clients', fn);
            return () => api.removeBroadcastListener?.('ecs:debug-clients', fn);
        },
        setLan: (on) => req('set-lan', on),
        async loadSettings() {
            try {
                return await Editor.Profile.getConfig(PKG, 'window');
            } catch {
                return null;
            }
        },
        saveSettings(s) {
            Editor.Profile.setConfig(PKG, 'window', s, 'global').catch?.(() => undefined);
        },
    };
}
