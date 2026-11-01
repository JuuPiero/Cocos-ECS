/**
 * 2D rendering of entities: thousands of sprites in a few draw calls (one per
 * texture), without nodes.
 *
 *     const e = em.createEntity(LocalTransform, LocalToWorld, RenderSprite);
 *     em.setComponent(e, RenderSprite, { frame, color: rgba(255, 200, 200) });
 *
 * An EntitySpriteRenderer on a node (in a Canvas or a 3D scene) draws the
 * sprites of its layer, relative to its node.
 */
import { _decorator, CCInteger, ccenum, Color, gfx, Mat4, SpriteFrame, Texture2D } from 'cc';
import { bool, component, f32, i32, ref, u32, u8 } from '../core/component';
import { LateTransformSystem, LocalToWorld } from '../core/transforms';
import { PresentationSystemGroup, SystemBase, system } from '../core/system';
import { EntityQuery } from '../core/query';
import type { World } from '../core/world';
import { BatchMesh, BatchedRenderer } from './batch';
import { defaultWorld } from './bootstrap';

const { ccclass, property, executeInEditMode, menu, disallowMultiple } = _decorator;

/** Default sprite materials (shipped with the extension). */
export const SPRITE_UI_MATERIAL = 'aa4fc8eb-6d2d-4013-81d8-1faca1f0c388';
export const SPRITE_WORLD_MATERIAL = 'bc438cc4-5eb2-4087-9464-adbed1cd050a';

/** Packs a color for RenderSprite.color (0..255 per channel). */
export function rgba(r: number, g: number, b: number, a = 255): number {
    return ((r & 255) | ((g & 255) << 8) | ((b & 255) << 16) | ((a & 255) << 24)) >>> 0;
}

/** Packs a Cocos Color for RenderSprite.color. */
export function packColor(c: Readonly<Color>): number {
    return rgba(c.r, c.g, c.b, c.a);
}

/** A sprite drawn at the entity's LocalToWorld by the EntitySpriteRenderer of its layer. */
@component('RenderSprite')
export class RenderSprite {
    @ref frame: SpriteFrame | null = null;
    /** Packed RGBA (see rgba()). White by default. */
    @u32 color = 0xffffffff;
    /** Size in units (0: the frame's original size). */
    @f32 width = 0;
    @f32 height = 0;
    @f32 anchorX = 0.5;
    @f32 anchorY = 0.5;
    /** Draw order inside its renderer (higher on top, with sortMode Order). */
    @i32 order = 0;
    /** Which EntitySpriteRenderer draws it (its `layer`). */
    @u8 layer = 0;
    @bool flipX = false;
    @bool flipY = false;
}

export enum SpriteSortMode {
    /** Creation order (fastest). */
    None = 0,
    /** By RenderSprite.order. */
    Order = 1,
    /** Lower on screen in front (top-down games), then by order. */
    Y = 2,
    /** By order, then lower Y in front. */
    OrderThenY = 3,
}
ccenum(SpriteSortMode);

const FLOATS = 6; // x y z u v color
let ATTRS: gfx.Attribute[] | null = null;

const _inv = new Mat4();

/** Draws the RenderSprite entities of a layer (Unity's batched sprite rendering, for Cocos). */
@ccclass('EntitySpriteRenderer')
@executeInEditMode
@disallowMultiple
@menu('ECS/EntitySpriteRenderer')
export class EntitySpriteRenderer extends BatchedRenderer {
    /** Enabled renderers (SpriteRenderSystem draws them). */
    static readonly all = new Set<EntitySpriteRenderer>();

    @property({ type: CCInteger, range: [0, 255, 1], tooltip: 'Draws the entities whose RenderSprite.layer is this.' })
    layer = 0;

    @property({ type: SpriteSortMode, tooltip: 'Draw order of the sprites.' })
    sortMode = SpriteSortMode.Order;

    protected readonly mesh = new BatchMesh(FLOATS);
    private order: Float64Array = new Float64Array(0);
    private keys: Float64Array = new Float64Array(0);
    private refs: { a: any; i: number }[] = [];
    /** Sprites drawn last frame (debug). */
    spriteCount = 0;

    protected attributes(): gfx.Attribute[] {
        if (!ATTRS) {
            ATTRS = [
                new gfx.Attribute(gfx.AttributeName.ATTR_POSITION, gfx.Format.RGB32F),
                new gfx.Attribute(gfx.AttributeName.ATTR_TEX_COORD, gfx.Format.RG32F),
                new gfx.Attribute(gfx.AttributeName.ATTR_COLOR, gfx.Format.RGBA8, true),
            ];
        }
        return ATTRS;
    }

    protected defaultMaterial(ui: boolean): string {
        return ui ? SPRITE_UI_MATERIAL : SPRITE_WORLD_MATERIAL;
    }

    onEnable() {
        super.onEnable();
        EntitySpriteRenderer.all.add(this);
        defaultWorld();
    }

    onDisable() {
        super.onDisable();
        EntitySpriteRenderer.all.delete(this);
    }

    onDestroy() {
        EntitySpriteRenderer.all.delete(this);
        super.onDestroy();
    }

