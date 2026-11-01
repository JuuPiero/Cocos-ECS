/**
 * A world: entities (its EntityManager) and the systems that update them
 * (Unity's World). Cocos games get a default world that updates by itself;
 * tests and tools can make and update their own.
 */
import { EntityManager } from './entity-manager';
import {
    BeginInitializationEntityCommandBufferSystem, BeginPresentationEntityCommandBufferSystem,
    BeginSimulationEntityCommandBufferSystem, ComponentSystemGroup, EndInitializationEntityCommandBufferSystem,
    EndSimulationEntityCommandBufferSystem, FixedStepSimulationSystemGroup, InitializationSystemGroup,
    PresentationSystemGroup, SimulationSystemGroup, SystemBase, SystemClass, isAutoCreated, setPendingWorld, systemOptions,
    systemRegistry,
} from './system';

export interface TimeData {
    /** Seconds since the previous update (the fixed timestep inside FixedStepSimulationSystemGroup). */
    deltaTime: number;
    /** Seconds since the world started. */
    elapsedTime: number;
    frameCount: number;
    /** Multiplies the frame time given to update (0 pauses, 0.5 is slow motion). */
    timeScale: number;
}

export class World {
    /** Every live world (debug windows). */
    static readonly all: World[] = [];
    /** The world the Cocos bootstrap creates and updates. */
    static defaultWorld: World | null = null;

    readonly name: string;
    readonly entityManager = new EntityManager();
    readonly time: TimeData = { deltaTime: 0, elapsedTime: 0, frameCount: 0, timeScale: 1 };
    private readonly systems = new Map<SystemClass, SystemBase>();
    /** Systems in creation order. */
    readonly systemList: SystemBase[] = [];
    disposed = false;

    constructor(name = 'World') {
        this.name = name;
        World.all.push(this);
    }

    /**
     * A world with the default groups (Initialization, Simulation with its
     * FixedStep group, Presentation and their command buffer systems) and
     * every @system class (Unity's DefaultWorldInitialization).
     */
    static createDefault(name = 'Default World', systems: SystemClass[] = systemRegistry.filter(isAutoCreated)): World {
        const w = new World(name);
        w.createDefaultGroups();
        for (const cls of systems) w.addSystem(cls);
        return w;
    }

    get initialization(): InitializationSystemGroup {
        return this.getOrCreateSystem(InitializationSystemGroup);
    }

    get simulation(): SimulationSystemGroup {
        return this.getOrCreateSystem(SimulationSystemGroup);
    }

    get presentation(): PresentationSystemGroup {
        return this.getOrCreateSystem(PresentationSystemGroup);
    }

    /** The three root groups and the built-in command buffer systems. */
    createDefaultGroups(): void {
        for (const cls of [
            BeginInitializationEntityCommandBufferSystem, EndInitializationEntityCommandBufferSystem,
            BeginSimulationEntityCommandBufferSystem, FixedStepSimulationSystemGroup, EndSimulationEntityCommandBufferSystem,
            BeginPresentationEntityCommandBufferSystem,
        ] as SystemClass[]) {
            this.addSystem(cls);
        }
    }

    private isRoot(s: SystemBase): boolean {
        return s instanceof InitializationSystemGroup || s instanceof SimulationSystemGroup || s instanceof PresentationSystemGroup;
    }

    /** The group a system updates in, and that group in its own parent (custom groups). */
    private attach(s: SystemBase): void {
        if (this.isRoot(s)) return;
        const groupCls = systemOptions(s.constructor as SystemClass).group || SimulationSystemGroup;
        const group = this.getOrCreateSystem(groupCls);
        group.addSystemToUpdateList(s);
        if (!this.isRoot(group) && !this.systemList.some((g) => g instanceof ComponentSystemGroup && g.systems.includes(group))) {
            this.attach(group);
        }
    }

    /** The system of this class, created (onCreate) on first use. Not added to any group. */
    getOrCreateSystem<T extends SystemBase>(cls: SystemClass<T>): T {
        let s = this.systems.get(cls) as T | undefined;
        if (s) return s;
        setPendingWorld(this);
        try {
            s = new cls();
        } finally {
            setPendingWorld(null);
        }
        this.systems.set(cls, s);
        this.systemList.push(s);
        s._create(this);
        return s;
    }

    getSystem<T extends SystemBase>(cls: SystemClass<T>): T | null {
        return (this.systems.get(cls) as T) ?? null;
    }

    /** Creates the system and adds it to its group (from @system, default SimulationSystemGroup). */
    addSystem<T extends SystemBase>(cls: SystemClass<T>): T {
        const s = this.getOrCreateSystem(cls);
        this.attach(s);
        return s;
    }

    destroySystem(cls: SystemClass): void {
        const s = this.systems.get(cls);
        if (!s) return;
        for (const g of this.systemList) if (g instanceof ComponentSystemGroup) g.removeSystemFromUpdateList(s);
        this.systems.delete(cls);
        this.systemList.splice(this.systemList.indexOf(s), 1);
        s._destroy();
    }

    /** Starts a frame: advances time (call once per frame before the groups). */
    beginFrame(dt: number): void {
        const d = dt * this.time.timeScale;
        this.time.deltaTime = d;
        this.time.elapsedTime += d;
        this.time.frameCount++;
    }

    /** One whole frame: time, then Initialization, Simulation and Presentation. */
    update(dt: number): void {
        if (this.disposed) return;
        this.beginFrame(dt);
        this.initialization.update();
        this.simulation.update();
        this.presentation.update();
    }

    dispose(): void {
        if (this.disposed) return;
        for (const s of [...this.systemList].reverse()) {
            try {
                s._destroy();
            } catch (e) {
                console.error(`[ECS] ${s.name} onDestroy:`, e);
            }
        }
        this.systems.clear();
        this.systemList.length = 0;
        this.disposed = true;
        const i = World.all.indexOf(this);
        if (i >= 0) World.all.splice(i, 1);
        if (World.defaultWorld === this) World.defaultWorld = null;
    }
}
