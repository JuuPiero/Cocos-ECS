/**
 * Transforms (Unity.Transforms): LocalTransform (position, rotation, uniform
 * scale) relative to the Parent entity, or to the world without one;
 * LocalToWorld is computed from them every frame by LocalToWorldSystem.
 * Matrices are column-major like Cocos' Mat4 (m12, m13, m14 = translation).
 */
import { component, entity, f32, typeOf } from './component';
import type { Entity } from './entity';
import { EntityQuery } from './query';
import {
    BeginPresentationEntityCommandBufferSystem, ComponentSystemGroup, EndSimulationEntityCommandBufferSystem, PresentationSystemGroup,
    SimulationSystemGroup, SystemBase, system,
} from './system';

@component('LocalTransform')
export class LocalTransform {
    @f32 x = 0;
    @f32 y = 0;
    @f32 z = 0;
    /** Rotation quaternion. */
    @f32 qx = 0;
    @f32 qy = 0;
    @f32 qz = 0;
    @f32 qw = 1;
    /** Uniform scale. */
    @f32 scale = 1;
}

/** Non-uniform scale applied after LocalTransform (Unity's PostTransformMatrix, scale only). */
@component('PostTransformScale')
export class PostTransformScale {
    @f32 x = 1;
    @f32 y = 1;
    @f32 z = 1;
}

/** The entity's transform is relative to this one. */
@component('Parent')
export class Parent {
    @entity value: Entity = 0;
}

/** World matrix (column-major), written by LocalToWorldSystem. */
@component('LocalToWorld')
export class LocalToWorld {
    @f32 m00 = 1; @f32 m01 = 0; @f32 m02 = 0; @f32 m03 = 0;
    @f32 m04 = 0; @f32 m05 = 1; @f32 m06 = 0; @f32 m07 = 0;
    @f32 m08 = 0; @f32 m09 = 0; @f32 m10 = 1; @f32 m11 = 0;
    @f32 m12 = 0; @f32 m13 = 0; @f32 m14 = 0; @f32 m15 = 1;
}

const M = ['m00', 'm01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08', 'm09', 'm10', 'm11', 'm12', 'm13', 'm14', 'm15'] as const;

// ------------------------------------------------------------------ helpers

/** Sets a rotation around Z in degrees (2D). */
export function setAngle(t: LocalTransform, degrees: number): void {
    const h = (degrees * Math.PI) / 360;
    t.qx = 0;
    t.qy = 0;
    t.qz = Math.sin(h);
    t.qw = Math.cos(h);
}

/** Rotation around Z in degrees (2D). */
export function getAngle(t: LocalTransform): number {
    return (Math.atan2(2 * (t.qw * t.qz + t.qx * t.qy), 1 - 2 * (t.qy * t.qy + t.qz * t.qz)) * 180) / Math.PI;
}

/** Sets a rotation from Euler angles in degrees (same order as Cocos' Quat.fromEuler). */
export function setEuler(t: LocalTransform, x: number, y: number, z: number): void {
    const h = Math.PI / 360;
    const sx = Math.sin(x * h), cx = Math.cos(x * h);
    const sy = Math.sin(y * h), cy = Math.cos(y * h);
    const sz = Math.sin(z * h), cz = Math.cos(z * h);
    t.qx = sx * cy * cz + cx * sy * sz;
    t.qy = cx * sy * cz + sx * cy * sz;
    t.qz = cx * cy * sz - sx * sy * cz;
    t.qw = cx * cy * cz - sx * sy * sz;
}

/** out = TRS (and non-uniform scale) as 16 numbers, column-major. */
export function composeMatrix(
    out: Float32Array | number[], o: number,
    x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number, s: number, sx = 1, sy = 1, sz = 1,
): void {
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const ax = s * sx, ay = s * sy, az = s * sz;
    out[o] = (1 - (yy + zz)) * ax;
    out[o + 1] = (xy + wz) * ax;
    out[o + 2] = (xz - wy) * ax;
    out[o + 3] = 0;
    out[o + 4] = (xy - wz) * ay;
    out[o + 5] = (1 - (xx + zz)) * ay;
    out[o + 6] = (yz + wx) * ay;
    out[o + 7] = 0;
    out[o + 8] = (xz + wy) * az;
    out[o + 9] = (yz - wx) * az;
    out[o + 10] = (1 - (xx + yy)) * az;
    out[o + 11] = 0;
    out[o + 12] = x;
    out[o + 13] = y;
    out[o + 14] = z;
    out[o + 15] = 1;
}

