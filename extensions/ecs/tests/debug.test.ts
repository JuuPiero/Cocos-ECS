// The agent only needs director.on from 'cc' (frame counter): a stand-in, loaded first.
import './stubs/fake-cc';
import assert from 'assert';
import { SystemBase, World, component, entity, f32, ref, system, disableAutoCreation } from '../assets/core';
import { debugAnswer } from '../assets/debug/agent';
import { DebugServer } from '../source/debug-server';
import { done, test } from './harness';

@component('DPos')
class DPos {
    @f32 x = 1;
    @f32 y = 2;
}

@component('DTarget')
class DTarget {
    @entity who = 0;
    @ref sprite: any = null;
    @ref tags: string[] = [];
}

@component('DTag')
class DTag {}

@disableAutoCreation
@system({ name: 'DMove' })
class DMove extends SystemBase {
    q = this.query(DPos);
    onUpdate() {
        this.q.forEach((e, p) => {
            p.x += 1;
        });
    }
}

async function main() {
    const w = World.createDefault('Debug World', [DMove]);
    World.defaultWorld = w;
    const em = w.entityManager;
    const a = em.createEntity(DPos);
    em.setName(a, 'Hero');
    const b = em.createEntity(DPos, DTarget, DTag);
    em.setName(b, 'Hunter');
    em.setComponent(b, DTarget, { who: a, sprite: { _uuid: 'abc', name: 'hero-frame', constructor: { name: 'SpriteFrame' } }, tags: ['x', 'y'] });
    em.createEntities(5, DPos);
    w.update(1 / 60);

    await test('overview: worlds, system tree with timings and counts, archetypes', () => {
        const o = debugAnswer({ what: 'overview' });
        assert.strictEqual(o.world, 'Debug World');
        assert.strictEqual(o.entityCount, 7);
        const sim = o.systems.find((s: any) => s.name === 'SimulationSystemGroup');
        assert.ok(sim && sim.group);
        const move = sim.children.find((s: any) => s.name === 'DMove');
        assert.ok(move, 'DMove listed under Simulation');
        assert.strictEqual(move.entities, 7);
        assert.ok(move.running);
        assert.ok(o.archetypes.some((x: any) => x.types.includes('DTarget') && x.count === 1));
    });

    await test('entity list: name search and component filter, paged', () => {
        const all = debugAnswer({ what: 'entities', params: {} });
        assert.strictEqual(all.total, 7);
        const hunter = debugAnswer({ what: 'entities', params: { text: 'hun' } });
        assert.deepStrictEqual(hunter.items.map((i: any) => i.name), ['Hunter']);
        const tagged = debugAnswer({ what: 'entities', params: { components: ['DTag'] } });
        assert.strictEqual(tagged.total, 1);
        const page = debugAnswer({ what: 'entities', params: { limit: 3, offset: 2 } });
        assert.strictEqual(page.items.length, 3);
        assert.strictEqual(page.total, 7);
    });

    await test('entity details: fields, entity names, summarized references', () => {
        const d = debugAnswer({ what: 'entity', params: { e: b } });
        assert.strictEqual(d.name, 'Hunter');
        const target = d.components.find((c: any) => c.name === 'DTarget');
        const who = target.fields.find((f: any) => f.name === 'who');
        assert.strictEqual(who.value, a);
        assert.strictEqual(who.entityName, 'Hero');
        const sprite = target.fields.find((f: any) => f.name === 'sprite');
        assert.strictEqual(sprite.value.kind, 'asset');
        assert.strictEqual(sprite.value.name, 'hero-frame');
        const tags = target.fields.find((f: any) => f.name === 'tags');
        assert.deepStrictEqual([tags.value.kind, tags.value.length], ['array', 2]);
        assert.ok(d.components.find((c: any) => c.name === 'DTag').tag);
        assert.strictEqual(debugAnswer({ what: 'entity', params: { e: 123456 } }), null);
    });

    await test('commands: edit a field, toggle a system, disable / destroy an entity, time scale', () => {
        assert.ok(debugAnswer({ what: 'command', params: { op: 'setField', e: a, component: 'DPos', field: 'y', value: '42' } }).ok);
        assert.strictEqual(em.getComponent(a, DPos).y, 42);
        assert.strictEqual(debugAnswer({ what: 'command', params: { op: 'setField', e: b, component: 'DTarget', field: 'tags', value: 1 } }).ok, false);
        const id = w.systemList.indexOf(w.getSystem(DMove)!);
        debugAnswer({ what: 'command', params: { op: 'setSystemEnabled', id, enabled: false } });
        const x = em.getComponent(a, DPos).x;
        w.update(1 / 60);
        assert.strictEqual(em.getComponent(a, DPos).x, x, 'disabled system does nothing');
        debugAnswer({ what: 'command', params: { op: 'setEnabled', e: a, enabled: false } });
        assert.ok(!em.isEnabled(a));
        debugAnswer({ what: 'command', params: { op: 'destroy', e: b } });
        assert.ok(!em.exists(b));
        debugAnswer({ what: 'command', params: { op: 'timeScale', value: 0 } });
        assert.strictEqual(w.time.timeScale, 0);
    });

    await test('debug server: a game connects, the editor asks, the game answers', async () => {
        const changes: number[] = [];
        const server = new DebugServer(() => changes.push(server.list().length));
        await server.start(false);
        assert.ok(server.running, server.error);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { WebSocket } = require('ws');
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ecs`);
        await new Promise((r) => ws.once('open', r));
        ws.send(JSON.stringify({ type: 'hello', runtime: 'Test Game', url: 'http://localhost:7456/' }));
        ws.on('message', (raw: any) => {
            const req = JSON.parse(String(raw));
            ws.send(JSON.stringify({ type: 'reply', id: req.id, data: debugAnswer(req) }));
        });
        for (let i = 0; i < 50 && !server.list().length; i++) await new Promise((r) => setTimeout(r, 10));
        const [client] = server.list();
        assert.strictEqual(client.runtime, 'Test Game');
        const o = await server.request(client.id, 'overview', {});
        assert.strictEqual(o.world, 'Debug World');
        ws.close();
        for (let i = 0; i < 50 && server.list().length; i++) await new Promise((r) => setTimeout(r, 10));
        assert.strictEqual(server.list().length, 0);
        assert.strictEqual(await server.request(client.id, 'overview', {}), null, 'gone clients answer null');
        await server.stop();
        assert.ok(changes.length >= 2);
    });

    w.dispose();
    done();
}

main();
