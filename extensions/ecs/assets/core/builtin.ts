/** Components every world knows (Unity's built-in tags). */
import { component, ref } from './component';
import type { Entity } from './entity';

/** Entities with this tag are skipped by queries unless they ask for it (Unity's Disabled). */
@component('Disabled')
export class Disabled {}

/** Prefab entities: templates for instantiate(), skipped by queries (Unity's Prefab). */
@component('Prefab')
export class Prefab {}

/**
 * Entities instantiated together with the first one (a prefab and its
 * children), like Unity's LinkedEntityGroup. Entity fields that point inside
 * the group are remapped to the new copies.
 */
@component('LinkedEntityGroup')
export class LinkedEntityGroup {
    @ref entities: Entity[] = [];
}

/** A debug name (also kept by the EntityManager's name table). */
@component('EntityName')
export class EntityName {
    @ref value = '';
}
