/**
 * Debug agent: lets the editor's Entities window look into running worlds
 * (Play in Editor and browser previews). Only in debug builds; it connects
 * to the ECS extension's WebSocket server on this machine and answers a fixed
 * set of requests (overview, entity list, one entity) and commands (toggle a
 * system, edit a field, enable / destroy an entity, time scale).
 */
import { Director, director } from 'cc';
import { DEBUG, EDITOR, EDITOR_NOT_IN_PREVIEW } from 'cc/env';
import { ComponentType, componentTypeByName, readValues } from '../core/component';
import type { Entity } from '../core/entity';
import { entityToString } from '../core/entity';
import { ComponentSystemGroup, SystemBase } from '../core/system';
import { Parent } from '../core/transforms';
import { World } from '../core/world';

/** Ports the editor tries (the first free one); the agent tries them in order. */
export const DEBUG_PORTS = [7461, 7462, 7463];

interface Request {
    id: number;
    what: string;
    params?: any;
}

let socket: WebSocket | null = null;
let portIndex = 0;
let retryTimer: any = null;
let fpsFrames = 0;
let fpsTime = 0;
let fps = 0;

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Frame rate shown in the window. */
function debugFrame(): void {
    fpsFrames++;
    const t = now();
    if (t - fpsTime >= 1000) {
        fps = (fpsFrames * 1000) / (t - fpsTime || 1);
        fpsFrames = 0;
        fpsTime = t;
    }
}

// ---------------------------------------------------------------- snapshots

function worldByName(name?: string): World | null {
    return World.all.find((w) => w.name === name) || World.defaultWorld || World.all[0] || null;
}

function systemTree(w: World, s: SystemBase, ids: Map<SystemBase, number>): any {
    const node: any = {
        id: ids.get(s),
        name: s.name,
        enabled: s.enabled,
        running: s.running,
        ms: Math.round(s.avgMs * 1000) / 1000,
        entities: s.queries.reduce((n, q) => n + q.count(), 0),
        group: s instanceof ComponentSystemGroup,
    };
    if (s instanceof ComponentSystemGroup) node.children = s.systems.map((c) => systemTree(w, c, ids));
    return node;
}

function overview(params: any): any {
    const worlds = World.all.map((w) => ({ name: w.name, entities: w.entityManager.entityCount }));
    const w = worldByName(params?.world);
    if (!w) return { worlds, fps };
    const ids = new Map(w.systemList.map((s, i) => [s, i] as [SystemBase, number]));
    const roots = [w.initialization, w.simulation, w.presentation].map((g) => systemTree(w, g, ids));
    const archetypes = w.entityManager.archetypes
        .filter((a) => a.count > 0 || params?.emptyArchetypes)
        .map((a) => ({ id: a.id, types: a.types.map((t) => t.name), count: a.count, capacity: a.capacity, bytes: a.bytes() }));
    return {
        worlds,
        world: w.name,
        fps: Math.round(fps * 10) / 10,
        time: { ...w.time },
        entityCount: w.entityManager.entityCount,
        systems: roots,
        archetypes,
    };
}

/** Entity list, filtered by name text and component names ("c:Velocity" style is parsed by the window). */
function entities(params: any): any {
    const w = worldByName(params?.world);
    if (!w) return { total: 0, items: [] };
    const em = w.entityManager;
    const text = String(params?.text || '').toLowerCase();
    const comps: ComponentType[] = (params?.components || []).map((n: string) => componentTypeByName(n)).filter(Boolean);
    const offset = Math.max(0, params?.offset | 0);
    const limit = Math.min(1000, Math.max(1, params?.limit | 0 || 200));
    const items: any[] = [];
    let total = 0;
    const parentType = componentTypeByName('Parent');
    for (const a of em.archetypes) {
        if (!a.count) continue;
        if (comps.length && !comps.every((t) => a.has(t))) continue;
        if (!params?.includePrefabs && a.has(em.prefabType)) continue;
        const parents = parentType && a.has(parentType) ? (a.get(Parent).value as Int32Array) : null;
        for (let i = 0; i < a.count; i++) {
            const e = a.entities[i];
            const name = em.getName(e);
            if (text && !(name.toLowerCase().includes(text) || entityToString(e).toLowerCase().includes(text))) continue;
            if (total >= offset && items.length < limit) {
                items.push({ e, name, archetype: a.id, parent: parents ? parents[i] : 0, disabled: a.has(em.disabledType), prefab: a.has(em.prefabType) });
            }
            total++;
        }
    }
    return { total, items };
}

/** Readable stand-in for a JS value (assets, nodes, arrays, objects). */
function summarize(v: any, depth = 0): any {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'number' || t === 'string' || t === 'boolean') return v;
    if (t === 'function') return { kind: 'function' };
    if (Array.isArray(v)) {
        return { kind: 'array', length: v.length, items: depth > 1 ? [] : v.slice(0, 20).map((x) => summarize(x, depth + 1)) };
    }
    const cc = (globalThis as any).cc;
    const cls = cc?.js?.getClassName?.(v) || v.constructor?.name || 'Object';
    if (v._uuid !== undefined && typeof v.name === 'string') return { kind: 'asset', type: cls, name: v.name, uuid: v._uuid };
    if (cc && v instanceof cc.Node) return { kind: 'node', type: 'cc.Node', name: v.name, uuid: v.uuid, valid: v.isValid };
    if (depth > 1) return { kind: 'object', type: cls };
    const fields: Record<string, any> = {};
    for (const k of Object.keys(v).slice(0, 20)) fields[k] = summarize(v[k], depth + 1);
    return { kind: 'object', type: cls, fields };
}

