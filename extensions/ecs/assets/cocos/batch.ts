/**
 * Draws a mesh built every frame on the CPU, split into batches (one per
 * texture), with its own GPU buffers: one model per batch, each with a
 * material instance for its texture. In a Canvas, EcsUIRenderer (a
 * UIMeshRenderer) draws the batches in hierarchy order with the sprites.
 */
import { _decorator, assetManager, director, gfx, Material, ModelRenderer, Node, renderer, RenderingSubMesh, Texture2D, UIMeshRenderer, UITransform, Vec3 } from 'cc';
import { EDITOR, JSB } from 'cc/env';

const { ccclass, executeInEditMode, menu } = _decorator;

export interface Batch {
    texture: Texture2D | null;
    firstIndex: number;
    indexCount: number;
}

/** CPU side of the mesh: interleaved float vertices (colors as packed RGBA8) and indices. */
export class BatchMesh {
    vertices: Float32Array;
    colors: Uint32Array;
    indices: Uint32Array;
    vertexCount = 0;
    indexCount = 0;
    readonly batches: Batch[] = [];
    batchCount = 0;
    min = new Vec3();
    max = new Vec3();

    constructor(readonly floatsPerVertex: number) {
        this.vertices = new Float32Array(floatsPerVertex * 256);
        this.colors = new Uint32Array(this.vertices.buffer);
        this.indices = new Uint32Array(384);
    }

    reset(): void {
        this.vertexCount = 0;
        this.indexCount = 0;
        this.batchCount = 0;
        this.min.set(Infinity, Infinity, Infinity);
        this.max.set(-Infinity, -Infinity, -Infinity);
    }

    reserve(vertices: number, indices: number): void {
        const need = (this.vertexCount + vertices) * this.floatsPerVertex;
        if (need > this.vertices.length) {
            let n = this.vertices.length;
            while (n < need) n *= 2;
            const v = new Float32Array(n);
            v.set(this.vertices.subarray(0, this.vertexCount * this.floatsPerVertex));
            this.vertices = v;
            this.colors = new Uint32Array(v.buffer);
        }
        const needI = this.indexCount + indices;
        if (needI > this.indices.length) {
            let n = this.indices.length;
            while (n < needI) n *= 2;
            const i = new Uint32Array(n);
            i.set(this.indices.subarray(0, this.indexCount));
            this.indices = i;
        }
    }

    /** Continues the last batch when the texture is the same, else starts one. */
    batchFor(texture: Texture2D | null): void {
        const last = this.batchCount ? this.batches[this.batchCount - 1] : null;
        if (last && last.texture === texture) return;
        let b = this.batches[this.batchCount];
        if (!b) b = this.batches[this.batchCount] = { texture: null, firstIndex: 0, indexCount: 0 };
        b.texture = texture;
        b.firstIndex = this.indexCount;
        b.indexCount = 0;
        this.batchCount++;
    }

    grow(x: number, y: number, z: number): void {
        const a = this.min;
        const b = this.max;
        if (x < a.x) a.x = x;
        if (y < a.y) a.y = y;
        if (z < a.z) a.z = z;
        if (x > b.x) b.x = x;
        if (y > b.y) b.y = y;
        if (z > b.z) b.z = z;
    }
}

interface BatchSlot {
    model: renderer.scene.Model;
    material: renderer.MaterialInstance | null;
}

function inCanvas(node: Node | null): boolean {
    for (let n = node; n; n = n.parent) if (n.getComponent(UITransform)) return true;
    return false;
}

/** Base class of the ECS renderers: subclasses fill `mesh` and call upload(). */
@ccclass('EcsBatchedRenderer')
export abstract class BatchedRenderer extends ModelRenderer {
    protected abstract readonly mesh: BatchMesh;
    protected abstract attributes(): gfx.Attribute[];
    /** Default material (Canvas or 3D). */
    protected abstract defaultMaterial(ui: boolean): string;

    private batchSlots: BatchSlot[] = [];
    private activeBatches = 0;
    private batchMaterials = new Map<Texture2D | null, renderer.MaterialInstance>();
    private base: Material | null = null;
    private vb: gfx.Buffer | null = null;
    private ib: gfx.Buffer | null = null;
    private vbCap = 0;
    private ibCap = 0;
    private ib32 = false;
    private idx16 = new Uint16Array(384);

