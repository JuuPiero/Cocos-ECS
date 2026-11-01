/**
 * Creates and destroys entities and changes their components (Unity's
 * EntityManager). Adding or removing a component moves the entity to another
 * archetype; during a query's forEach that isn't allowed: use an
 * EntityCommandBuffer.
 */
import { Archetype, archetypeKey } from './archetype';
import { Disabled, EntityName, LinkedEntityGroup, Prefab } from './builtin';
import {
    ComponentClass, ComponentType, ComponentValues, ComponentView, readValues, typeOf,
} from './component';
import { Entity, MAX_ENTITIES, NULL_ENTITY, entityIndex, entityToString, entityVersion, makeEntity, nextVersion } from './entity';
import { EntityQuery, QueryDesc, QueryHost } from './query';

type TypeArg = ComponentClass | ComponentType;

export class EntityManager implements QueryHost {
    readonly archetypes: Archetype[] = [];
    private readonly byKey = new Map<string, Archetype>();
    private readonly queries: EntityQuery[] = [];
    readonly empty: Archetype;
    readonly disabledType = typeOf(Disabled);
    readonly prefabType = typeOf(Prefab);
    private readonly linkedType = typeOf(LinkedEntityGroup);

    // Entity records, by index.
    private versions = new Uint16Array(1024);
    private archOf = new Int32Array(1024).fill(-1);
    private rowOf = new Int32Array(1024);
    private free: number[] = [];
    private nextIndex = 1; // 0 is the null entity
    private alive = 0;
    private readonly names = new Map<number, string>();
    private iterating = 0;
    /** Bumped on every structural change (debug views). */
    structureVersion = 0;
    private destroyListeners: ((e: Entity) => void)[] = [];
    private destroying = new Set<Entity>();

    /** Called with each entity just before it is destroyed (e.g. to destroy linked nodes). */
    onDestroyEntity(fn: (e: Entity) => void): () => void {
        this.destroyListeners.push(fn);
        return () => {
            const i = this.destroyListeners.indexOf(fn);
            if (i >= 0) this.destroyListeners.splice(i, 1);
        };
    }

    constructor() {
        this.empty = this.archetypeOf([]);
    }

    // ------------------------------------------------------------ archetypes

    /** The archetype for exactly these component types (created on demand). */
    archetypeOf(types: TypeArg[]): Archetype {
        const list = Array.from(new Set(types.map(typeOf)));
        const key = archetypeKey(list);
        let a = this.byKey.get(key);
        if (!a) {
            a = new Archetype(this.archetypes.length, list);
            this.archetypes.push(a);
            this.byKey.set(key, a);
            for (const q of this.queries) q.consider(a);
        }
        return a;
    }

    private withType(a: Archetype, t: ComponentType): Archetype {
        let next = a.addEdges.get(t.id);
        if (!next) {
            next = this.archetypeOf([...a.types, t]);
            a.addEdges.set(t.id, next);
            next.removeEdges.set(t.id, a);
        }
        return next;
    }

    private withoutType(a: Archetype, t: ComponentType): Archetype {
        let next = a.removeEdges.get(t.id);
        if (!next) {
            next = this.archetypeOf(a.types.filter((x) => x !== t));
            a.removeEdges.set(t.id, next);
            next.addEdges.set(t.id, a);
        }
        return next;
    }

    // ----------------------------------------------------------------- query

    beginIteration(): void {
        this.iterating++;
    }

    endIteration(): void {
        this.iterating--;
    }

    private assertStructural(what: string): void {
        if (this.iterating > 0) {
            throw new Error(`${what} during a query's forEach: record it in an EntityCommandBuffer and play it back after.`);
        }
    }

    createQuery<T extends any[] = any[]>(desc: QueryDesc): EntityQuery<T> {
        const q = new EntityQuery<T>(this, desc);
        this.queries.push(q);
        return q;
    }

    /** Shortcut: entities with all of these components (typed views in forEach). */
    query<T extends ComponentClass[]>(...all: T): EntityQuery<T> {
        return this.createQuery<T>({ all });
    }

