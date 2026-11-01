import assert from 'assert';
import {
    LateTransformSystem, LocalToWorld, LocalToWorldSystem, LocalTransform, Parent, PostTransformScale, TransformSystemGroup, World,
    getAngle, setAngle,
} from '../assets/core';
import { done, test } from './harness';

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

function world(): World {
    return World.createDefault('transforms', [TransformSystemGroup, LocalToWorldSystem, LateTransformSystem]);
}

async function main() {
    await test('roots: translation, rotation and scale', () => {
        const w = world();
        const em = w.entityManager;
        const e = em.createEntity(LocalTransform, LocalToWorld);
        const t = em.getComponent(e, LocalTransform);
        t.x = 10;
        t.y = 5;
        setAngle(t, 90);
        t.scale = 2;
        assert.ok(near(getAngle(t), 90));
        w.update(0.016);
        const m = em.getComponent(e, LocalToWorld);
        assert.ok(near(m.m12, 10) && near(m.m13, 5));
        // X axis rotated 90° and scaled by 2: (0, 2).
        assert.ok(near(m.m00, 0) && near(m.m01, 2), `${m.m00} ${m.m01}`);
        w.dispose();
    });

    await test('children follow their parents (any depth, any creation order)', () => {
        const w = world();
        const em = w.entityManager;
        const grandchild = em.createEntity(LocalTransform, LocalToWorld, Parent);
        const child = em.createEntity(LocalTransform, LocalToWorld, Parent);
        const root = em.createEntity(LocalTransform, LocalToWorld);
        em.getComponent(child, Parent).value = root;
        em.getComponent(grandchild, Parent).value = child;
        em.getComponent(root, LocalTransform).x = 100;
        setAngle(em.getComponent(root, LocalTransform), 90);
        em.getComponent(child, LocalTransform).x = 10;
        em.getComponent(grandchild, LocalTransform).y = 1;
        w.update(0.016);
        const c = em.getComponent(child, LocalToWorld);
        assert.ok(near(c.m12, 100) && near(c.m13, 10), `child at ${c.m12}, ${c.m13}`);
        const g = em.getComponent(grandchild, LocalToWorld);
        assert.ok(near(g.m12, 99) && near(g.m13, 10), `grandchild at ${g.m12}, ${g.m13}`);
        w.dispose();
    });

    await test('non-uniform scale', () => {
        const w = world();
        const em = w.entityManager;
        const e = em.createEntity(LocalTransform, LocalToWorld, PostTransformScale);
        em.setComponent(e, PostTransformScale, { x: 2, y: 3 });
        w.update(0.016);
        const m = em.getComponent(e, LocalToWorld);
        assert.ok(near(m.m00, 2) && near(m.m05, 3) && near(m.m10, 1));
        w.dispose();
    });

    await test('moves made after the simulation are picked up before presentation', () => {
        const w = world();
        const em = w.entityManager;
        const e = em.createEntity(LocalTransform, LocalToWorld);
        w.beginFrame(0.016);
        w.initialization.update();
        w.simulation.update();
        // A Cocos script's update() moving the entity:
        em.getComponent(e, LocalTransform).x = 42;
        w.presentation.update();
        assert.ok(near(em.getComponent(e, LocalToWorld).m12, 42));
        // Nothing changed: LateTransformSystem doesn't recompute.
        const l2w = w.getSystem(LocalToWorldSystem)!;
        w.beginFrame(0.016);
        w.simulation.update();
        const v = l2w.lastSystemVersion;
        w.presentation.update();
        assert.strictEqual(l2w.lastSystemVersion, v);
        w.dispose();
    });

    done();
}

main();
