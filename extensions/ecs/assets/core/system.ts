/**
 * Systems (Unity's SystemBase) and system groups.
 *
 *     @system({ updateAfter: [SpawnSystem] })
 *     export class MoveSystem extends SystemBase {
 *         private movers = this.query(Position, Velocity);
 *         onUpdate() {
 *             const dt = this.time.deltaTime;
 *             this.movers.forEach((e, p, v) => { p.x += v.x * dt; p.y += v.y * dt; });
 *         }
 *     }
 *
 * @system classes are created in every default world, in the group given
 * (SimulationSystemGroup by default) and ordered by updateBefore / updateAfter.
 */
import { EntityCommandBuffer } from './command-buffer';
import { ComponentClass, ComponentType, ComponentValues, clock, typeOf } from './component';
import type { Entity } from './entity';
import type { EntityManager } from './entity-manager';
import { EntityQuery, QueryDesc, queryKey } from './query';
import type { World } from './world';

export type SystemClass<T extends SystemBase = SystemBase> = new () => T;

export interface SystemOptions {
    /** Group the system updates in (default SimulationSystemGroup). */
    group?: SystemClass<ComponentSystemGroup>;
    updateBefore?: SystemClass[];
    updateAfter?: SystemClass[];
    /** First / last in its group (before the before/after ordering). */
    orderFirst?: boolean;
    orderLast?: boolean;
    /** Name in the debug windows (class names are minified in builds). */
    name?: string;
}

const OPTIONS = '__ecsSystem__';
const NO_AUTO = '__ecsNoAuto__';

/** Every @system class, in registration order (default world initialization). */
export const systemRegistry: SystemClass[] = [];
const registryListeners: ((cls: SystemClass) => void)[] = [];

export function onSystemRegistered(fn: (cls: SystemClass) => void): () => void {
    registryListeners.push(fn);
    return () => registryListeners.splice(registryListeners.indexOf(fn), 1);
}

/** Registers a system class for the default worlds (Unity creates every system automatically). */
export function system(options: SystemOptions = {}) {
    return function <T extends SystemClass>(cls: T): T {
        Object.defineProperty(cls, OPTIONS, { value: options, enumerable: false, configurable: true });
        // Scripts reloaded in the editor: replace the older class of the same name.
        const name = options.name || cls.name;
        const old = systemRegistry.findIndex((c) => systemName(c) === name);
        if (old >= 0) systemRegistry.splice(old, 1);
        systemRegistry.push(cls);
        for (const fn of registryListeners) fn(cls);
        return cls;
    };
}

/** Keeps a system out of the default worlds (create it yourself with world.addSystem). */
export function disableAutoCreation<T extends SystemClass>(cls: T): T {
    Object.defineProperty(cls, NO_AUTO, { value: true, enumerable: false });
    return cls;
}

export function systemOptions(cls: SystemClass): SystemOptions {
    return Object.prototype.hasOwnProperty.call(cls, OPTIONS) ? (cls as any)[OPTIONS] : {};
}

export function isAutoCreated(cls: SystemClass): boolean {
    return !Object.prototype.hasOwnProperty.call(cls, NO_AUTO);
}

export function systemName(cls: SystemClass): string {
    return systemOptions(cls).name || cls.name;
}

const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();

export abstract class SystemBase {
    /** The world that owns the system (set before onCreate). */
    world!: World;
    /** Disabled systems don't update (onStopRunning is called once). */
    enabled = true;
    /** Version of the last update: change filters compare column versions with it. */
    lastSystemVersion = 0;
    /** Milliseconds of the last update and a smoothed average (debug windows). */
    lastMs = 0;
    avgMs = 0;
    /** Whether onUpdate ran last frame. */
    running = false;

    private readonly _queries = new Map<string, EntityQuery>();
    private readonly _required: EntityQuery[] = [];

    get name(): string {
        return systemName(this.constructor as SystemClass);
    }

    get entityManager(): EntityManager {
        return this.world.entityManager;
    }

    get time() {
        return this.world.time;
    }

    /** Every query this system made (debug). */
    get queries(): EntityQuery[] {
        return [...this._queries.values()];
    }

    protected onCreate(): void {}
    protected onStartRunning(): void {}
    protected abstract onUpdate(): void;
    protected onStopRunning(): void {}
    protected onDestroy(): void {}

    /** Entities with all of these components (cached per system). Usable in field initializers. */
    protected query<T extends ComponentClass[]>(...all: T): EntityQuery<T> {
        return this.getQuery({ all }) as EntityQuery<T>;
    }