    // -------------------------------------------------------------- entities

    get entityCount(): number {
        return this.alive;
    }

    private allocIndex(): number {
        if (this.free.length) return this.free.pop()!;
        const index = this.nextIndex++;
        if (index >= MAX_ENTITIES) throw new Error(`Too many entities (max ${MAX_ENTITIES - 1}).`);
        if (index >= this.versions.length) {
            let n = this.versions.length * 2;
            while (n <= index) n *= 2;
            const v = new Uint16Array(n);
            v.set(this.versions);
            this.versions = v;
            const a = new Int32Array(n).fill(-1);
            a.set(this.archOf);
            this.archOf = a;
            const r = new Int32Array(n);
            r.set(this.rowOf);
            this.rowOf = r;
        }
        return index;
    }

    private place(a: Archetype): Entity {
        const index = this.allocIndex();
        const e = makeEntity(index, this.versions[index]);
        this.archOf[index] = a.id;
        this.rowOf[index] = a.add(e);
        this.alive++;
        return e;
    }

    /** A new entity with these components (default values). */
    createEntity(...types: TypeArg[]): Entity {
        this.assertStructural('createEntity');
        this.structureVersion++;
        return this.place(types.length ? this.archetypeOf(types) : this.empty);
    }

    /** `count` new entities with these components (faster than one by one). */
    createEntities(count: number, ...types: TypeArg[]): Entity[] {
        this.assertStructural('createEntities');
        this.structureVersion++;
        const a = types.length ? this.archetypeOf(types) : this.empty;
        a.reserve(count);
        const out: Entity[] = new Array(count);
        for (let i = 0; i < count; i++) out[i] = this.place(a);
        return out;
    }

    exists(e: Entity): boolean {
        if (e === NULL_ENTITY) return false;
        const index = entityIndex(e);
        return index < this.nextIndex && this.archOf[index] >= 0 && this.versions[index] === entityVersion(e);
    }

    private check(e: Entity): number {
        if (!this.exists(e)) throw new Error(`${entityToString(e)} doesn't exist.`);
        return entityIndex(e);
    }

    destroyEntity(e: Entity | Entity[]): void {
        this.assertStructural('destroyEntity');
        if (Array.isArray(e)) {
            for (const x of e) this.destroyEntity(x);
            return;
        }
        if (!this.exists(e) || this.destroying.has(e)) return;
        if (this.destroyListeners.length) {
            // A listener may destroy the entity again (a linked node's own cleanup): ignore that.
            this.destroying.add(e);
            try {
                for (const fn of this.destroyListeners) {
                    try {
                        fn(e);
                    } catch (err) {
                        console.error('[ECS] onDestroyEntity:', err);
                    }
                }
            } finally {
                this.destroying.delete(e);
            }
            if (!this.exists(e)) return;
        }
        const index = entityIndex(e);
        const a = this.archetypes[this.archOf[index]];
        // Like Unity: destroying the root of a LinkedEntityGroup destroys the whole group.
        const group = a.has(this.linkedType) ? (a.get<LinkedEntityGroup>(this.linkedType).entities[this.rowOf[index]] as Entity[]) : null;
        const moved = a.removeRow(this.rowOf[index]);
        if (moved) this.rowOf[entityIndex(moved)] = this.rowOf[index];
        this.archOf[index] = -1;
        this.versions[index] = nextVersion(this.versions[index]);
        this.free.push(index);
        this.names.delete(index);
        this.alive--;
        this.structureVersion++;
        if (group) for (const x of group) if (x !== e) this.destroyEntity(x);
    }

    /** Destroys every entity (except prefabs unless `includePrefabs`). */
    destroyAll(includePrefabs = false): void {
        const doomed: Entity[] = [];
        for (const a of this.archetypes) {
            if (!includePrefabs && a.has(this.prefabType)) continue;
            for (let i = 0; i < a.count; i++) doomed.push(a.entities[i]);
        }
        this.destroyEntity(doomed);
    }

