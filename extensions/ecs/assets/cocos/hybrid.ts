/**
 * Entities linked to Cocos nodes (Unity's companion GameObjects): use nodes
 * where you need what the engine's components do (Spine, particles, UI,
 * physics...) and entities for the rest.
 *
 *     const e = linkNode(world, node, { copy: 'to-node' });   // ECS moves the node
 */
import { _decorator, Component, Mat4, Node, Quat, Vec3 } from 'cc';
import { bool, component, ref } from '../core/component';
import type { Entity } from '../core/entity';
import { LocalToWorld, LocalTransform, Parent, PostTransformScale } from '../core/transforms';
import { InitializationSystemGroup, PresentationSystemGroup, SystemBase, system } from '../core/system';
import type { World } from '../core/world';
import { LateTransformSystem } from '../core/transforms';

const { ccclass, property, disallowMultiple } = _decorator;

/** The node of an entity. */
@component('NodeLink')
export class NodeLink {
    @ref node: Node | null = null;
    /** Destroy the node when the entity is destroyed. */
    @bool destroyNodeWithEntity = true;
}

/** Each frame, the entity's world transform is copied to its node (Presentation). */
@component('CopyTransformToNode')
export class CopyTransformToNode {}

/** Each frame, the node's world transform is copied to the entity (Initialization). */
@component('CopyTransformFromNode')
export class CopyTransformFromNode {}

/** Put on a node by linkNode / baking: its entity, for the node's own scripts. */
@ccclass('EntityLink')
@disallowMultiple
export class EntityLink extends Component {
    /** The entity of this node (0 when none). */
    entity: Entity = 0;
    /** The world the entity lives in. */
    world: World | null = null;

    @property({ tooltip: 'Destroy the entity when this node is destroyed.' })
    destroyEntityWithNode = true;

    /** True while the entity exists. */
    get hasEntity(): boolean {
        return !!this.world && !this.world.disposed && this.world.entityManager.exists(this.entity);
    }

    onDestroy() {
        if (this.destroyEntityWithNode && this.hasEntity) this.world!.entityManager.destroyEntity(this.entity);
    }
}

export interface LinkOptions {
    /** Which way the transform is copied each frame. */
    copy?: 'to-node' | 'from-node' | 'none';
    /** Use this entity instead of making one. */
    entity?: Entity;
    destroyNodeWithEntity?: boolean;
    destroyEntityWithNode?: boolean;
}

const _p = new Vec3();
const _s = new Vec3();
const _q = new Quat();
const _m = new Mat4();

/** Links a node and an entity (made with LocalTransform / LocalToWorld when not given). */
export function linkNode(world: World, node: Node, options: LinkOptions = {}): Entity {
    const em = world.entityManager;
    const given = !!options.entity && em.exists(options.entity);
    const e = given ? options.entity! : em.createEntity(LocalTransform, LocalToWorld);
    em.addComponent(e, NodeLink, { node, destroyNodeWithEntity: options.destroyNodeWithEntity ?? true });
    if (!em.getName(e)) em.setName(e, node.name);
    const copy = options.copy ?? 'to-node';
    if (copy === 'to-node') em.addComponent(e, CopyTransformToNode);
    if (copy === 'from-node') em.addComponent(e, CopyTransformFromNode);
    // A new entity starts where the node is.
    if (em.hasComponent(e, LocalTransform) && (!given || copy === 'from-node')) readNode(node, em.getComponent(e, LocalTransform));
    const link = node.getComponent(EntityLink) || node.addComponent(EntityLink);
    link.entity = e;
    link.world = world;
    link.destroyEntityWithNode = options.destroyEntityWithNode ?? true;
    return e;
}

/** The entity linked to a node, or 0. */
export function entityOf(node: Node): Entity {
    const link = node.getComponent(EntityLink);
    return link && link.hasEntity ? link.entity : 0;
}

