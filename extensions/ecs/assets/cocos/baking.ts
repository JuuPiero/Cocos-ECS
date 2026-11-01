/**
 * Baking (Unity's authoring workflow): edit a scene with nodes and
 * components as usual; when the game runs, a SubScene turns its child nodes
 * into entities. Bakers convert components to ECS data:
 *
 *     @ccclass('MoverAuthoring')
 *     export class MoverAuthoring extends Component {
 *         @property speed = 100;
 *     }
 *
 *     @baker(MoverAuthoring)
 *     export class MoverBaker extends Baker<MoverAuthoring> {
 *         bake(a: MoverAuthoring) {
 *             this.addComponent(Velocity, { x: a.speed });
 *         }
 *     }
 *
 * Built in: transforms (LocalTransform / Parent), cc.Sprite → RenderSprite,
 * cc.MeshRenderer → RenderMesh. Prefabs become entity prefabs
 * (bakePrefab / Baker.getEntity(prefab)) to instantiate many times.
 */
import {
    _decorator, assetManager, Color, Component, instantiate, Material, MeshRenderer, Node, Prefab as CCPrefab, Sprite, UIMeshRenderer, UITransform,
} from 'cc';
import { EcsUIRenderer } from './ui-renderer';
import { ComponentClass, ComponentType, ComponentValues } from '../core/component';
import { Disabled, LinkedEntityGroup, Prefab } from '../core/builtin';
import type { Entity } from '../core/entity';
import { LocalToWorld, LocalTransform, Parent, PostTransformScale } from '../core/transforms';
import type { World } from '../core/world';
import { defaultWorld, isPlaying } from './bootstrap';
import { linkNode } from './hybrid';
import { RenderMesh } from './meshes';
import { EntitySpriteRenderer, RenderSprite, SPRITE_UI_MATERIAL, SPRITE_WORLD_MATERIAL, packColor } from './sprites';

function inCanvas(node: Node | null): boolean {
    for (let n = node; n; n = n.parent) if (n.getComponent(UITransform)) return true;
    return false;
}

const { ccclass, property, menu, disallowMultiple } = _decorator;

type Ctor<T> = abstract new (...args: any[]) => T;

// ------------------------------------------------------------------- bakers

/** Context of one baking pass. */
interface BakeContext {
    world: World;
    nodeToEntity: Map<Node, Entity>;
    /** Bakers that only make sense when the nodes go away (rendering). */
    keepNodes: boolean;
    /** Entities created by bakers besides the nodes' own. */
    extra: Entity[];
    /** Entity prefabs the bakers asked for (getEntity(prefab)). */
    prefabs: Entity[];
}

/**
 * Converts one authoring component into ECS data on its node's entity
 * (Unity's Baker<T>). Register with @baker(ComponentClass).
 */
export abstract class Baker<T extends Component = Component> {
    /** The entity of the node being baked. */
    entity: Entity = 0;
    /** @internal */ _ctx!: BakeContext;
    /** @internal */ _node!: Node;

    abstract bake(authoring: T): void;

    protected get world(): World {
        return this._ctx.world;
    }

    /** Adds (or sets) a component on the node's entity, or on `target`. */
    addComponent<C>(type: ComponentClass<C> | ComponentType, values?: ComponentValues<C>, target: Entity = this.entity): void {
        this._ctx.world.entityManager.addComponent(target, type, values);
    }

    setComponent<C>(type: ComponentClass<C> | ComponentType, values: ComponentValues<C>, target: Entity = this.entity): void {
        this._ctx.world.entityManager.setComponent(target, type, values);
    }

    /** Another entity made by this baker (Unity's CreateAdditionalEntity). */
    createAdditionalEntity(name = ''): Entity {
        const em = this._ctx.world.entityManager;
        const e = em.createEntity();
        if (name) em.setName(e, name);
        this._ctx.extra.push(e);
        return e;
    }

    /** The entity of another baked node, or an entity prefab baked from a Prefab asset. */
    getEntity(target: Node | CCPrefab | null): Entity {
        if (!target) return 0;
        if (target instanceof CCPrefab) {
            const p = bakePrefab(this._ctx.world, target);
            if (!this._ctx.prefabs.includes(p)) this._ctx.prefabs.push(p);
            return p;
        }
        return this._ctx.nodeToEntity.get(target) ?? 0;
    }

    /** The node being baked. */
    protected get node(): Node {
        return this._node;
    }

    /** True when the nodes stay (hybrid SubScene): renderers keep drawing them. */
    protected get keepingNodes(): boolean {
        return this._ctx.keepNodes;
    }
}

const bakers = new Map<Ctor<Component>, (new () => Baker<any>)[]>();

