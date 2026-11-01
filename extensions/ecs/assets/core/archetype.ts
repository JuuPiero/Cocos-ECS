/**
 * An archetype stores every entity that has exactly the same component types,
 * one column per component and one array per field (structure of arrays).
 * Systems iterate the columns directly for speed:
 *
 *     for (const a of query.archetypes) {
 *         const p = a.write(Position), v = a.get(Velocity);
 *         for (let i = 0; i < a.count; i++) p.x[i] += v.x[i] * dt;
 *     }
 */
import { BitSet } from './bitset';
import { ARRAY_OF, Column, ComponentClass, ComponentType, Store, clock, typeOf } from './component';
import type { Entity } from './entity';

const INITIAL_CAPACITY = 16;

export class Archetype {
    readonly id: number;
    /** Component types, sorted by id. */
    readonly types: ComponentType[];
    readonly mask: BitSet;
    readonly key: string;
    /** Entities in row order (only the first `count` are valid). */
    entities: Int32Array;
    count = 0;
    capacity = 0;
    /** Column per component type id (undefined for types this archetype doesn't have). */
    private readonly cols: (Column | undefined)[] = [];
    readonly columns: Column[] = [];
    /** Archetype reached by adding / removing a type (cache). */
    readonly addEdges = new Map<number, Archetype>();
    readonly removeEdges = new Map<number, Archetype>();
    /** Bumped on every add / remove of an entity (debug views, queries). */
    structureVersion = 0;

    constructor(id: number, types: ComponentType[]) {
        this.id = id;
        this.types = [...types].sort((a, b) => a.id - b.id);
        this.mask = BitSet.of(this.types.map((t) => t.id));
        this.key = archetypeKey(this.types);
        this.entities = new Int32Array(0);
        for (const t of this.types) {
            const col: Column = { type: t, stores: {}, version: clock.version };
            this.cols[t.id] = col;
            this.columns.push(col);
        }
        this.grow(INITIAL_CAPACITY);
    }

    has(type: ComponentClass | ComponentType): boolean {
        return this.cols[typeOf(type).id] !== undefined;
    }

    /** The column of a component (read access: no change version). */
    column(type: ComponentClass | ComponentType): Column | undefined {
        return this.cols[typeOf(type).id];
    }

    /** Field arrays of a component, for reading. */
    get<T>(type: ComponentClass<T> | ComponentType): Record<keyof T & string, any> {
        const c = this.cols[typeOf(type).id];
        if (!c) throw new Error(`Archetype ${this.key} has no ${typeOf(type).name}`);
        return c.stores as any;
    }

    /** Field arrays of a component, for writing (marks the column changed). */
    write<T>(type: ComponentClass<T> | ComponentType): Record<keyof T & string, any> {
        const c = this.cols[typeOf(type).id];
        if (!c) throw new Error(`Archetype ${this.key} has no ${typeOf(type).name}`);
        c.version = clock.version;
        return c.stores as any;
    }

    private grow(min: number): void {
        let cap = Math.max(INITIAL_CAPACITY, this.capacity);
        while (cap < min) cap *= 2;
        if (cap === this.capacity) return;
        const ents = new Int32Array(cap);
        ents.set(this.entities.subarray(0, this.count));
        this.entities = ents;
        for (const col of this.columns) {
            for (const f of col.type.fields) {
                const old = col.stores[f.name];
                if (f.kind === 'ref') {
                    if (!old) col.stores[f.name] = [];
                    continue;
                }
                const next = new ARRAY_OF[f.kind](cap);
                if (old) (next as any).set((old as any).subarray(0, this.count));
                col.stores[f.name] = next;
            }
        }
        this.capacity = cap;
    }

    /** Appends an entity with default values; returns its row. */
    add(entity: Entity): number {
        if (this.count >= this.capacity) this.grow(this.count + 1);
        const row = this.count++;
        this.entities[row] = entity;
        for (const col of this.columns) {
            for (const f of col.type.fields) (col.stores[f.name] as any)[row] = col.type.defaultOf(f);
        }
        this.structureVersion++;
        return row;
    }

    /** Makes room for `n` more entities at once (bulk creation). */
    reserve(n: number): void {
        if (this.count + n > this.capacity) this.grow(this.count + n);
    }

    /**
     * Removes a row by moving the last row into it. Returns the entity that
     * moved into `row` (0 when the removed row was the last one).
     */
    removeRow(row: number): Entity {
        const last = this.count - 1;
        let moved = 0;
        for (const col of this.columns) {
            for (const f of col.type.fields) {
                const s = col.stores[f.name] as any;
                if (row !== last) s[row] = s[last];
                if (f.kind === 'ref') s[last] = undefined;
            }
        }
        if (row !== last) {
            moved = this.entities[last];
            this.entities[row] = moved;
        }
        this.count = last;
        this.structureVersion++;
        return moved;
    }

    /** Copies the components both archetypes have from a row here to a row of `dst`. */
    copyRowTo(row: number, dst: Archetype, dstRow: number): void {
        for (const col of this.columns) {
            const d = dst.cols[col.type.id];
            if (!d) continue;
            for (const f of col.type.fields) (d.stores[f.name] as any)[dstRow] = (col.stores[f.name] as any)[row];
            if (col.version > d.version) d.version = col.version;
        }
    }

    /** Writes values (partial) of one component at a row. */
    setValues(type: ComponentType, row: number, values: any): void {
        const c = this.cols[type.id];
        if (!c || !values) return;
        for (const f of type.fields) {
            if (!(f.name in values)) continue;
            const v = values[f.name];
            (c.stores[f.name] as any)[row] = f.kind === 'bool' ? (v ? 1 : 0) : v;
        }
        c.version = clock.version;
    }

    /** Store of one field (for tools; systems use get / write). */
    store(type: ComponentType, field: string): Store | undefined {
        return this.cols[type.id]?.stores[field];
    }

    /** Approximate bytes used by the typed columns (debug). */
    bytes(): number {
        let n = this.entities.byteLength;
        for (const col of this.columns) {
            for (const f of col.type.fields) {
                const s = col.stores[f.name] as any;
                n += s.byteLength ?? s.length * 8;
            }
        }
        return n;
    }
}

export function archetypeKey(types: ComponentType[]): string {
    return types.map((t) => t.id).sort((a, b) => a - b).join(',');
}