    private move(e: Entity, index: number, to: Archetype): number {
        const from = this.archetypes[this.archOf[index]];
        if (from === to) return this.rowOf[index];
        const row = this.rowOf[index];
        const newRow = to.add(e);
        from.copyRowTo(row, to, newRow);
        const moved = from.removeRow(row);
        if (moved) this.rowOf[entityIndex(moved)] = row;
        this.archOf[index] = to.id;
        this.rowOf[index] = newRow;
        this.structureVersion++;
        return newRow;
    }

    // ------------------------------------------------------------- components

    hasComponent(e: Entity, type: TypeArg): boolean {
        if (!this.exists(e)) return false;
        return this.archetypes[this.archOf[entityIndex(e)]].has(type);
    }

    getComponentTypes(e: Entity): ComponentType[] {
        return this.archetypes[this.archOf[this.check(e)]].types;
    }

    /** Adds a component (default values, then `values`). Setting values of an existing component just sets them. */
    addComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType, values?: ComponentValues<T>): void {
        const index = this.check(e);
        const t = typeOf(type);
        const a = this.archetypes[this.archOf[index]];
        let row = this.rowOf[index];
        if (!a.has(t)) {
            this.assertStructural('addComponent');
            row = this.move(e, index, this.withType(a, t));
        }
        if (values) this.archetypes[this.archOf[index]].setValues(t, row, values);
    }

    addComponents(e: Entity, ...types: TypeArg[]): void {
        for (const t of types) this.addComponent(e, t);
    }

    removeComponent(e: Entity, type: TypeArg): void {
        const index = this.check(e);
        const t = typeOf(type);
        const a = this.archetypes[this.archOf[index]];
        if (!a.has(t)) return;
        this.assertStructural('removeComponent');
        this.move(e, index, this.withoutType(a, t));
    }

    /** Sets values of a component, adding it when missing. */
    setComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType, values: ComponentValues<T>): void {
        this.addComponent(e, type, values);
    }

    /**
     * A live view of a component: reading and writing its fields reads and
     * writes the entity's data. Valid until the entity changes archetype.
     */
    getComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType): T {
        const index = this.check(e);
        const t = typeOf(type);
        const col = this.archetypes[this.archOf[index]].column(t);
        if (!col) throw new Error(`${entityToString(e)} has no ${t.name}.`);
        const v = Object.create(t.viewProto) as ComponentView;
        v._c = col;
        v._i = this.rowOf[index];
        return v as unknown as T;
    }

    tryGetComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType): T | null {
        return this.hasComponent(e, type) ? this.getComponent(e, type) : null;
    }

    /** A copy of a component's values as a new instance of its class. */
    getComponentData<T>(e: Entity, type: ComponentClass<T> | ComponentType): T {
        const t = typeOf(type);
        const index = this.check(e);
        const col = this.archetypes[this.archOf[index]].column(t);
        if (!col) throw new Error(`${entityToString(e)} has no ${t.name}.`);
        const out: any = new t.ctor();
        Object.assign(out, readValues(col, this.rowOf[index]));
        return out;
    }

    /** Archetype and row of an entity (fast access for tools). */
    location(e: Entity): { archetype: Archetype; row: number } | null {
        if (!this.exists(e)) return null;
        const index = entityIndex(e);
        return { archetype: this.archetypes[this.archOf[index]], row: this.rowOf[index] };
    }

    // ------------------------------------------------------------- enabling

    setEnabled(e: Entity, enabled: boolean): void {
        if (enabled) this.removeComponent(e, Disabled);
        else this.addComponent(e, Disabled);
    }

    isEnabled(e: Entity): boolean {
        return this.exists(e) && !this.hasComponent(e, Disabled);
    }

    // ----------------------------------------------------------------- names

    setName(e: Entity, name: string): void {
        this.names.set(this.check(e), name);
    }

    getName(e: Entity): string {
        if (!this.exists(e)) return '';
        return this.names.get(entityIndex(e)) ?? '';
    }

    // ------------------------------------------------------------ singletons

    getSingletonEntity(type: TypeArg): Entity {
        return this.queryFor(type).getSingletonEntity();
    }

    getSingleton<T>(type: ComponentClass<T> | ComponentType): T {
        return this.getComponent(this.getSingletonEntity(type), type);
    }

    hasSingleton(type: TypeArg): boolean {
        return this.queryFor(type).count() === 1;
    }

    /** Sets the singleton's values, creating its entity when there is none. */
    setSingleton<T>(type: ComponentClass<T> | ComponentType, values: ComponentValues<T>): Entity {
        const q = this.queryFor(type);
        const e = q.isEmpty() ? this.createEntity(type) : q.getSingletonEntity();
        this.setComponent(e, type, values);
        return e;
    }

    private singletonQueries = new Map<number, EntityQuery>();
    private queryFor(type: TypeArg): EntityQuery {
        const t = typeOf(type);
        let q = this.singletonQueries.get(t.id);
        if (!q) {
            q = this.createQuery({ all: [t] });
            this.singletonQueries.set(t.id, q);
        }
        return q;
    }

    // ----------------------------------------------------------- instantiate

    /**
     * Copies an entity with all its components (Unity's Instantiate). A
     * prefab loses its Prefab tag; with a LinkedEntityGroup the whole group is
     * copied and entity fields pointing inside it are remapped.
     */
    instantiate(src: Entity): Entity;
    instantiate(src: Entity, count: number): Entity[];
    instantiate(src: Entity, count?: number): Entity | Entity[] {
        this.assertStructural('instantiate');
        this.check(src);
        const n = count ?? 1;
        const out: Entity[] = new Array(n);
        const group = this.hasComponent(src, LinkedEntityGroup)
            ? (this.getComponent(src, LinkedEntityGroup).entities as Entity[]).filter((x) => this.exists(x))
            : null;
        for (let k = 0; k < n; k++) out[k] = group && group.length ? this.instantiateGroup(src, group) : this.copyOne(src);
        return count === undefined ? out[0] : out;
    }

    private copyOne(src: Entity): Entity {
        const index = entityIndex(src);
        const from = this.archetypes[this.archOf[index]];
        const to = from.has(this.prefabType) ? this.withoutType(from, this.prefabType) : from;
        const e = this.place(to);
        from.copyRowTo(this.rowOf[index], to, this.rowOf[entityIndex(e)]);
        const name = this.names.get(index);
        if (name) this.names.set(entityIndex(e), name);
        this.structureVersion++;
        return e;
    }

    private instantiateGroup(root: Entity, group: Entity[]): Entity {
        const map = new Map<Entity, Entity>();
        if (!group.includes(root)) group = [root, ...group];
        for (const g of group) map.set(g, this.copyOne(g));
        // Point entity fields inside the group at the copies.
        for (const copy of map.values()) {
            const loc = this.location(copy)!;
            for (const col of loc.archetype.columns) {
                for (const f of col.type.fields) {
                    const s = col.stores[f.name] as any;
                    if (f.kind === 'entity') {
                        const m = map.get(s[loc.row]);
                        if (m !== undefined) s[loc.row] = m;
                    } else if (col.type === this.linkedType && f.name === 'entities') {
                        s[loc.row] = (s[loc.row] as Entity[]).map((x) => map.get(x) ?? x);
                    }
                }
            }
        }
        return map.get(root)!;
    }

    // ------------------------------------------------------------------ debug

    /** Plain description of an entity: name and component values. */
    describe(e: Entity): { entity: Entity; name: string; components: Record<string, Record<string, any>> } | null {
        const loc = this.location(e);
        if (!loc) return null;
        const components: Record<string, Record<string, any>> = {};
        for (const t of loc.archetype.types) {
            const col = loc.archetype.column(t)!;
            components[t.name] = readValues(col, loc.row);
        }
        return { entity: e, name: this.getName(e), components };
    }
}

export { EntityName };