    resetInEditor() {
        if (inCanvas(this.node) && !this.node.getComponent(UIMeshRenderer)) this.node.addComponent('EcsUIRenderer');
        this.loadDefaultMaterial();
    }

    protected loadDefaultMaterial(): void {
        if (this.getSharedMaterial(0)) return;
        assetManager.loadAny({ uuid: this.defaultMaterial(inCanvas(this.node)) }, (err: Error | null, mat: Material) => {
            if (err || !mat || !this.isValid || this.getSharedMaterial(0)) return;
            this.setSharedMaterial(mat, 0);
        });
    }

    onLoad() {
        this.loadDefaultMaterial();
    }

    onEnable() {
        super.onEnable();
        this._attachToScene();
    }

    onDisable() {
        this._detachFromScene();
    }

    onDestroy() {
        this._detachFromScene();
        for (const b of this.batchSlots) director.root?.destroyModel(b.model);
        this.batchSlots.length = 0;
        this._models.length = 0;
        this.batchMaterials.forEach((m) => m.destroy());
        this.batchMaterials.clear();
        this.vb?.destroy();
        this.ib?.destroy();
        this.vb = this.ib = null;
    }

    /** True when a UIMeshRenderer (EcsUIRenderer) draws the batches in the UI pass. */
    protected get uiMode(): boolean {
        const ui = this.node.getComponent(UIMeshRenderer);
        return !!ui && ui.enabledInHierarchy;
    }

    private baseMaterial(): Material | null {
        const m = this.getSharedMaterial(0);
        if (m !== this.base) {
            this.batchMaterials.forEach((x) => x.destroy());
            this.batchMaterials.clear();
            this.base = m;
        }
        return m;
    }

    private materialFor(texture: Texture2D | null, index: number): renderer.MaterialInstance | null {
        const base = this.baseMaterial();
        if (!base) return null;
        let mat = this.batchMaterials.get(texture);
        if (!mat) {
            mat = new renderer.MaterialInstance({ parent: base, owner: this, subModelIdx: index });
            if (texture) mat.setProperty('mainTexture', texture);
            this.batchMaterials.set(texture, mat);
        }
        return mat;
    }

    private stride(): number {
        return this.mesh.floatsPerVertex * 4;
    }

    private subMesh(): RenderingSubMesh {
        return new RenderingSubMesh([this.vb!], this.attributes(), gfx.PrimitiveMode.TRIANGLE_LIST, this.ib!);
    }

    private ensureBuffers(vertexCount: number, indexCount: number, need32: boolean): void {
        if (this.vb && vertexCount <= this.vbCap && indexCount <= this.ibCap && need32 === this.ib32) return;
        const device = director.root!.device;
        let vCap = Math.max(256, this.vbCap);
        while (vCap < vertexCount) vCap *= 2;
        let iCap = Math.max(384, this.ibCap);
        while (iCap < indexCount) iCap *= 2;
        const old = [this.vb, this.ib];
        const stride = this.stride();
        this.vb = device.createBuffer(new gfx.BufferInfo(gfx.BufferUsageBit.VERTEX | gfx.BufferUsageBit.TRANSFER_DST, gfx.MemoryUsageBit.DEVICE, vCap * stride, stride));
        const isz = need32 ? 4 : 2;
        this.ib = device.createBuffer(new gfx.BufferInfo(gfx.BufferUsageBit.INDEX | gfx.BufferUsageBit.TRANSFER_DST, gfx.MemoryUsageBit.DEVICE, iCap * isz, isz));
        this.vbCap = vCap;
        this.ibCap = iCap;
        this.ib32 = need32;
        for (const b of this.batchSlots) b.model.setSubModelMesh(0, this.subMesh());
        for (const buf of old) buf?.destroy();
    }

    private slot(index: number, material: renderer.MaterialInstance): BatchSlot {
        let b = this.batchSlots[index];
        if (!b) {
            const model = director.root!.createModel(renderer.scene.Model);
            model.visFlags = this.visibility;
            model.node = model.transform = this.node;
            model.priority = this.priority + index;
            model.initSubModel(0, this.subMesh(), material);
            b = { model, material };
            this.batchSlots[index] = b;
            this._models.push(model);
        } else if (b.material !== material) {
            b.model.setSubModelMaterial(0, material);
            b.material = material;
        }
        return b;
    }

