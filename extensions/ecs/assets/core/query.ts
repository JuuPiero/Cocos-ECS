/**
 * Entity queries (Unity's EntityQuery): the archetypes that have all of
 * `all`, at least one of `any` and none of `none`.
 *
 *     const q = em.createQuery({ all: [Position, Velocity], none: [Frozen] });
 *     q.forEach((e, pos, vel) => { pos.x += vel.x * dt; });     // convenient
 *     for (const a of q.archetypes) { ... a.get(Position).x ... } // fastest
 */
import type { Archetype } from './archetype';
import { BitSet } from './bitset';
import { ComponentClass, ComponentType, ComponentView, typeOf } from './component';
import type { Entity } from './entity';

export interface QueryDesc {
    all?: (ComponentClass | ComponentType)[];
    any?: (ComponentClass | ComponentType)[];
    none?: (ComponentClass | ComponentType)[];
    /** Include entities with the Disabled tag. */
    includeDisabled?: boolean;
    /** Include prefab entities. */
    includePrefab?: boolean;
}

/** View type of a component class (live accessor of its fields). */
export type View<T> = T extends new () => infer I ? I : never;
type Views<T extends any[]> = { [K in keyof T]: View<T[K]> };

export interface QueryHost {
    readonly archetypes: Archetype[];
    beginIteration(): void;
    endIteration(): void;
    disabledType: ComponentType;
    prefabType: ComponentType;
}

export class EntityQuery<T extends any[] = any[]> {
    readonly all: ComponentType[];
    readonly any: ComponentType[];
    readonly none: ComponentType[];
    readonly key: string;
    private readonly allMask: BitSet;
    private readonly anyMask: BitSet;
    private readonly noneMask: BitSet;
    /** Every archetype that matches (empty ones included). */
    readonly matching: Archetype[] = [];
    /** Change filter: only archetypes where one of these columns changed after `changedSince`. */
    private changeFilter: ComponentType[] = [];
    changedSince = 0;
    private views: ComponentView[] = [];

    constructor(private readonly host: QueryHost, desc: QueryDesc) {
        this.all = (desc.all || []).map(typeOf);
        this.any = (desc.any || []).map(typeOf);
        this.none = (desc.none || []).map(typeOf);
        const none = [...this.none];
        const mentions = (t: ComponentType) => this.all.includes(t) || this.any.includes(t);
        if (!desc.includeDisabled && !mentions(host.disabledType)) none.push(host.disabledType);
        if (!desc.includePrefab && !mentions(host.prefabType)) none.push(host.prefabType);
        this.allMask = BitSet.of(this.all.map((t) => t.id));
        this.anyMask = BitSet.of(this.any.map((t) => t.id));
        this.noneMask = BitSet.of(none.map((t) => t.id));
        this.key = queryKey(desc);
        for (const a of host.archetypes) this.consider(a);
    }

    /** Called by the EntityManager for every new archetype. */
    consider(a: Archetype): void {
        if (a.mask.hasAll(this.allMask) && a.mask.hasAny(this.anyMask) && a.mask.hasNone(this.noneMask)) this.matching.push(a);
    }

    /** Only archetypes whose column of one of `types` was written since `changedSince` (set by the owning system). */
    setChangeFilter(...types: (ComponentClass | ComponentType)[]): this {
        this.changeFilter = types.map(typeOf);
        return this;
    }

    /** Matching archetypes that have entities (and pass the change filter). */
    get archetypes(): Archetype[] {
        const res: Archetype[] = [];
        for (const a of this.matching) {
            if (a.count === 0) continue;
            if (this.changeFilter.length && !this.changeFilter.some((t) => (a.column(t)?.version ?? 0) > this.changedSince)) continue;
            res.push(a);
        }
        return res;
    }

    /** Number of entities (ignores the change filter). */
    count(): number {
        let n = 0;
        for (const a of this.matching) n += a.count;
        return n;
    }

    isEmpty(): boolean {
        for (const a of this.matching) if (a.count > 0) return false;
        return true;
    }

    /**
     * Calls `fn(entity, ...views)` for each entity; the views (one per `all`
     * type, in order) read and write the component directly. Don't keep them:
     * they move to the next entity. Structural changes (add / remove /
     * destroy) aren't allowed meanwhile: record them in a command buffer.
     */
    forEach(fn: (entity: Entity, ...views: Views<T>) => void): void {
        const types = this.all;
        const n = types.length;
        const views = this.views;
        for (let k = 0; k < n; k++) views[k] = views[k] || (Object.create(types[k].viewProto) as ComponentView);
        const args: any[] = new Array(n + 1);
        this.host.beginIteration();
        try {
            for (const a of this.archetypes) {
                for (let k = 0; k < n; k++) {
                    const v = views[k];
                    v._c = a.column(types[k])!;
                    args[k + 1] = types[k].isTag ? undefined : v;
                }
                const ents = a.entities;
                const count = a.count;
                for (let i = 0; i < count; i++) {
                    for (let k = 0; k < n; k++) views[k]._i = i;
                    args[0] = ents[i];
                    (fn as any).apply(null, args);
                }
            }
        } finally {
            this.host.endIteration();
        }
    }

    toEntityArray(): Entity[] {
        const out: Entity[] = [];
        for (const a of this.archetypes) for (let i = 0; i < a.count; i++) out.push(a.entities[i]);
        return out;
    }

    /** The only entity of the query (throws if there are none or several). */
    getSingletonEntity(): Entity {
        let found = 0;
        let n = 0;
        for (const a of this.matching) {
            n += a.count;
            if (a.count) found = a.entities[0];
        }
        if (n !== 1) throw new Error(`Expected one entity for the query, found ${n}.`);
        return found;
    }
}

export function queryKey(desc: QueryDesc): string {
    const ids = (l?: (ComponentClass | ComponentType)[]) => (l || []).map((t) => typeOf(t).id).sort((a, b) => a - b).join(',');
    return `${ids(desc.all)}|${ids(desc.any)}|${ids(desc.none)}|${desc.includeDisabled ? 1 : 0}${desc.includePrefab ? 1 : 0}`;
}