    /** A query from a full description (cached per system). */
    protected getQuery(desc: QueryDesc): EntityQuery {
        const key = queryKey(desc);
        let q = this._queries.get(key);
        if (!q) {
            q = this.lazyManager().createQuery(desc);
            this._queries.set(key, q);
        }
        return q;
    }

    /** onUpdate only runs while every required query has entities. */
    protected requireForUpdate(q: EntityQuery | ComponentClass | ComponentType): void {
        const query = q instanceof EntityQuery ? q : this.getQuery({ all: [q] });
        if (!this._required.includes(query)) this._required.push(query);
    }

    protected getSingleton<T>(type: ComponentClass<T> | ComponentType): T {
        return this.entityManager.getSingleton(type);
    }

    protected setSingleton<T>(type: ComponentClass<T> | ComponentType, values: ComponentValues<T>): Entity {
        return this.entityManager.setSingleton(type, values);
    }

    protected hasSingleton(type: ComponentClass | ComponentType): boolean {
        return this.entityManager.hasSingleton(type);
    }

    /** A command buffer played back by an EntityCommandBufferSystem of this world. */
    protected commandBuffer(at: SystemClass<EntityCommandBufferSystem>): EntityCommandBuffer {
        return this.world.getOrCreateSystem(at).createCommandBuffer();
    }

    /** Field initializers run before the world is set: queries made there wait for it. */
    private lazyManager(): EntityManager {
        const w = this.world || pendingWorld;
        if (!w) throw new Error(`${this.name}: queries need the world (create systems with world.addSystem / getOrCreateSystem).`);
        return w.entityManager;
    }

    /** @internal Called by the world after `world` is set. */
    _create(world: World): void {
        this.world = world;
        this.onCreate();
    }

    /** @internal */
    _destroy(): void {
        if (this.running) this.onStopRunning();
        this.running = false;
        this.onDestroy();
    }

    /** Runs the system once (if enabled and its requirements are met). */
    update(): void {
        const should = this.enabled && this._required.every((q) => !q.isEmpty());
        if (!should) {
            if (this.running) {
                this.running = false;
                this.onStopRunning();
            }
            return;
        }
        if (!this.running) {
            this.running = true;
            this.onStartRunning();
        }
        const since = this.lastSystemVersion;
        clock.version++;
        for (const q of this._queries.values()) q.changedSince = since;
        const t0 = now();
        try {
            this.onUpdate();
        } finally {
            this.lastMs = now() - t0;
            this.avgMs = this.avgMs ? this.avgMs * 0.9 + this.lastMs * 0.1 : this.lastMs;
            this.lastSystemVersion = clock.version;
            // Writes made after this system (other systems, scripts) get a newer version than it saw.
            clock.version++;
        }
    }
}

/** Set while a world constructs a system, so field initializers can make queries. */
export let pendingWorld: World | null = null;
export function setPendingWorld(w: World | null): void {
    pendingWorld = w;
}

/** A system that updates other systems in order (Unity's ComponentSystemGroup). */
export class ComponentSystemGroup extends SystemBase {
    readonly systems: SystemBase[] = [];
    private sorted = true;

    addSystemToUpdateList(s: SystemBase): void {
        if (this.systems.includes(s)) return;
        this.systems.push(s);
        this.sorted = false;
    }

    removeSystemFromUpdateList(s: SystemBase): void {
        const i = this.systems.indexOf(s);
        if (i >= 0) this.systems.splice(i, 1);
    }

    /** Orders the systems: orderFirst, then by updateBefore / updateAfter, then orderLast (stable). */
    sortSystems(): void {
        const list = this.systems;
        const index = new Map(list.map((s, i) => [s.constructor as SystemClass, i]));
        const n = list.length;
        const after: Set<number>[] = list.map(() => new Set<number>()); // i must run after these
        list.forEach((s, i) => {
            const o = systemOptions(s.constructor as SystemClass);
            for (const c of o.updateAfter || []) {
                const j = index.get(c);
                if (j !== undefined) after[i].add(j);
            }
            for (const c of o.updateBefore || []) {
                const j = index.get(c);
                if (j !== undefined) after[j].add(i);
            }
        });
        const rank = (s: SystemBase) => {
            const o = systemOptions(s.constructor as SystemClass);
            return o.orderFirst ? 0 : o.orderLast ? 2 : 1;
        };
        const done = new Set<number>();
        const out: SystemBase[] = [];
        while (out.length < n) {
            let pick = -1;
            for (let i = 0; i < n; i++) {
                if (done.has(i) || [...after[i]].some((j) => !done.has(j))) continue;
                if (pick < 0 || rank(list[i]) < rank(list[pick])) pick = i;
            }
            if (pick < 0) {
                // A cycle: keep the remaining ones in their current order.
                const rest = list.map((_, i) => i).filter((i) => !done.has(i));
                console.warn(`[ECS] ${this.name}: circular updateBefore/updateAfter between ${rest.map((i) => list[i].name).join(', ')}.`);
                pick = rest[0];
            }
            done.add(pick);
            out.push(list[pick]);
        }
        this.systems.length = 0;
        this.systems.push(...out);
        this.sorted = true;
    }

