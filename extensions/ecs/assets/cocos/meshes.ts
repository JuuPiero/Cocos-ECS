/**
 * 3D rendering of entities with GPU instancing: every entity that uses the
 * same mesh and material is drawn in one call, without nodes.
 *
 *     em.setComponent(e, RenderMesh, { mesh, material, color: rgba(255, 80, 80) });
 *
 * Materials must use the extension's ecs-mesh effect (lit, unlit or
 * transparent): it reads each instance's world matrix and color. An
 * EntityMeshRenderer in the scene draws the entities of its layer.
 */
import { _decorator, assetManager, CCInteger, director, gfx, Mat4, Material, Mesh, ModelRenderer, renderer, RenderingSubMesh, Vec3 } from 'cc';
import { EDITOR } from 'cc/env';
import { component, ref, u32, u8 } from '../core/component';
import { EntityQuery } from '../core/query';
import { PresentationSystemGroup, SystemBase, system } from '../core/system';
import { LateTransformSystem, LocalToWorld } from '../core/transforms';
import { defaultWorld } from './bootstrap';

const { ccclass, property, executeInEditMode, menu, disallowMultiple } = _decorator;

/** Default instanced materials (shipped with the extension). */
export const MESH_LIT_MATERIAL = '11df77da-dae0-4606-9cd4-52643a8b699d';
export const MESH_UNLIT_MATERIAL = '291098b0-7437-47cd-84f4-67ac26c09148';

/** A mesh drawn at the entity's LocalToWorld by the EntityMeshRenderer of its layer. */
@component('RenderMesh')
export class RenderMesh {
    @ref mesh: Mesh | null = null;
    /** A material made from the ecs-mesh effect (null: the renderer's material). */
    @ref material: Material | null = null;
    @u8 subMesh = 0;
    /** Packed RGBA tint (see rgba()). */
    @u32 color = 0xffffffff;
    /** Which EntityMeshRenderer draws it. */
    @u8 layer = 0;
}

const INSTANCE_FLOATS = 13; // three matrix rows + packed color
const INSTANCE_STRIDE = INSTANCE_FLOATS * 4;

interface Group {
    mesh: Mesh;
    subMeshIndex: number;
    material: Material;
    instance: renderer.MaterialInstance;
    model: renderer.scene.Model | null;
    vb: gfx.Buffer | null;
    capacity: number;
    data: Float32Array;
    u32: Uint32Array;
    count: number;
    min: Vec3;
    max: Vec3;
    radius: number;
    /** Largest instance scale × mesh radius this frame (bounds padding). */
    pad: number;
    unused: number;
}

let instanceAttributes: ((stream: number) => gfx.Attribute[]) | null = null;
function instanceAttrs(stream: number): gfx.Attribute[] {
    if (!instanceAttributes) {
        instanceAttributes = (s) => [
            new gfx.Attribute('a_inst0', gfx.Format.RGBA32F, false, s, true),
            new gfx.Attribute('a_inst1', gfx.Format.RGBA32F, false, s, true),
            new gfx.Attribute('a_inst2', gfx.Format.RGBA32F, false, s, true),
            new gfx.Attribute('a_instColor', gfx.Format.RGBA8, true, s, true),
        ];
    }
    return instanceAttributes(stream);
}

const _inv = new Mat4();
const _c = new Vec3();

/** Draws the RenderMesh entities of a layer, one instanced draw per mesh + material. */
@ccclass('EntityMeshRenderer')
@executeInEditMode
@disallowMultiple
@menu('ECS/EntityMeshRenderer')
export class EntityMeshRenderer extends ModelRenderer {
    static readonly all = new Set<EntityMeshRenderer>();

    @property({ type: CCInteger, range: [0, 255, 1], tooltip: 'Draws the entities whose RenderMesh.layer is this.' })
    layer = 0;

    private groups = new Map<string, Group>();
    /** Instanced draw calls last frame / entities drawn (debug). */
    drawCalls = 0;
    instanceCount = 0;

    resetInEditor() {
        this.loadDefaultMaterial();
    }

    private loadDefaultMaterial(): void {
        if (this.getSharedMaterial(0)) return;
        assetManager.loadAny({ uuid: MESH_LIT_MATERIAL }, (err: Error | null, mat: Material) => {
            if (!err && mat && this.isValid && !this.getSharedMaterial(0)) this.setSharedMaterial(mat, 0);
        });
    }

    onLoad() {
        this.loadDefaultMaterial();
    }

    onEnable() {
        super.onEnable();
        EntityMeshRenderer.all.add(this);
        defaultWorld();
        this._attachToScene();
    }