/** Registers a Baker for an authoring component class (subclasses included). */
export function baker<T extends Component>(authoring: Ctor<T>) {
    return function <B extends new () => Baker<T>>(cls: B): B {
        const list = bakers.get(authoring) || [];
        // Scripts reloaded in the editor: replace the baker of the same name.
        const i = list.findIndex((b) => b.name === cls.name);
        if (i >= 0) list.splice(i, 1);
        list.push(cls);
        bakers.set(authoring, list);
        return cls;
    };
}

function bakersFor(comp: Component): (new () => Baker<any>)[] {
    const out: (new () => Baker<any>)[] = [];
    for (let c: any = comp.constructor; c && c !== Component && c !== Object; c = Object.getPrototypeOf(c)) {
        const list = bakers.get(c);
        if (list) out.push(...list);
    }
    return out;
}

// ---------------------------------------------------------- built-in bakers

@baker(Sprite)
export class SpriteBaker extends Baker<Sprite> {
    bake(s: Sprite): void {
        if (this.keepingNodes || !s.spriteFrame) return;
        const ui = this.node.getComponent(UITransform);
        this.addComponent(RenderSprite, {
            frame: s.spriteFrame,
            color: packColor(s.color),
            width: ui ? ui.width : 0,
            height: ui ? ui.height : 0,
            anchorX: ui ? ui.anchorX : 0.5,
            anchorY: ui ? ui.anchorY : 0.5,
        });
    }
}

const _col = new Color();

@baker(MeshRenderer)
export class MeshRendererBaker extends Baker<MeshRenderer> {
    bake(r: MeshRenderer): void {
        if (this.keepingNodes || !r.mesh) return;
        const mat = r.getSharedMaterial(0);
        // Instancing needs the ecs-mesh effect: other materials give their color to the default one.
        const usable = mat && (mat.effectName === 'ecs-mesh' || (mat.effectAsset as any)?._uuid === ECS_MESH_EFFECT);
        let color = 0xffffffff;
        if (mat && !usable) {
            const c = mat.getProperty('mainColor') as Color | null;
            if (c) color = packColor(_col.set(c));
        }
        this.addComponent(RenderMesh, { mesh: r.mesh, material: usable ? mat : null, color });
    }
}

const ECS_MESH_EFFECT = 'b40852bd-2e73-472c-a654-250bc610af88';

// ------------------------------------------------------------------- baking

export interface BakeOptions {
    /** Put the top nodes in world space (no Parent). Default true. */
    worldRoots?: boolean;
    /** Mark everything as a prefab (with a LinkedEntityGroup on the first root). */
    prefab?: boolean;
    /** Keep the nodes and link them to their entities (no render bakers). */
    keepNodes?: boolean;
}

export interface BakeResult {
    entities: Entity[];
    nodeToEntity: Map<Node, Entity>;
    /** Entity prefabs baked for the bakers (Baker.getEntity(prefab)). */
    prefabs: Entity[];
}

function readTransform(node: Node, world: boolean, values: any): void {
    const p = world ? node.worldPosition : node.position;
    const q = world ? node.worldRotation : node.rotation;
    const s = world ? node.worldScale : node.scale;
    values.x = p.x;
    values.y = p.y;
    values.z = p.z;
    values.qx = q.x;
    values.qy = q.y;
    values.qz = q.z;
    values.qw = q.w;
    const uniform = Math.abs(s.x - s.y) < 1e-6 && Math.abs(s.y - s.z) < 1e-6;
    values.scale = uniform ? s.x : 1;
    values.post = uniform ? null : { x: s.x, y: s.y, z: s.z };
}

/** Bakes node trees into entities of `world`. */
export function bakeNodes(world: World, roots: Node[], options: BakeOptions = {}): BakeResult {
    const em = world.entityManager;
    const nodeToEntity = new Map<Node, Entity>();
    const order: Node[] = [];
    const ctx: BakeContext = { world, nodeToEntity, keepNodes: !!options.keepNodes, extra: [], prefabs: [] };
    const worldRoots = options.worldRoots !== false;
    const walk = (node: Node, parent: Entity) => {
        const e = em.createEntity(LocalTransform, LocalToWorld);
        em.setName(e, node.name);
        nodeToEntity.set(node, e);
        order.push(node);
        const t: any = {};
        readTransform(node, !parent && worldRoots, t);
        em.setComponent(e, LocalTransform, t);
        if (t.post) em.addComponent(e, PostTransformScale, t.post);
        if (parent) em.addComponent(e, Parent, { value: parent });
        if (!node.active) em.addComponent(e, Disabled);
        for (const child of node.children) walk(child, e);
    };
    for (const r of roots) walk(r, 0);
    // Components → data.
    for (const node of order) {
        const e = nodeToEntity.get(node)!;
        for (const comp of node.components) {
            for (const B of bakersFor(comp)) {
                const b = new B();
                b.entity = e;
                b._ctx = ctx;
                b._node = node;
                try {
                    b.bake(comp);
                } catch (err) {
                    console.error(`[ECS] ${B.name} on ${node.name}:`, err);
                }
            }
        }
    }
    const entities = [...Array.from(nodeToEntity.values()), ...ctx.extra];
    if (options.prefab) {
        for (const e of entities) em.addComponent(e, Prefab);
        if (roots.length) {
            const root = nodeToEntity.get(roots[0])!;
            em.addComponent(root, LinkedEntityGroup, { entities: [root, ...entities.filter((x) => x !== root)] });
        }
    }
    if (options.keepNodes) {
        for (const [node, e] of nodeToEntity) linkNode(world, node, { entity: e, copy: 'to-node', destroyNodeWithEntity: true });
    }
    return { entities, nodeToEntity, prefabs: ctx.prefabs };
}

