/**
 * Sample: the authoring workflow. Build the scene with ordinary nodes and
 * components; a SubScene turns them into entities when the game runs.
 *
 *   Canvas
 *   └─ SubScene                 (Add Component > ECS > SubScene)
 *      ├─ Logo                  Sprite + SpinAuthoring
 *      └─ Spawner               SpawnerAuthoring (Prefab: a node with a Sprite,
 *                               optionally SpinAuthoring)
 *
 * Bakers turn SpinAuthoring / SpawnerAuthoring into the Spin / Spawner
 * components below; the Sprite becomes a RenderSprite (built-in baker).
 */
import { _decorator, CCInteger, Component, Prefab } from 'cc';
import {
    Baker, EndSimulationEntityCommandBufferSystem, LocalToWorld, LocalTransform, SystemBase, baker, component, entity, f32, getAngle,
    i32, setAngle, system,
} from 'db://ecs/index';

const { ccclass, property, menu } = _decorator;

// ------------------------------------------------------------------ spinning

@component('Spin')
export class Spin {
    /** Degrees per second. */
    @f32 speed = 90;
}

@ccclass('SpinAuthoring')
@menu('ECS/Samples/SpinAuthoring')
export class SpinAuthoring extends Component {
    @property({ tooltip: 'Degrees per second.' })
    speed = 90;
}

@baker(SpinAuthoring)
export class SpinBaker extends Baker<SpinAuthoring> {
    bake(a: SpinAuthoring) {
        this.addComponent(Spin, { speed: a.speed });
    }
}

@system({ name: 'SpinSystem' })
export class SpinSystem extends SystemBase {
    private q = this.query(LocalTransform, Spin);

    protected onUpdate(): void {
        const dt = this.time.deltaTime;
        this.q.forEach((e, t, s) => setAngle(t, getAngle(t) + s.speed * dt));
    }
}

// ------------------------------------------------------------------ spawning

@component('Spawner')
export class Spawner {
    /** The entity prefab to instantiate (baked from a Prefab asset). */
    @entity prefab = 0;
    @f32 interval = 0.1;
    @i32 perSpawn = 5;
    @f32 speed = 150;
    @f32 lifetime = 3;
    @f32 timer = 0;
}

/** Spawned entities: drift away, then disappear. */
@component('Drift')
export class Drift {
    @f32 x = 0;
    @f32 y = 0;
    @f32 secondsLeft = 3;
}

@ccclass('SpawnerAuthoring')
@menu('ECS/Samples/SpawnerAuthoring')
export class SpawnerAuthoring extends Component {
    @property({ type: Prefab, tooltip: 'Baked once into an entity prefab, then instantiated without nodes.' })
    prefab: Prefab | null = null;

    @property({ tooltip: 'Seconds between spawns.' })
    interval = 0.1;

    @property({ type: CCInteger, min: 1 })
    perSpawn = 5;

    @property
    speed = 150;

    @property({ tooltip: 'Seconds before a spawned entity is destroyed.' })
    lifetime = 3;
}

@baker(SpawnerAuthoring)
export class SpawnerBaker extends Baker<SpawnerAuthoring> {
    bake(a: SpawnerAuthoring) {
        this.addComponent(Spawner, {
            prefab: this.getEntity(a.prefab),
            interval: a.interval,
            perSpawn: a.perSpawn,
            speed: a.speed,
            lifetime: a.lifetime,
        });
    }
}

@system({ name: 'SpawnerSystem' })
export class SpawnerSystem extends SystemBase {
    private q = this.query(Spawner, LocalToWorld);

    protected onUpdate(): void {
        // Structural changes can't happen inside forEach: record them, they play back at the end of the simulation.
        const ecb = this.commandBuffer(EndSimulationEntityCommandBufferSystem);
        const dt = this.time.deltaTime;
        this.q.forEach((e, s, ltw) => {
            if (!s.prefab) return;
            s.timer -= dt;
            while (s.timer <= 0) {
                s.timer += Math.max(0.01, s.interval);
                for (let k = 0; k < s.perSpawn; k++) {
                    const a = Math.random() * Math.PI * 2;
                    const v = s.speed * (0.5 + Math.random() * 0.5);
                    const copy = ecb.instantiate(s.prefab);
                    ecb.setComponent(copy, LocalTransform, { x: ltw.m12, y: ltw.m13, z: ltw.m14 });
                    ecb.addComponent(copy, Drift, { x: Math.cos(a) * v, y: Math.sin(a) * v, secondsLeft: s.lifetime });
                }
            }
        });
    }
}

@system({ name: 'DriftSystem' })
export class DriftSystem extends SystemBase {
    private q = this.query(LocalTransform, Drift);

    protected onUpdate(): void {
        const ecb = this.commandBuffer(EndSimulationEntityCommandBufferSystem);
        const dt = this.time.deltaTime;
        this.q.forEach((e, t, d) => {
            t.x += d.x * dt;
            t.y += d.y * dt;
            d.secondsLeft -= dt;
            if (d.secondsLeft <= 0) ecb.destroyEntity(e);
        });
    }
}