    onDisable() {
        EntityMeshRenderer.all.delete(this);
        this._detachFromScene();
    }

    onDestroy() {
        EntityMeshRenderer.all.delete(this);
        this._detachFromScene();
        for (const g of this.groups.values()) this.disposeGroup(g);
        this.groups.clear();
        this._models.length = 0;
    }

    private disposeGroup(g: Group): void {
        if (g.model) {
            g.model.scene?.removeModel(g.model);
            director.root?.destroyModel(g.model);
        }
        // The sub-mesh shares the mesh's buffers: only our instance buffer is ours.
        g.vb?.destroy();
        g.instance.destroy();
        g.model = null;
        g.vb = null;
    }

    private groupFor(mesh: Mesh, sub: number, material: Material): Group {
        const key = `${mesh._uuid || (mesh as any).__id || mesh.name}|${sub}|${material._uuid || material.name}`;
        let g = this.groups.get(key);
        if (!g) {
            const s = mesh.struct;
            const min = s.minPosition || new Vec3(-0.5, -0.5, -0.5);
            const max = s.maxPosition || new Vec3(0.5, 0.5, 0.5);
            g = {
                mesh, subMeshIndex: sub, material,
                instance: new renderer.MaterialInstance({ parent: material, owner: this }),
                model: null, vb: null, capacity: 0,
                data: new Float32Array(INSTANCE_FLOATS * 64), u32: null as any, count: 0,
                min: new Vec3(), max: new Vec3(),
                radius: Math.max(Vec3.len(min), Vec3.len(max)),
                pad: 0,
                unused: 0,
            };
            g.u32 = new Uint32Array(g.data.buffer);
            this.groups.set(key, g);
        }
        return g;
    }

    private push(g: Group, M: Record<string, Float32Array>, i: number, color: number): void {
        if ((g.count + 1) * INSTANCE_FLOATS > g.data.length) {
            const d = new Float32Array(g.data.length * 2);
            d.set(g.data);
            g.data = d;
            g.u32 = new Uint32Array(d.buffer);
        }
        const o = g.count * INSTANCE_FLOATS;
        const d = g.data;
        d[o] = M.m00[i]; d[o + 1] = M.m04[i]; d[o + 2] = M.m08[i]; d[o + 3] = M.m12[i];
        d[o + 4] = M.m01[i]; d[o + 5] = M.m05[i]; d[o + 6] = M.m09[i]; d[o + 7] = M.m13[i];
        d[o + 8] = M.m02[i]; d[o + 9] = M.m06[i]; d[o + 10] = M.m10[i]; d[o + 11] = M.m14[i];
        g.u32[o + 12] = color;
        const x = M.m12[i], y = M.m13[i], z = M.m14[i];
        if (g.count === 0) {
            g.min.set(x, y, z);
            g.max.set(x, y, z);
        } else {
            if (x < g.min.x) g.min.x = x;
            if (y < g.min.y) g.min.y = y;
            if (z < g.min.z) g.min.z = z;
            if (x > g.max.x) g.max.x = x;
            if (y > g.max.y) g.max.y = y;
            if (z > g.max.z) g.max.z = z;
        }
        const sx = M.m00[i] * M.m00[i] + M.m01[i] * M.m01[i] + M.m02[i] * M.m02[i];
        const sy = M.m04[i] * M.m04[i] + M.m05[i] * M.m05[i] + M.m06[i] * M.m06[i];
        const sz = M.m08[i] * M.m08[i] + M.m09[i] * M.m09[i] + M.m10[i] * M.m10[i];
        const scale = Math.sqrt(Math.max(sx, sy, sz));
        if (scale * g.radius > g.pad) g.pad = scale * g.radius;
        g.count++;
    }