    private setActive(n: number): void {
        for (let i = 0; i < this.batchSlots.length; i++) {
            const on = i < n;
            if (this.batchSlots[i].model.enabled !== on) this.batchSlots[i].model.enabled = on;
        }
        this.activeBatches = n;
    }

    /** Sends `mesh` to the GPU and updates the batch models. */
    protected upload(): void {
        const m = this.mesh;
        if (!m.vertexCount || !m.indexCount || !director.root || !this.baseMaterial()) {
            this.setActive(0);
            return;
        }
        const need32 = m.vertexCount > 65535;
        this.ensureBuffers(m.vertexCount, m.indexCount, need32);
        this.vb!.update(m.vertices as unknown as ArrayBuffer, m.vertexCount * this.stride());
        if (need32) {
            this.ib!.update(m.indices as unknown as ArrayBuffer, m.indexCount * 4);
        } else {
            if (this.idx16.length < m.indexCount) this.idx16 = new Uint16Array(this.ibCap);
            this.idx16.set(m.indices.subarray(0, m.indexCount));
            this.ib!.update(this.idx16 as unknown as ArrayBuffer, m.indexCount * 2);
        }
        let drawn = 0;
        for (let i = 0; i < m.batchCount; i++) {
            const batch = m.batches[i];
            if (!batch.indexCount) continue;
            const mat = this.materialFor(batch.texture, drawn);
            if (!mat) continue;
            const s = this.slot(drawn, mat);
            const ia = s.model.subModels[0].inputAssembler;
            ia.firstIndex = batch.firstIndex;
            ia.indexCount = batch.indexCount;
            ia.vertexCount = m.vertexCount;
            s.model.createBoundingShape(m.min, m.max);
            s.model.updateWorldBound();
            drawn++;
        }
        this.setActive(drawn);
        this._attachToScene();
    }

    /** Batch models and their materials, in draw order (EcsUIRenderer). */
    _uiBatches(out: { model: renderer.scene.Model; material: Material }[] = []): { model: renderer.scene.Model; material: Material }[] {
        out.length = 0;
        for (let i = 0; i < this.activeBatches; i++) {
            const b = this.batchSlots[i];
            if (b.material) out.push({ model: b.model, material: b.material });
        }
        return out;
    }

    protected _attachToScene(): void {
        if (!this.node.scene || this.uiMode || !this.enabledInHierarchy) return;
        const scene = this._getRenderScene();
        for (const b of this.batchSlots) {
            if (b.model.scene !== scene) {
                if (b.model.scene) b.model.scene.removeModel(b.model);
                scene.addModel(b.model);
            }
        }
    }

    public _detachFromScene(): void {
        if (!this.batchSlots) return;
        for (const b of this.batchSlots) if (b.model.scene) b.model.scene.removeModel(b.model);
    }

    protected _onMaterialModified(index: number, material: Material | null): void {
        super._onMaterialModified(index, material);
        if (index === 0) this.baseMaterial();
    }

    public _onRebuildPSO(index: number, material: Material | null): void {
        for (const b of this.batchSlots) if (material && b.material === material) b.model.setSubModelMaterial(0, material);
    }

    protected _onVisibilityChange(val: number): void {
        if (this.batchSlots) for (const b of this.batchSlots) b.model.visFlags = val;
    }

    protected _updatePriority(): void {
        if (this.batchSlots) this.batchSlots.forEach((b, i) => (b.model.priority = this.priority + i));
    }

    public getMaterialInstance(idx: number): renderer.MaterialInstance | null {
        if (JSB && idx < this.activeBatches && this.batchSlots[idx]?.material) return this.batchSlots[idx].material;
        return super.getMaterialInstance(idx);
    }

    /** Batches drawn last frame (debug). */
    get drawCalls(): number {
        return this.activeBatches;
    }
}

// EcsUIRenderer is in ui-renderer.ts: Cocos allows one Component class per script.

export const isEditor = EDITOR;
