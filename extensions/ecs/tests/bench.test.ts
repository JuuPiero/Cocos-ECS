/**
 * Rough numbers for the core in node (not a pass / fail test): how long a
 * frame of simple systems takes for many entities.
 */
import { EntityCommandBuffer, EntityManager, component, f32 } from '../assets/core';
import { done, test } from './harness';

@component('BPos')
class BPos {
    @f32 x = 0;
    @f32 y = 0;
}

@component('BVel')
class BVel {
    @f32 x = 1;
    @f32 y = 1;
}

@component('BLife')
class BLife {
    @f32 t = 1;
}

function time(label: string, runs: number, fn: () => void): number {
    fn();
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) fn();
    const ms = (performance.now() - t0) / runs;
    console.log(`       ${label}: ${ms.toFixed(3)} ms`);
    return ms;
}

async function main() {
    await test('benchmark', () => {
        const N = 100_000;
        const em = new EntityManager();
        let t0 = performance.now();
        em.createEntities(N, BPos, BVel, BLife);
        console.log(`       create ${N}: ${(performance.now() - t0).toFixed(1)} ms`);
        const q = em.query(BPos, BVel);
        time(`move ${N} (columns)`, 30, () => {
            for (const a of q.archetypes) {
                const p = a.write(BPos);
                const v = a.get(BVel);
                const n = a.count;
                const px = p.x, py = p.y, vx = v.x, vy = v.y;
                for (let i = 0; i < n; i++) {
                    px[i] += vx[i] * 0.016;
                    py[i] += vy[i] * 0.016;
                }
            }
        });
        time(`move ${N} (forEach views)`, 10, () => {
            q.forEach((e, p, v) => {
                p.x += v.x * 0.016;
                p.y += v.y * 0.016;
            });
        });
        const ql = em.query(BLife);
        t0 = performance.now();
        const ecb = new EntityCommandBuffer();
        let i = 0;
        ql.forEach((e) => {
            if (i++ % 10 === 0) ecb.destroyEntity(e);
        });
        ecb.playback(em);
        console.log(`       destroy ${N / 10} via command buffer: ${(performance.now() - t0).toFixed(1)} ms`);
        t0 = performance.now();
        const some = q.toEntityArray().slice(0, 10_000);
        for (const e of some) em.removeComponent(e, BVel);
        console.log(`       remove a component from 10000 (archetype moves): ${(performance.now() - t0).toFixed(1)} ms`);
    });
    done();
}

main();
