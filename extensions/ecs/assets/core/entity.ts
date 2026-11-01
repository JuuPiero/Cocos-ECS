/**
 * An entity is a number: 20 bits of index and 11 bits of version, so it fits
 * an Int32Array and a recycled index never matches an old handle (until the
 * version wraps after 2048 reuses). 0 is the null entity.
 */
export type Entity = number;

export const INDEX_BITS = 20;
export const MAX_ENTITIES = 1 << INDEX_BITS;
const INDEX_MASK = MAX_ENTITIES - 1;
const VERSION_MOD = 1 << 11;

export const NULL_ENTITY: Entity = 0;

export function entityIndex(e: Entity): number {
    return e & INDEX_MASK;
}

export function entityVersion(e: Entity): number {
    return e >>> INDEX_BITS;
}

export function makeEntity(index: number, version: number): Entity {
    return ((version % VERSION_MOD) << INDEX_BITS) | index;
}

export function nextVersion(version: number): number {
    // Never 0 for index 0... index 0 is never handed out, so any version works.
    return (version + 1) % VERSION_MOD;
}

/** "Entity(12:3)": index and version, like Unity's debug text. */
export function entityToString(e: Entity): string {
    return e === NULL_ENTITY ? 'Entity.Null' : `Entity(${entityIndex(e)}:${entityVersion(e)})`;
}
