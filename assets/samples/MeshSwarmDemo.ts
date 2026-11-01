/**
 * Sample: thousands of cubes orbiting and spinning, drawn with GPU
 * instancing (one draw call per mesh + material). Put it on a node in a 3D
 * scene, press Play, and open Panel > ECS Entities.
 */
import { _decorator, CCInteger, Component, Material, Mesh, primitives, utils } from 'cc';
import {
    defaultWorld, EntityMeshRenderer, LocalToWorld, LocalTransform, RenderMesh, SystemBase, component, f32, rgba, setEuler, system,
} from 'db://ecs/index';
import type { Entity } from 'db://ecs/index';

const { ccclass, property, menu } = _decorator;

@component('Orbit')
export class Orbit {
    @f32 radius = 5;
    @f32 angle = 0;
    /** Radians per second. */
    @f32 speed = 1;
    @f32 height = 0;
    @f32 spin = 90;
    @f32 rx = 0;
    @f32 ry = 0;
}

@system({ name: 'OrbitSystem' })
export class OrbitSystem extends SystemBase {
    private q = this.query(LocalTransform, Orbit);

    protected onUpdate(): void {
        const dt = this.time.deltaTime;
        this.q.forEach((e, t, o) => {
            o.angle += o.speed * dt;
            t.x = Math.cos(o.angle) * o.radius;
            t.z = Math.sin(o.angle) * o.radius;
            t.y = o.height + Math.sin(o.angle * 3) * 0.5;
            o.rx += o.spin * dt;
            o.ry += o.spin * 0.7 * dt;
            setEuler(t, o.rx, o.ry, 0);
        });
    }
}

let boxMesh: Mesh | null = null;

@ccclass('MeshSwarmDemo')
@menu('ECS/Samples/MeshSwarmDemo')
export class MeshSwarmDemo extends Component {
    @property({ type: Mesh, tooltip: 'Mesh of each entity (a box when empty).' })
    mesh: Mesh | null = null;

    @property({ type: Material, tooltip: 'A material made from the ecs-mesh effect (the renderer\'s default when empty).' })
    material: Material | null = null;

    @property({ type: CCInteger, min: 1 })
    count = 3000;

    @property
    radius = 20;

    private entities: Entity[] = [];

    start() {
        const world = defaultWorld();
        if (!world) return;
        if (!this.getComponent(EntityMeshRenderer)) this.addComponent(EntityMeshRenderer);
        if (!this.mesh && !boxMesh) boxMesh = utils.MeshUtils.createMesh(primitives.box({ width: 0.4, height: 0.4, length: 0.4 }));
        const mesh = this.mesh || boxMesh;
        const em = world.entityManager;
        this.entities = em.createEntities(this.count, LocalTransform, LocalToWorld, RenderMesh, Orbit);
        for (const e of this.entities) {
            const r = this.radius * Math.sqrt(Math.random());
            em.setComponent(e, Orbit, {
                radius: r,
                angle: Math.random() * Math.PI * 2,
                speed: (0.2 + Math.random() * 0.8) * (Math.random() < 0.5 ? -1 : 1) * (6 / (2 + r)),
                height: (Math.random() - 0.5) * 6,
                spin: 30 + Math.random() * 180,
            });
            em.setComponent(e, RenderMesh, {
                mesh,
                material: this.material,
                color: rgba(80 + Math.random() * 175, 80 + Math.random() * 175, 80 + Math.random() * 175),
            });
        }
        em.setName(this.entities[0], 'First Cube');
    }

    onDestroy() {
        const world = defaultWorld();
        if (world) world.entityManager.destroyEntity(this.entities.filter((e) => world.entityManager.exists(e)));
    }
}