    /** Builds and uploads the mesh of this layer's sprites (called by SpriteRenderSystem). */
    rebuild(query: EntityQuery): void {
        const m = this.mesh;
        m.reset();
        // Gather this layer's sprites.
        const refs = this.refs;
        let n = 0;
        for (const a of query.archetypes) {
            const s = a.get(RenderSprite);
            const layers = s.layer as Uint8Array;
            const frames = s.frame as (SpriteFrame | null)[];
            for (let i = 0; i < a.count; i++) {
                if (layers[i] !== this.layer || !frames[i] || !frames[i]!.texture) continue;
                const r = refs[n] || (refs[n] = { a: null, i: 0 });
                r.a = a;
                r.i = i;
                n++;
            }
        }
        this.spriteCount = n;
        if (!n) {
            this.upload();
            return;
        }
        // Order.
        if (this.order.length < n) {
            this.order = new Float64Array(Math.max(n, this.order.length * 2));
            this.keys = new Float64Array(this.order.length);
        }
        const order = this.order;
        for (let k = 0; k < n; k++) order[k] = k;
        if (this.sortMode !== SpriteSortMode.None) {
            const keys = this.keys;
            for (let k = 0; k < n; k++) {
                const r = refs[k];
                const o = (r.a.get(RenderSprite).order as Int32Array)[r.i];
                const y = (r.a.get(LocalToWorld).m13 as Float32Array)[r.i];
                switch (this.sortMode) {
                    case SpriteSortMode.Order: keys[k] = o; break;
                    case SpriteSortMode.Y: keys[k] = -y * 1024 + o; break;
                    default: keys[k] = o * 1e6 - y; break;
                }
            }
            const idx = Array.from(order.subarray(0, n));
            idx.sort((x, y) => keys[x] - keys[y] || x - y);
            order.set(idx);
        }
        // Vertices, relative to this node.
        Mat4.invert(_inv, this.node.worldMatrix);
        const inv = _inv;
        m.reserve(n * 4, n * 6);
        const v = m.vertices;
        const c = m.colors;
        const idx = m.indices;
        for (let k = 0; k < n; k++) {
            const r = refs[order[k]];
            const a = r.a;
            const i = r.i;
            const s = a.get(RenderSprite);
            const frame = (s.frame as SpriteFrame[])[i];
            const tex = frame.texture as Texture2D;
            m.batchFor(tex);
            const os = frame.originalSize;
            const rect = frame.rect;
            const off = frame.offset;
            const ow = os.width || rect.width;
            const oh = os.height || rect.height;
            const w = s.width[i] || ow;
            const h = s.height[i] || oh;
            const sx = w / ow;
            const sy = h / oh;
            const ax = s.anchorX[i] * w;
            const ay = s.anchorY[i] * h;
            // Trimmed frames: the visible rect inside the original size (like cc.Sprite).
            let l = (off.x + (ow - rect.width) / 2) * sx - ax;
            let b = (off.y + (oh - rect.height) / 2) * sy - ay;
            let rr = w + (off.x - (ow - rect.width) / 2) * sx - ax;
            let t = h + (off.y - (oh - rect.height) / 2) * sy - ay;
            // Mirror the corners (each keeps its UV) around the anchor.
            if (s.flipX[i]) {
                l = -l;
                rr = -rr;
            }
            if (s.flipY[i]) {
                b = -b;
                t = -t;
            }
            const M = a.get(LocalToWorld);
            const m00 = M.m00[i], m01 = M.m01[i], m02 = M.m02[i];
            const m04 = M.m04[i], m05 = M.m05[i], m06 = M.m06[i];
            const m12 = M.m12[i], m13 = M.m13[i], m14 = M.m14[i];
            const color = (s.color as Uint32Array)[i];
            const uv = frame.uv;
            const base = m.vertexCount;
            let o = base * FLOATS;
            // bl, br, tl, tr (cc.SpriteFrame.uv order).
            for (let q = 0; q < 4; q++) {
                const lx = q & 1 ? rr : l;
                const ly = q & 2 ? t : b;
                const wx = m00 * lx + m04 * ly + m12;
                const wy = m01 * lx + m05 * ly + m13;
                const wz = m02 * lx + m06 * ly + m14;
                const x = inv.m00 * wx + inv.m04 * wy + inv.m08 * wz + inv.m12;
                const y = inv.m01 * wx + inv.m05 * wy + inv.m09 * wz + inv.m13;
                const z = inv.m02 * wx + inv.m06 * wy + inv.m10 * wz + inv.m14;
                v[o] = x;
                v[o + 1] = y;
                v[o + 2] = z;
                v[o + 3] = uv[q * 2];
                v[o + 4] = uv[q * 2 + 1];
                c[o + 5] = color;
                m.grow(x, y, z);
                o += FLOATS;
            }
            const ii = m.indexCount;
            idx[ii] = base;
            idx[ii + 1] = base + 1;
            idx[ii + 2] = base + 2;
            idx[ii + 3] = base + 2;
            idx[ii + 4] = base + 1;
            idx[ii + 5] = base + 3;
            m.indexCount += 6;
            m.vertexCount += 4;
            m.batches[m.batchCount - 1].indexCount += 6;
        }
        for (let k = 0; k < n; k++) refs[k].a = null;
        this.upload();
    }
}

/** Builds every EntitySpriteRenderer's mesh after the transforms (Presentation). */
@system({ group: PresentationSystemGroup, updateAfter: [LateTransformSystem], name: 'SpriteRenderSystem' })
export class SpriteRenderSystem extends SystemBase {
    private sprites = this.getQuery({ all: [RenderSprite, LocalToWorld] });

    protected onUpdate(): void {
        for (const r of EntitySpriteRenderer.all) {
            if (!r.isValid || !r.enabledInHierarchy) continue;
            if (rendererWorld(r) !== this.world) continue;
            r.rebuild(this.sprites);
        }
    }
}

/** The world a renderer draws (the default world). */
function rendererWorld(_r: EntitySpriteRenderer): World | null {
    return defaultWorld();
}