const prefabCache = new WeakMap<World, Map<CCPrefab, Entity>>();

/**
 * The entity prefab of a Prefab asset (baked once per world): instantiate it
 * with world.entityManager.instantiate(prefabEntity, count).
 */
export function bakePrefab(world: World, prefab: CCPrefab): Entity {
    let cache = prefabCache.get(world);
    if (!cache) prefabCache.set(world, (cache = new Map()));
    const hit = cache.get(prefab);
    if (hit && world.entityManager.exists(hit)) return hit;
    const node = instantiate(prefab);
    const { nodeToEntity } = bakeNodes(world, [node], { prefab: true, worldRoots: false });
    const root = nodeToEntity.get(node)!;
    node.destroy();
    cache.set(prefab, root);
    return root;
}

// ----------------------------------------------------------------- SubScene

/**
 * Turns its child nodes into entities when the game runs (Unity's SubScene):
 * the nodes are removed and the entities drawn by ECS renderers (an
 * EntitySpriteRenderer is added here when sprites were baked and none
 * draws their layer). With Keep Nodes the nodes stay, moved by their
 * entities (hybrid).
 */
@ccclass('SubScene')
@disallowMultiple
@menu('ECS/SubScene')
export class SubScene extends Component {
    @property({ tooltip: 'Keep the nodes and link them to their entities (they keep rendering themselves).' })
    keepNodes = false;

    @property({ tooltip: 'Destroy the baked entities when this node is destroyed (e.g. the scene unloads).' })
    destroyEntitiesWithNode = true;

    @property({ type: Material, tooltip: 'Material of the EntitySpriteRenderer added for baked sprites (keeps it in builds).' })
    spriteMaterial: Material | null = null;

    /** The baked entities (after onLoad). */
    entities: Entity[] = [];
    private world: World | null = null;

    resetInEditor() {
        const ui = !!this.node.getComponent(UITransform) || !!this.node.parent?.getComponent(UITransform);
        assetManager.loadAny({ uuid: ui ? SPRITE_UI_MATERIAL : SPRITE_WORLD_MATERIAL }, (err: Error | null, mat: Material) => {
            if (!err && mat && this.isValid && !this.spriteMaterial) this.spriteMaterial = mat;
        });
    }

    onLoad() {
        if (!isPlaying()) return;
        const world = defaultWorld();
        if (!world) return;
        this.world = world;
        const children = [...this.node.children];
        // The children aren't activated yet (this onLoad runs first): bake, then keep them from starting.
        const { entities, prefabs } = bakeNodes(world, children, { keepNodes: this.keepNodes });
        this.entities = entities;
        if (this.keepNodes) return;
        for (const c of children) {
            c.active = false;
            c.destroy();
        }
        const em = world.entityManager;
        // Sprites baked here, or in the prefabs the bakers will instantiate.
        const groups = prefabs.map((p) => (em.hasComponent(p, LinkedEntityGroup) ? (em.getComponent(p, LinkedEntityGroup).entities as Entity[]) : [p]));
        const needsSprites = [entities, ...groups].some((list) => list.some((e) => em.exists(e) && em.hasComponent(e, RenderSprite)));
        const hasRenderer = Array.from(EntitySpriteRenderer.all).some((r) => r.layer === 0) || !!this.getComponent(EntitySpriteRenderer);
        if (needsSprites && !hasRenderer) {
            const r = this.addComponent(EntitySpriteRenderer);
            if (r && this.spriteMaterial) r.setSharedMaterial(this.spriteMaterial, 0);
            if (inCanvas(this.node) && !this.getComponent(UIMeshRenderer)) this.addComponent(EcsUIRenderer);
        }
    }

    onDestroy() {
        if (!this.destroyEntitiesWithNode || !this.world || this.world.disposed) return;
        const em = this.world.entityManager;
        em.destroyEntity(this.entities.filter((e) => em.exists(e)));
        this.entities = [];
    }
}

