/**
 * Sample: thousands of sprites bouncing around, drawn by one
 * EntitySpriteRenderer (one draw call per texture). Put it on a node under a
 * Canvas, give it a Sprite Frame, press Play, and open Panel > ECS Entities.
 */
import { _decorator, CCInteger, Component, SpriteFrame, UITransform, view } from 'cc';
import {
    defaultWorld, EcsUIRenderer, EntitySpriteRenderer, LocalToWorld, LocalTransform, RenderSprite, SystemBase, component, f32, rgba, setAngle,
    system,
} from 'db://ecs/index';
import type { Entity } from 'db://ecs/index';

const { ccclass, property, menu } = _decorator;

@component('SwarmVelocity')
export class SwarmVelocity {
    @f32 x = 0;
    @f32 y = 0;
    /** Degrees per second. */
    @f32 spin = 0;
    @f32 angle = 0;
}

/** Singleton: the box the sprites bounce in (world units). */
@component('SwarmBounds')
export class SwarmBounds {
    @f32 minX = 0;
    @f32 minY = 0;
    @f32 maxX = 960;
    @f32 maxY = 640;
}

@system({ name: 'SwarmMoveSystem' })
export class SwarmMoveSystem extends SystemBase {
    private movers = this.query(LocalTransform, SwarmVelocity);

    protected onCreate(): void {
        this.requireForUpdate(SwarmBounds);
    }

    protected onUpdate(): void {
        const b = this.getSingleton(SwarmBounds);
        const minX = b.minX, minY = b.minY, maxX = b.maxX, maxY = b.maxY;
        const dt = this.time.deltaTime;
        for (const a of this.movers.archetypes) {
            const t = a.write(LocalTransform);
            const v = a.write(SwarmVelocity);
            for (let i = 0; i < a.count; i++) {
                let x = t.x[i] + v.x[i] * dt;
                let y = t.y[i] + v.y[i] * dt;
                if (x < minX || x > maxX) {
                    v.x[i] = -v.x[i];
                    x = Math.min(maxX, Math.max(minX, x));
                }
                if (y < minY || y > maxY) {
                    v.y[i] = -v.y[i];
                    y = Math.min(maxY, Math.max(minY, y));
                }
                t.x[i] = x;
                t.y[i] = y;
                const angle = (v.angle[i] += v.spin[i] * dt);
                const h = (angle * Math.PI) / 360;
                t.qz[i] = Math.sin(h);
                t.qw[i] = Math.cos(h);
            }
        }
    }
}

@ccclass('SpriteSwarmDemo')
@menu('ECS/Samples/SpriteSwarmDemo')
export class SpriteSwarmDemo extends Component {
    @property({ type: SpriteFrame, tooltip: 'What each entity shows.' })
    frame: SpriteFrame | null = null;

    @property({ type: CCInteger, min: 1, tooltip: 'Number of sprites.' })
    count = 5000;

    @property({ tooltip: 'Units per second.' })
    speed = 200;

    @property({ tooltip: 'Sprite size (0: the frame size).' })
    size = 32;

    private entities: Entity[] = [];

    start() {
        const world = defaultWorld();
        if (!world || !this.frame) {
            if (!this.frame) console.warn('[ECS] SpriteSwarmDemo: set a Sprite Frame.');
            return;
        }
        // The renderer draws relative to this node; in a Canvas it sorts with the UI.
        if (!this.getComponent(EntitySpriteRenderer)) this.addComponent(EntitySpriteRenderer);
        if (this.getComponent(UITransform) && !this.getComponent(EcsUIRenderer)) this.addComponent(EcsUIRenderer);

        const em = world.entityManager;
        const center = this.node.worldPosition;
        const size = view.getVisibleSize();
        em.setSingleton(SwarmBounds, {
            minX: center.x - size.width / 2,
            maxX: center.x + size.width / 2,
            minY: center.y - size.height / 2,
            maxY: center.y + size.height / 2,
        });
        this.entities = em.createEntities(this.count, LocalTransform, LocalToWorld, RenderSprite, SwarmVelocity);
        for (const e of this.entities) {
            const t = em.getComponent(e, LocalTransform);
            t.x = center.x + (Math.random() - 0.5) * size.width;
            t.y = center.y + (Math.random() - 0.5) * size.height;
            setAngle(t, Math.random() * 360);
            const a = Math.random() * Math.PI * 2;
            const s = this.speed * (0.5 + Math.random());
            em.setComponent(e, SwarmVelocity, { x: Math.cos(a) * s, y: Math.sin(a) * s, spin: (Math.random() - 0.5) * 360 });
            em.setComponent(e, RenderSprite, {
                frame: this.frame,
                width: this.size,
                height: this.size,
                color: rgba(155 + Math.random() * 100, 155 + Math.random() * 100, 155 + Math.random() * 100),
            });
        }
        em.setName(this.entities[0], 'First Sprite');
    }

    onDestroy() {
        const world = defaultWorld();
        if (world) world.entityManager.destroyEntity(this.entities.filter((e) => world.entityManager.exists(e)));
    }
}