    private upload(g: Group): void {
        const root = director.root!;
        const src = g.mesh.renderingSubMeshes[g.subMeshIndex];
        if (!src) return;
        if (!g.vb || g.count > g.capacity) {
            let cap = Math.max(64, g.capacity);
            while (cap < g.count) cap *= 2;
            const old = g.vb;
            g.vb = root.device.createBuffer(new gfx.BufferInfo(
                gfx.BufferUsageBit.VERTEX | gfx.BufferUsageBit.TRANSFER_DST, gfx.MemoryUsageBit.DEVICE, cap * INSTANCE_STRIDE, INSTANCE_STRIDE,
            ));
            g.capacity = cap;
            const stream = src.vertexBuffers.length;
            const sub = new RenderingSubMesh([...src.vertexBuffers, g.vb], [...src.attributes, ...instanceAttrs(stream)], src.primitiveMode, src.indexBuffer);
            if (!g.model) {
                const model = root.createModel(renderer.scene.Model);
                model.visFlags = this.visibility;
                model.node = model.transform = this.node;
                model.initSubModel(0, sub, g.instance);
                g.model = model;
                this._models.push(model);
            } else {
                g.model.setSubModelMesh(0, sub);
            }
            old?.destroy();
        }
        g.vb.update(g.data as unknown as ArrayBuffer, g.count * INSTANCE_STRIDE);
        const ia = g.model!.subModels[0].inputAssembler;
        ia.instanceCount = g.count;
        // Bounds in this node's space (the instances are in world space).
        const pad = g.pad || 1;
        Mat4.invert(_inv, this.node.worldMatrix);
        const lo = new Vec3(Infinity, Infinity, Infinity);
        const hi = new Vec3(-Infinity, -Infinity, -Infinity);
        for (let k = 0; k < 8; k++) {
            _c.set(k & 1 ? g.max.x + pad : g.min.x - pad, k & 2 ? g.max.y + pad : g.min.y - pad, k & 4 ? g.max.z + pad : g.min.z - pad);
            Vec3.transformMat4(_c, _c, _inv);
            Vec3.min(lo, lo, _c);
            Vec3.max(hi, hi, _c);
        }
        g.model!.createBoundingShape(lo, hi);
        g.model!.updateWorldBound();
        g.model!.enabled = true;
    }

    /** Gathers this layer's entities into instanced draws (called by MeshRenderSystem). */
    rebuild(query: EntityQuery): void {
        if (EDITOR && !director.root) return;
        const fallback = this.getSharedMaterial(0);
        for (const g of this.groups.values()) {
            g.count = 0;
            g.pad = 0;
        }
        for (const a of query.archetypes) {
            const r = a.get(RenderMesh);
            const meshes = r.mesh as (Mesh | null)[];
            const mats = r.material as (Material | null)[];
            const layers = r.layer as Uint8Array;
            const subs = r.subMesh as Uint8Array;
            const colors = r.color as Uint32Array;
            const M = a.get(LocalToWorld) as Record<string, Float32Array>;
            for (let i = 0; i < a.count; i++) {
                const mesh = meshes[i];
                if (!mesh || layers[i] !== this.layer) continue;
                const mat = mats[i] || fallback;
                if (!mat) continue;
                this.push(this.groupFor(mesh, subs[i], mat), M, i, colors[i]);
            }
        }
        let draws = 0;
        let instances = 0;
        for (const [key, g] of this.groups) {
            if (g.count === 0) {
                if (g.model) g.model.enabled = false;
                // Forget groups unused for a while (meshes / materials no longer drawn).
                if (++g.unused > 120) {
                    this.disposeGroup(g);
                    this.groups.delete(key);
                    const i = g.model ? this._models.indexOf(g.model) : -1;
                    if (i >= 0) this._models.splice(i, 1);
                }
                continue;
            }
            g.unused = 0;
            this.upload(g);
            draws++;
            instances += g.count;
        }
        this.drawCalls = draws;
        this.instanceCount = instances;
        this._models.length = 0;
        for (const g of this.groups.values()) if (g.model) this._models.push(g.model);
        this._attachToScene();
    }

    protected _attachToScene(): void {
        if (!this.node.scene || !this.enabledInHierarchy) return;
        const scene = this._getRenderScene();
        for (const g of this.groups.values()) {
            if (g.model && g.model.scene !== scene) {
                g.model.scene?.removeModel(g.model);
                scene.addModel(g.model);
            }
        }
    }

    public _detachFromScene(): void {
        if (!this.groups) return;
        for (const g of this.groups.values()) if (g.model?.scene) g.model.scene.removeModel(g.model);
    }

    protected _onVisibilityChange(val: number): void {
        if (this.groups) for (const g of this.groups.values()) if (g.model) g.model.visFlags = val;
    }
}

/** Builds every EntityMeshRenderer's instance data after the transforms (Presentation). */
@system({ group: PresentationSystemGroup, updateAfter: [LateTransformSystem], name: 'MeshRenderSystem' })
export class MeshRenderSystem extends SystemBase {
    private meshes = this.getQuery({ all: [RenderMesh, LocalToWorld] });

    protected onUpdate(): void {
        for (const r of EntityMeshRenderer.all) {
            if (r.isValid && r.enabledInHierarchy) r.rebuild(this.meshes);
        }
    }
}
