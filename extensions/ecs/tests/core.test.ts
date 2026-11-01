import assert from 'assert';
import {
    Disabled, EndSimulationEntityCommandBufferSystem, EntityCommandBuffer, EntityManager, FixedStepSimulationSystemGroup,
    LinkedEntityGroup, Prefab, SimulationSystemGroup, SystemBase, World, bool, component, disableAutoCreation, entity,
    entityIndex, entityVersion, f64, i32, ref, system, u8,
} from '../assets/core';
import { done, test } from './harness';

@component('Position')
class Position {
    x = 0;
    y = 0;
}

@component('Velocity')
class Velocity {
    x = 1;
    y = 2;
}

@component('Health')
class Health {
    @i32 value = 100;
    @bool dead = false;
}

@component('Enemy')
class Enemy {}

@component('Frozen')
class Frozen {}

@component('Target')
class Target {
    @entity who = 0;
}

@component('Bag')
class Bag {
    @ref items: string[] = [];
    @u8 slots = 4;
    @f64 money = 0.1;
}

async function main() {
    await test('entities get default values; views read and write the columns', () => {
        const em = new EntityManager();
        const e = em.createEntity(Position, Velocity);
        assert.ok(em.exists(e));
        const v = em.getComponent(e, Velocity);
        assert.deepStrictEqual([v.x, v.y], [1, 2]);
        const p = em.getComponent(e, Position);
        p.x = 5;
        assert.strictEqual(em.getComponent(e, Position).x, 5);
        assert.deepStrictEqual({ ...em.getComponentData(e, Position) }, { x: 5, y: 0 });
        const h = em.getComponent(em.createEntity(Health), Health);
        assert.strictEqual(h.dead, false);
        h.dead = true;
        assert.strictEqual(h.dead, true);
        assert.strictEqual(JSON.stringify(p), '{"x":5,"y":0}');
    });

    await test('adding / removing components moves entities and keeps their data', () => {
        const em = new EntityManager();
        const a = em.createEntity(Position);
        const b = em.createEntity(Position);
        em.getComponent(a, Position).x = 1;
        em.getComponent(b, Position).x = 2;
        em.addComponent(a, Velocity, { x: 9 });
        assert.ok(em.hasComponent(a, Velocity));
        assert.strictEqual(em.getComponent(a, Position).x, 1);
        assert.strictEqual(em.getComponent(a, Velocity).x, 9);
        assert.strictEqual(em.getComponent(a, Velocity).y, 2, 'default for unspecified fields');
        assert.strictEqual(em.getComponent(b, Position).x, 2, 'swap-removed neighbour still right');
        em.removeComponent(a, Velocity);
        assert.ok(!em.hasComponent(a, Velocity));
        assert.strictEqual(em.getComponent(a, Position).x, 1);
        em.setComponent(a, Enemy, {});
        assert.ok(em.hasComponent(a, Enemy));
    });

    await test('destroyed entities stop existing; indices are reused with a new version', () => {
        const em = new EntityManager();
        const a = em.createEntity(Position);
        em.destroyEntity(a);
        assert.ok(!em.exists(a));
        const b = em.createEntity(Position);
        assert.strictEqual(entityIndex(b), entityIndex(a));
        assert.notStrictEqual(entityVersion(b), entityVersion(a));
        assert.ok(!em.exists(a) && em.exists(b));
        assert.strictEqual(em.entityCount, 1);
        assert.throws(() => em.getComponent(a, Position));
    });

    await test('queries: all / any / none; disabled and prefab entities are skipped', () => {
        const em = new EntityManager();
        const moving = em.createEntities(3, Position, Velocity);
        em.createEntities(2, Position);
        const frozen = em.createEntity(Position, Velocity, Frozen);
        const disabled = em.createEntity(Position, Velocity);
        em.setEnabled(disabled, false);
        const prefab = em.createEntity(Position, Velocity, Prefab);
        const q = em.createQuery({ all: [Position, Velocity], none: [Frozen] });
        assert.strictEqual(q.count(), 3);
        assert.deepStrictEqual(q.toEntityArray().sort(), [...moving].sort());
        assert.strictEqual(em.createQuery({ all: [Position], any: [Frozen, Enemy] }).count(), 1);
        assert.strictEqual(em.createQuery({ all: [Position], includeDisabled: true, includePrefab: true }).count(), 8);
        assert.strictEqual(em.createQuery({ all: [Disabled] }).count(), 1, 'asking for Disabled includes it');
        assert.ok(em.exists(frozen) && em.exists(prefab));
        // Archetypes created after the query are picked up.
        em.createEntity(Position, Velocity, Enemy);
        assert.strictEqual(q.count(), 4);
    });

    await test('forEach gives live views; archetype columns allow tight loops', () => {
        const em = new EntityManager();
        em.createEntities(5, Position, Velocity);
        em.createEntities(5, Position, Velocity, Enemy);
        const q = em.query(Position, Velocity);
        q.forEach((e, p, v) => {
            p.x += v.x * 2;
        });
        for (const a of q.archetypes) {
            const p = a.write(Position);
            const v = a.get(Velocity);
            for (let i = 0; i < a.count; i++) p.y[i] += v.y[i];
        }
        let ok = 0;
        q.forEach((e, p) => {
            if (p.x === 2 && p.y === 2) ok++;
        });
        assert.strictEqual(ok, 10);
    });

    await test('structural changes inside forEach throw; a command buffer defers them', () => {
        const em = new EntityManager();
        const es = em.createEntities(4, Health);
        em.getComponent(es[1], Health).value = 0;
        em.getComponent(es[3], Health).value = 0;
        const q = em.query(Health);
        assert.throws(() => q.forEach((e) => em.destroyEntity(e)), /command ?buffer/i);
        const ecb = new EntityCommandBuffer();
        q.forEach((e, h) => {
            if (h.value <= 0) ecb.destroyEntity(e);
        });
        ecb.playback(em);
        assert.strictEqual(em.entityCount, 2);
        assert.ok(em.exists(es[0]) && !em.exists(es[1]));
    });

    await test('command buffer: created entities get real handles, also in entity fields', () => {
        const em = new EntityManager();
        const ecb = new EntityCommandBuffer();
        const enemy = ecb.createEntity(Enemy, Health);
        ecb.setComponent(enemy, Health, { value: 7 });
        const hunter = ecb.createEntity(Target);
        ecb.setComponent(hunter, Target, { who: enemy });
        ecb.setName(hunter, 'Hunter');
        ecb.playback(em);
        assert.strictEqual(em.entityCount, 2);
        const h = em.createQuery({ all: [Target] }).getSingletonEntity();
        const target = em.getComponent(h, Target).who;
        assert.ok(em.exists(target), 'remapped to the created entity');
        assert.strictEqual(em.getComponent(target, Health).value, 7);
        assert.strictEqual(em.getName(h), 'Hunter');
        assert.ok(ecb.isEmpty);
    });

    await test('instantiate copies components; prefabs lose the tag; groups remap entity fields', () => {
        const em = new EntityManager();
        const root = em.createEntity(Position, Prefab, LinkedEntityGroup);
        const child = em.createEntity(Position, Target, Prefab);
        em.getComponent(child, Target).who = root;
        em.getComponent(root, Position).x = 3;
        em.getComponent(root, LinkedEntityGroup).entities = [root, child];
        em.setName(root, 'Soldier');
        const copies = em.instantiate(root, 3);
        assert.strictEqual(copies.length, 3);
        for (const c of copies) {
            assert.ok(!em.hasComponent(c, Prefab));
            assert.strictEqual(em.getComponent(c, Position).x, 3);
            assert.strictEqual(em.getName(c), 'Soldier');
            const group = em.getComponent(c, LinkedEntityGroup).entities;
            assert.strictEqual(group[0], c);
            assert.notStrictEqual(group[1], child);
            assert.strictEqual(em.getComponent(group[1], Target).who, c, 'child points at its own root');
        }
        assert.strictEqual(em.createQuery({ all: [Position] }).count(), 6, 'prefabs not counted');
        const [first] = copies;
        const firstChild = em.getComponent(first, LinkedEntityGroup).entities[1];
        em.destroyEntity(first);
        assert.ok(!em.exists(firstChild), 'destroying the root destroys its group');
        assert.ok(em.exists(child) && em.exists(copies[1]), 'other groups stay');
        const plain = em.instantiate(em.createEntity(Bag));
        assert.deepStrictEqual(em.getComponent(plain, Bag).items, []);
        assert.strictEqual(em.getComponent(plain, Bag).money, 0.1);
    });

    await test('singletons', () => {
        const em = new EntityManager();
        em.setSingleton(Health, { value: 3 });
        em.setSingleton(Health, { value: 4 });
        assert.strictEqual(em.getSingleton(Health).value, 4);
        assert.ok(em.hasSingleton(Health));
        em.createEntity(Health);
        assert.throws(() => em.getSingleton(Health));
    });

    // ------------------------------------------------------------- systems

    const log: string[] = [];

    @disableAutoCreation
    @system({ name: 'A' })
    class A extends SystemBase {
        onUpdate() {
            log.push('A');
        }
    }

    @disableAutoCreation
    @system({ name: 'B', updateBefore: [A] })
    class B extends SystemBase {
        onUpdate() {
            log.push('B');
        }
    }

    @disableAutoCreation
    @system({ name: 'C', updateAfter: [A], orderFirst: true })
    class C extends SystemBase {
        onUpdate() {
            log.push('C');
        }
    }

    @disableAutoCreation
    @system({ name: 'Mover' })
    class Mover extends SystemBase {
        movers = this.query(Position, Velocity);
        starts = 0;
        stops = 0;
        changedSeen = 0;
        onCreate() {
            this.requireForUpdate(this.movers);
        }
        onStartRunning() {
            this.starts++;
        }
        onStopRunning() {
            this.stops++;
        }
        onUpdate() {
            const dt = this.time.deltaTime;
            for (const a of this.movers.archetypes) {
                const p = a.write(Position);
                const v = a.get(Velocity);
                for (let i = 0; i < a.count; i++) {
                    p.x[i] += v.x[i] * dt;
                    p.y[i] += v.y[i] * dt;
                }
            }
        }
    }

    @disableAutoCreation
    @system({ name: 'Watcher', updateAfter: [Mover] })
    class Watcher extends SystemBase {
        changed = this.getQuery({ all: [Health] }).setChangeFilter(Health);
        seen = 0;
        onUpdate() {
            this.seen = this.changed.archetypes.length;
        }
    }

    @disableAutoCreation
    @system({ name: 'Fixed', group: FixedStepSimulationSystemGroup })
    class Fixed extends SystemBase {
        steps = 0;
        dts: number[] = [];
        onUpdate() {
            this.steps++;
            this.dts.push(this.time.deltaTime);
        }
    }

    @disableAutoCreation
    @system({ name: 'Reaper' })
    class Reaper extends SystemBase {
        q = this.query(Health);
        onUpdate() {
            const ecb = this.commandBuffer(EndSimulationEntityCommandBufferSystem);
            this.q.forEach((e, h) => {
                if (h.value <= 0) ecb.destroyEntity(e);
            });
        }
    }

    await test('system order: updateBefore / updateAfter / orderFirst', () => {
        const w = World.createDefault('order', [A, B, C]);
        log.length = 0;
        w.update(1 / 60);
        assert.deepStrictEqual(log, ['B', 'A', 'C']);
        const sim = w.simulation.systems.map((s) => s.name);
        assert.strictEqual(sim[0], 'BeginSimulationEntityCommandBufferSystem');
        assert.strictEqual(sim[1], 'FixedStepSimulationSystemGroup');
        assert.strictEqual(sim[sim.length - 1], 'EndSimulationEntityCommandBufferSystem');
        w.dispose();
    });

    await test('systems move entities, requireForUpdate starts / stops them', () => {
        const w = World.createDefault('move', [Mover]);
        const mover = w.getSystem(Mover)!;
        w.update(0.5);
        assert.strictEqual(mover.starts, 0, 'no entities yet');
        const e = w.entityManager.createEntity(Position, Velocity);
        w.update(0.5);
        w.update(0.5);
        assert.strictEqual(mover.starts, 1);
        const p = w.entityManager.getComponent(e, Position);
        assert.deepStrictEqual([p.x, p.y], [1, 2]);
        w.entityManager.destroyEntity(e);
        w.update(0.5);
        assert.strictEqual(mover.stops, 1);
        mover.enabled = false;
        assert.ok(mover.avgMs >= 0);
        w.dispose();
        assert.ok(!World.all.includes(w));
    });

    await test('change filter sees columns written since the last update', () => {
        const w = World.createDefault('changes', [Watcher]);
        const em = w.entityManager;
        const e = em.createEntity(Health);
        const watcher = w.getSystem(Watcher)!;
        w.update(0.1);
        assert.strictEqual(watcher.seen, 1, 'new entities count as changed');
        w.update(0.1);
        assert.strictEqual(watcher.seen, 0, 'nothing written');
        em.getComponent(e, Health).value = 5;
        w.update(0.1);
        assert.strictEqual(watcher.seen, 1, 'written through a view');
        w.dispose();
    });

    await test('fixed step group runs at its own rate', () => {
        const w = World.createDefault('fixed', [Fixed]);
        const f = w.getSystem(Fixed)!;
        w.update(0.05); // 3 steps of 1/60
        assert.strictEqual(f.steps, 3);
        assert.ok(f.dts.every((d) => Math.abs(d - 1 / 60) < 1e-9));
        assert.ok(Math.abs(w.time.deltaTime - 0.05) < 1e-9, 'frame dt restored');
        w.update(1); // capped at maxSteps
        assert.strictEqual(f.steps, 3 + 4);
        w.dispose();
    });

    await test('command buffer systems play back at their point of the frame', () => {
        const w = World.createDefault('reaper', [Reaper]);
        const em = w.entityManager;
        em.createEntities(3, Health);
        const dead = em.createEntity(Health);
        em.getComponent(dead, Health).value = 0;
        w.update(0.1);
        assert.ok(!em.exists(dead));
        assert.strictEqual(em.entityCount, 3);
        w.dispose();
    });

    await test('time scale', () => {
        const w = new World('t');
        w.time.timeScale = 0.5;
        w.update(0.2);
        assert.ok(Math.abs(w.time.deltaTime - 0.1) < 1e-9);
        assert.strictEqual(w.time.frameCount, 1);
        w.dispose();
    });

    done();
}

main();