    protected onUpdate(): void {
        if (!this.sorted) this.sortSystems();
        for (const s of this.systems) {
            try {
                s.update();
            } catch (e) {
                console.error(`[ECS] ${s.name}:`, e);
            }
        }
    }
}

export class InitializationSystemGroup extends ComponentSystemGroup {}
export class SimulationSystemGroup extends ComponentSystemGroup {}
export class PresentationSystemGroup extends ComponentSystemGroup {}

/**
 * Updates its systems at a fixed rate (Unity's FixedStepSimulationSystemGroup):
 * zero or more times per frame, with time.deltaTime = timestep.
 */
export class FixedStepSimulationSystemGroup extends ComponentSystemGroup {
    timestep = 1 / 60;
    /** Most fixed steps in one frame (avoids a spiral after a hitch). */
    maxSteps = 4;
    private accumulator = 0;

    protected onUpdate(): void {
        const t = this.world.time;
        const frameDt = t.deltaTime;
        this.accumulator = Math.min(this.accumulator + frameDt, this.timestep * this.maxSteps);
        const savedElapsed = t.elapsedTime;
        try {
            while (this.accumulator >= this.timestep) {
                this.accumulator -= this.timestep;
                t.deltaTime = this.timestep;
                super.onUpdate();
            }
        } finally {
            t.deltaTime = frameDt;
            t.elapsedTime = savedElapsed;
        }
    }
}

/** Plays back the command buffers made from it once per update (Unity's EntityCommandBufferSystem). */
export class EntityCommandBufferSystem extends SystemBase {
    private pending: EntityCommandBuffer[] = [];

    createCommandBuffer(): EntityCommandBuffer {
        const b = new EntityCommandBuffer();
        this.pending.push(b);
        return b;
    }

    protected onUpdate(): void {
        const list = this.pending;
        this.pending = [];
        for (const b of list) b.playback(this.entityManager);
    }
}

export class BeginInitializationEntityCommandBufferSystem extends EntityCommandBufferSystem {}
export class EndInitializationEntityCommandBufferSystem extends EntityCommandBufferSystem {}
export class BeginSimulationEntityCommandBufferSystem extends EntityCommandBufferSystem {}
export class EndSimulationEntityCommandBufferSystem extends EntityCommandBufferSystem {}
export class BeginPresentationEntityCommandBufferSystem extends EntityCommandBufferSystem {}

/** Options without registering for auto creation (built-in systems). */
export function setSystemOptions(cls: SystemClass, options: SystemOptions): void {
    Object.defineProperty(cls, OPTIONS, { value: options, enumerable: false, configurable: true });
}

setSystemOptions(InitializationSystemGroup, { name: 'InitializationSystemGroup' });
setSystemOptions(SimulationSystemGroup, { name: 'SimulationSystemGroup' });
setSystemOptions(PresentationSystemGroup, { name: 'PresentationSystemGroup' });
setSystemOptions(BeginInitializationEntityCommandBufferSystem, { group: InitializationSystemGroup, orderFirst: true, name: 'BeginInitializationEntityCommandBufferSystem' });
setSystemOptions(EndInitializationEntityCommandBufferSystem, { group: InitializationSystemGroup, orderLast: true, name: 'EndInitializationEntityCommandBufferSystem' });
setSystemOptions(BeginSimulationEntityCommandBufferSystem, { group: SimulationSystemGroup, orderFirst: true, name: 'BeginSimulationEntityCommandBufferSystem' });
setSystemOptions(FixedStepSimulationSystemGroup, {
    group: SimulationSystemGroup, orderFirst: true, updateAfter: [BeginSimulationEntityCommandBufferSystem], name: 'FixedStepSimulationSystemGroup',
});
setSystemOptions(EndSimulationEntityCommandBufferSystem, { group: SimulationSystemGroup, orderLast: true, name: 'EndSimulationEntityCommandBufferSystem' });
setSystemOptions(BeginPresentationEntityCommandBufferSystem, { group: PresentationSystemGroup, orderFirst: true, name: 'BeginPresentationEntityCommandBufferSystem' });

export { typeOf };
