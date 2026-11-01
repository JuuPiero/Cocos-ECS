/**
 * Editor side of the debug bridge: a WebSocket server the running games
 * (Play in Editor, browser previews) connect to. The Entities window sends
 * requests through the main process; each game answers from its debug agent
 * (assets/debug/agent.ts).
 */
import type { IncomingMessage } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

export const DEBUG_PORTS = [7461, 7462, 7463];

export interface ClientInfo {
    id: number;
    runtime: string;
    url: string;
    agent: string;
    since: number;
}

interface Client extends ClientInfo {
    ws: WebSocket;
    pending: Map<number, { resolve: (v: any) => void; timer: any }>;
    nextId: number;
}

export class DebugServer {
    private server: WebSocketServer | null = null;
    private clients = new Map<number, Client>();
    private nextClient = 1;
    port = 0;
    host = '';
    error = '';

    constructor(private readonly onChange: () => void) {}

    get running(): boolean {
        return !!this.server;
    }

    /** Listens on the first free port (127.0.0.1, or every interface with `lan`). */
    async start(lan: boolean): Promise<void> {
        await this.stop();
        this.host = lan ? '0.0.0.0' : '127.0.0.1';
        for (const port of DEBUG_PORTS) {
            try {
                this.server = await listen(this.host, port);
                this.port = port;
                this.error = '';
                this.server.on('connection', (ws, req) => this.accept(ws, req));
                return;
            } catch (e) {
                this.error = String((e as Error)?.message || e);
            }
        }
        this.server = null;
        this.port = 0;
    }

    async stop(): Promise<void> {
        for (const c of this.clients.values()) c.ws.terminate();
        this.clients.clear();
        const s = this.server;
        this.server = null;
        if (s) await new Promise<void>((r) => s.close(() => r()));
        this.onChange();
    }

    list(): ClientInfo[] {
        return [...this.clients.values()].map(({ id, runtime, url, agent, since }) => ({ id, runtime, url, agent, since }));
    }

    /** Sends a request to a game and resolves with its answer (null after `timeout` ms). */
    request(clientId: number, what: string, params: any, timeout = 3000): Promise<any> {
        const c = this.clients.get(clientId) || (clientId === 0 ? [...this.clients.values()][0] : undefined);
        if (!c || c.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
        const id = c.nextId++;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                c.pending.delete(id);
                resolve(null);
            }, timeout);
            c.pending.set(id, { resolve, timer });
            c.ws.send(JSON.stringify({ id, what, params }));
        });
    }

    private accept(ws: WebSocket, req: IncomingMessage): void {
        if (!(req.url || '').startsWith('/ecs')) {
            ws.close();
            return;
        }
        let client: Client | null = null;
        ws.on('message', (raw) => {
            let msg: any;
            try {
                msg = JSON.parse(String(raw));
            } catch {
                return;
            }
            if (msg?.type === 'hello' && !client) {
                client = {
                    id: this.nextClient++,
                    runtime: String(msg.runtime || 'Game'),
                    url: String(msg.url || ''),
                    agent: String(msg.agent || ''),
                    since: Date.now(),
                    ws,
                    pending: new Map(),
                    nextId: 1,
                };
                this.clients.set(client.id, client);
                this.onChange();
            } else if (msg?.type === 'reply' && client) {
                const p = client.pending.get(msg.id);
                if (p) {
                    clearTimeout(p.timer);
                    client.pending.delete(msg.id);
                    p.resolve(msg.data);
                }
            }
        });
        ws.on('close', () => {
            if (!client) return;
            for (const p of client.pending.values()) {
                clearTimeout(p.timer);
                p.resolve(null);
            }
            this.clients.delete(client.id);
            this.onChange();
        });
        ws.on('error', () => undefined);
    }
}

function listen(host: string, port: number): Promise<WebSocketServer> {
    return new Promise((resolve, reject) => {
        const s = new WebSocketServer({ host, port });
        s.once('listening', () => resolve(s));
        s.once('error', (e) => {
            s.close();
            reject(e);
        });
    });
}