function readNode(node: Node, t: LocalTransform): void {
    const p = node.worldPosition;
    const q = node.worldRotation;
    t.x = p.x;
    t.y = p.y;
    t.z = p.z;
    t.qx = q.x;
    t.qy = q.y;
    t.qz = q.z;
    t.qw = q.w;
    t.scale = node.worldScale.x;
}

/** Node → entity transforms (Initialization). */
@system({ group: InitializationSystemGroup, name: 'CopyTransformFromNodeSystem' })
export class CopyTransformFromNodeSystem extends SystemBase {
    private q = this.getQuery({ all: [NodeLink, LocalTransform, CopyTransformFromNode] });

    protected onUpdate(): void {
        for (const a of this.q.archetypes) {
            const links = a.get(NodeLink).node as (Node | null)[];
            const t = a.write(LocalTransform);
            const post = a.has(PostTransformScale) ? a.write(PostTransformScale) : null;
            for (let i = 0; i < a.count; i++) {
                const node = links[i];
                if (!node || !node.isValid) continue;
                const p = node.worldPosition;
                const q = node.worldRotation;
                const s = node.worldScale;
                t.x[i] = p.x;
                t.y[i] = p.y;
                t.z[i] = p.z;
                t.qx[i] = q.x;
                t.qy[i] = q.y;
                t.qz[i] = q.z;
                t.qw[i] = q.w;
                if (post) {
                    t.scale[i] = 1;
                    post.x[i] = s.x;
                    post.y[i] = s.y;
                    post.z[i] = s.z;
                } else {
                    t.scale[i] = s.x;
                }
            }
        }
    }
}

const M = ['m00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15'] as const;

/** Entity → node transforms (Presentation, after the late transform update). */
@system({ group: PresentationSystemGroup, updateAfter: [LateTransformSystem], name: 'CopyTransformToNodeSystem' })
export class CopyTransformToNodeSystem extends SystemBase {
    private q = this.getQuery({ all: [NodeLink, CopyTransformToNode], any: [LocalToWorld, LocalTransform] });

    protected onUpdate(): void {
        for (const a of this.q.archetypes) {
            const links = a.get(NodeLink).node as (Node | null)[];
            const fast = a.has(LocalTransform) && !a.has(Parent) && !a.has(PostTransformScale);
            if (fast) {
                // No parent, uniform scale: the local transform is the world transform.
                const t = a.get(LocalTransform);
                for (let i = 0; i < a.count; i++) {
                    const node = links[i];
                    if (!node || !node.isValid) continue;
                    node.setWorldPosition(t.x[i], t.y[i], t.z[i]);
                    node.setWorldRotation(t.qx[i], t.qy[i], t.qz[i], t.qw[i]);
                    node.setWorldScale(t.scale[i], t.scale[i], t.scale[i]);
                }
                continue;
            }
            if (!a.has(LocalToWorld)) continue;
            const m = a.get(LocalToWorld);
            for (let i = 0; i < a.count; i++) {
                const node = links[i];
                if (!node || !node.isValid) continue;
                for (let k = 0; k < 16; k++) (_m as any)[M[k]] = m[M[k]][i];
                Mat4.toRTS(_m, _q, _p, _s);
                node.setWorldPosition(_p);
                node.setWorldRotation(_q);
                node.setWorldScale(_s);
            }
        }
    }
}

/** Destroys linked nodes with their entities. */
@system({ group: PresentationSystemGroup, name: 'NodeLinkCleanupSystem' })
export class NodeLinkCleanupSystem extends SystemBase {
    private off: (() => void) | null = null;

    protected onCreate(): void {
        const em = this.entityManager;
        this.off = em.onDestroyEntity((e) => {
            if (!em.hasComponent(e, NodeLink)) return;
            const link = em.getComponent(e, NodeLink);
            const node = link.node;
            if (node && node.isValid && link.destroyNodeWithEntity) {
                const el = node.getComponent(EntityLink);
                if (el) el.destroyEntityWithNode = false;
                node.destroy();
            }
        });
        this.enabled = false; // nothing to do per frame
    }

    protected onUpdate(): void {}

    protected onDestroy(): void {
        this.off?.();
    }
}
