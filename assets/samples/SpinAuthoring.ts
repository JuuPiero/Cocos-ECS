/**
 * Sample (baking, part 1): the authoring workflow. Build the scene with
 * ordinary nodes and components; a SubScene turns them into entities when
 * the game runs.
 *
 *   Canvas
 *   └─ SubScene                 (Add Component > ECS > SubScene)
 *      ├─ Logo                  Sprite + SpinAuthoring
 *      └─ Spawner               SpawnerAuthoring (Prefab: a node with a Sprite,
 *                               optionally SpinAuthoring)
 *
 * The baker turns SpinAuthoring into the Spin component below; the Sprite
 * becomes a RenderSprite (built-in baker). Part 2: SpawnerAuthoring.ts.
 * (One Component class per script: Cocos requires it.)
 */
import { _decorator, Component } from 'cc';
import { Baker, LocalTransform, SystemBase, baker, component, f32, getAngle, setAngle, system } from 'db://ecs/index';

const { ccclass, property, menu } = _decorator;

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