function entity(params: any): any {
    const w = worldByName(params?.world);
    const e: Entity = params?.e | 0;
    if (!w || !w.entityManager.exists(e)) return null;
    const em = w.entityManager;
    const loc = em.location(e)!;
    const components = loc.archetype.types.map((t) => {
        const values = readValues(loc.archetype.column(t)!, loc.row);
        const fields = t.fields.map((f) => ({
            name: f.name,
            kind: f.kind,
            value: f.kind === 'ref' ? summarize(values[f.name]) : values[f.name],
            entityName: f.kind === 'entity' && values[f.name] ? em.getName(values[f.name]) || entityToString(values[f.name]) : undefined,
        }));
        return { name: t.name, tag: t.isTag, fields };
    });
    return { e, text: entityToString(e), name: em.getName(e), archetype: loc.archetype.id, enabled: em.isEnabled(e), components };
}

// ----------------------------------------------------------------- commands

function command(params: any): any {
    const w = worldByName(params?.world);
    if (!w) return { ok: false, error: 'no world' };
    const em = w.entityManager;
    switch (params?.op) {
        case 'setSystemEnabled': {
            const s = w.systemList[params.id | 0];
            if (!s) return { ok: false, error: 'no such system' };
            s.enabled = !!params.enabled;
            return { ok: true };
        }
        case 'setField': {
            const e = params.e | 0;
            const t = componentTypeByName(params.component);
            if (!t || !em.exists(e) || !em.hasComponent(e, t)) return { ok: false, error: 'no such component' };
            const f = t.fields.find((x) => x.name === params.field);
            if (!f || f.kind === 'ref') return { ok: false, error: 'not editable' };
            const v = f.kind === 'bool' ? !!params.value : Number(params.value);
            if (f.kind !== 'bool' && !Number.isFinite(v as number)) return { ok: false, error: 'not a number' };
            (em.getComponent(e, t) as any)[f.name] = v;
            return { ok: true };
        }
        case 'setEnabled': {
            const e = params.e | 0;
            if (!em.exists(e)) return { ok: false, error: 'no such entity' };
            em.setEnabled(e, !!params.enabled);
            return { ok: true };
        }
        case 'destroy': {
            em.destroyEntity(params.e | 0);
            return { ok: true };
        }
        case 'timeScale': {
            const v = Number(params.value);
            if (Number.isFinite(v) && v >= 0) w.time.timeScale = v;
            return { ok: true };
        }
    }
    return { ok: false, error: 'unknown command' };
}

/** Answers one request from the Entities window (also used directly by tests and tools). */
export function debugAnswer(req: { what: string; params?: any }): any {
    return answer({ id: 0, ...req });
}

function answer(req: Request): any {
    try {
        switch (req.what) {
            case 'overview': return overview(req.params);
            case 'entities': return entities(req.params);
            case 'entity': return entity(req.params);
            case 'command': return command(req.params);
        }
        return { error: `unknown request ${req.what}` };
    } catch (e) {
        return { error: String((e as Error)?.message || e) };
    }
}

// --------------------------------------------------------------- connection

/** Where the editor may be: the preview page's host (a phone on the LAN), then this machine. */
function hosts(): string[] {
    let h = '';
    try {
        h = (globalThis as any).location?.hostname || '';
    } catch {
        // no location (native)
    }
    return h && h !== '127.0.0.1' && h !== 'localhost' ? [h, '127.0.0.1'] : ['127.0.0.1'];
}

function connect(): void {
    if (typeof WebSocket === 'undefined') return;
    const list = hosts();
    const port = DEBUG_PORTS[portIndex % DEBUG_PORTS.length];
    const host = list[Math.floor(portIndex / DEBUG_PORTS.length) % list.length];
    let ws: WebSocket;
    try {
        ws = new WebSocket(`ws://${host}:${port}/ecs`);
    } catch {
        schedule();
        return;
    }
    let opened = false;
    ws.onopen = () => {
        opened = true;
        socket = ws;
        const loc = (globalThis as any).location;
        ws.send(JSON.stringify({
            type: 'hello',
            runtime: EDITOR ? 'Play in Editor' : 'Preview',
            url: loc ? String(loc.href) : '',
            agent: (globalThis as any).navigator?.userAgent || '',
        }));
    };
    ws.onmessage = (ev: MessageEvent) => {
        let req: Request;
        try {
            req = JSON.parse(String(ev.data));
        } catch {
            return;
        }
        if (typeof req?.id !== 'number') return;
        ws.send(JSON.stringify({ type: 'reply', id: req.id, data: answer(req) }));
    };
    ws.onclose = () => {
        if (socket === ws) socket = null;
        if (!opened) portIndex++;
        schedule(opened ? 1000 : 3000);
    };
    ws.onerror = () => {
        // onclose follows
    };
}

function schedule(delay = 3000): void {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
}

/** True when the editor's Entities window is connected. */
export function debugConnected(): boolean {
    return !!socket && socket.readyState === 1;
}

if (DEBUG && !EDITOR_NOT_IN_PREVIEW) {
    fpsTime = now();
    director.on(Director.EVENT_AFTER_UPDATE, debugFrame);
    setTimeout(connect, 500);
}