/** out = a * b (16 numbers each, column-major). `out` may not alias a or b. */
export function multiplyMatrix(out: number[] | Float32Array, a: ArrayLike<number>, b: ArrayLike<number>): void {
    for (let c = 0; c < 4; c++) {
        const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
        out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
        out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
        out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
        out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
}

// ------------------------------------------------------------------ systems

/** Transform systems, last in the simulation (Unity's TransformSystemGroup). */
@system({ group: SimulationSystemGroup, orderLast: true, updateBefore: [EndSimulationEntityCommandBufferSystem], name: 'TransformSystemGroup' })
export class TransformSystemGroup extends ComponentSystemGroup {}

const tmpLocal = new Float32Array(16);
const tmpParent = new Float32Array(16);
const tmpOut = new Float32Array(16);

/** Computes LocalToWorld from LocalTransform (and PostTransformScale), parents first. */
@system({ group: TransformSystemGroup, name: 'LocalToWorldSystem' })
export class LocalToWorldSystem extends SystemBase {
    private roots!: EntityQuery;
    private children!: EntityQuery;
    private order: Entity[] = [];
    private orderVersion = -1;
    /** The EntityManager's structure version when the matrices were last computed. */
    structureAtUpdate = -1;

    protected onCreate(): void {
        this.roots = this.getQuery({ all: [LocalTransform, LocalToWorld], none: [Parent] });
        this.children = this.getQuery({ all: [LocalTransform, LocalToWorld, Parent] });
    }

    protected onUpdate(): void {
        this.structureAtUpdate = this.entityManager.structureVersion;
        // Roots: straight from their local transform.
        for (const a of this.roots.archetypes) {
            const t = a.get(LocalTransform);
            const s = a.has(PostTransformScale) ? a.get(PostTransformScale) : null;
            const out = a.write(LocalToWorld);
            const cols = M.map((k) => out[k]) as Float32Array[];
            for (let i = 0; i < a.count; i++) {
                composeMatrix(tmpOut, 0, t.x[i], t.y[i], t.z[i], t.qx[i], t.qy[i], t.qz[i], t.qw[i], t.scale[i],
                    s ? s.x[i] : 1, s ? s.y[i] : 1, s ? s.z[i] : 1);
                for (let k = 0; k < 16; k++) cols[k][i] = tmpOut[k];
            }
        }
        if (this.children.isEmpty()) return;
        // Children: parents before children (sorted by depth when the hierarchy changes).
        const em = this.entityManager;
        if (this.orderVersion !== em.structureVersion) this.sortChildren();
        for (const e of this.order) {
            const loc = em.location(e);
            if (!loc) continue;
            const parent = (loc.archetype.get(Parent).value as Int32Array)[loc.row];
            const ploc = em.location(parent);
            const a = loc.archetype;
            const r = loc.row;
            const t = a.get(LocalTransform);
            const s = a.has(PostTransformScale) ? a.get(PostTransformScale) : null;
            composeMatrix(tmpLocal, 0, t.x[r], t.y[r], t.z[r], t.qx[r], t.qy[r], t.qz[r], t.qw[r], t.scale[r],
                s ? s.x[r] : 1, s ? s.y[r] : 1, s ? s.z[r] : 1);
            const out = a.write(LocalToWorld);
            if (ploc && ploc.archetype.has(LocalToWorld)) {
                const p = ploc.archetype.get(LocalToWorld);
                for (let k = 0; k < 16; k++) tmpParent[k] = p[M[k]][ploc.row];
                multiplyMatrix(tmpOut, tmpParent, tmpLocal);
                for (let k = 0; k < 16; k++) out[M[k]][r] = tmpOut[k];
            } else {
                for (let k = 0; k < 16; k++) out[M[k]][r] = tmpLocal[k];
            }
        }
    }

    private sortChildren(): void {
        const em = this.entityManager;
        const list = this.children.toEntityArray();
        const depth = new Map<Entity, number>();
        const depthOf = (e: Entity, guard: number): number => {
            const d = depth.get(e);
            if (d !== undefined) return d;
            if (guard > 64 || !em.hasComponent(e, Parent)) return 0;
            const p = em.getComponent(e, Parent).value;
            const v = em.exists(p) ? depthOf(p, guard + 1) + 1 : 0;
            depth.set(e, v);
            return v;
        };
        for (const e of list) depthOf(e, 0);
        list.sort((a, b) => (depth.get(a) ?? 0) - (depth.get(b) ?? 0));
        this.order = list;
        this.orderVersion = em.structureVersion;
    }
}

/**
 * Recomputes LocalToWorld at the start of the presentation when transforms
 * changed after the simulation (e.g. Cocos scripts moved entities in
 * update()), so rendering never lags a frame.
 */
@system({ group: PresentationSystemGroup, orderFirst: true, updateAfter: [BeginPresentationEntityCommandBufferSystem], name: 'LateTransformSystem' })
export class LateTransformSystem extends SystemBase {
    protected onUpdate(): void {
        const l2w = this.world.getSystem(LocalToWorldSystem);
        if (!l2w || !l2w.enabled) return;
        const em = this.entityManager;
        const since = l2w.lastSystemVersion;
        let dirty = em.structureVersion !== l2w.structureAtUpdate;
        if (!dirty) {
            const types = [typeOf(LocalTransform), typeOf(Parent), typeOf(PostTransformScale)];
            outer: for (const a of em.archetypes) {
                if (!a.count) continue;
                for (const t of types) {
                    const c = a.column(t);
                    if (c && c.version > since) {
                        dirty = true;
                        break outer;
                    }
                }
            }
        }
        if (dirty) l2w.update();
    }
}

/** World position of an entity (from LocalToWorld). */
export function worldPosition(t: LocalToWorld): { x: number; y: number; z: number } {
    return { x: t.m12, y: t.m13, z: t.m14 };
}
