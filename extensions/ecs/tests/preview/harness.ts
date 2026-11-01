/**
 * The Entities window against a real world in the page (movers, a spawner,
 * lifetimes, tags and references). With #interact it clicks through the
 * window and writes the results into #result.
 */
import {
    EndSimulationEntityCommandBufferSystem, LocalToWorld, LocalTransform, SystemBase, World, component, entity, f32, ref, system,
} from '../../assets/core';
import { debugAnswer } from '../../assets/debug/agent';
import { createEntitiesApp } from '../../source/panels/default/app';
import type { DebugBridge } from '../../source/panels/default/bridge';

@component('Velocity')
class Velocity {
    @f32 x = 0;
    @f32 y = 0;
}

@component('Lifetime')
class Lifetime {
    @f32 seconds = 3;
}

@component('Enemy')
class Enemy {}

@component('Target')
class Target {
    @entity who = 0;
    @ref sprite: any = null;
}

@system({ name: 'MoveSystem' })
class MoveSystem extends SystemBase {
    q = this.query(LocalTransform, Velocity);
    onUpdate() {
        const dt = this.time.deltaTime;
        for (const a of this.q.archetypes) {
            const t = a.write(LocalTransform);
            const v = a.get(Velocity);
            for (let i = 0; i < a.count; i++) {
                t.x[i] += v.x[i] * dt;
                t.y[i] += v.y[i] * dt;
            }
        }
    }
}

@system({ name: 'LifetimeSystem', updateAfter: [MoveSystem] })
class LifetimeSystem extends SystemBase {
    q = this.query(Lifetime);
    onUpdate() {
        const ecb = this.commandBuffer(EndSimulationEntityCommandBufferSystem);
        const dt = this.time.deltaTime;
        this.q.forEach((e, l) => {
            l.seconds -= dt;
            if (l.seconds <= 0) ecb.destroyEntity(e);
        });
    }
}

@system({ name: 'SpawnSystem', updateBefore: [MoveSystem] })
class SpawnSystem extends SystemBase {
    acc = 0;
    onUpdate() {
        this.acc += this.time.deltaTime;
        const em = this.entityManager;
        while (this.acc > 0.02) {
            this.acc -= 0.02;
            const e = em.createEntity(LocalTransform, LocalToWorld, Velocity, Lifetime);
            em.setComponent(e, Velocity, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 });
            em.setName(e, 'Bullet');
        }
    }
}

const world = World.createDefault('Default World');
World.defaultWorld = world;
const em = world.entityManager;
const hero = em.createEntity(LocalTransform, LocalToWorld);
em.setName(hero, 'Hero');
for (let i = 0; i < 2000; i++) {
    const e = em.createEntity(LocalTransform, LocalToWorld, Velocity, Enemy, Target);
    em.setComponent(e, Velocity, { x: Math.random() * 20 - 10, y: Math.random() * 20 - 10 });
    em.setComponent(e, Target, { who: hero, sprite: { _uuid: 'f9941', name: 'enemy', constructor: { name: 'SpriteFrame' } } });
    em.setName(e, `Enemy ${i}`);
}
let last = performance.now();
function frame(t: number) {
    world.update(Math.min(0.1, (t - last) / 1000));
    last = t;
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

const bridge: DebugBridge = {
    status: async () => ({ clients: [{ id: 1, runtime: 'Preview', url: 'http://localhost:7456/', agent: '', since: 0 }], port: 7461, host: '127.0.0.1', error: '', running: true }),
    request: async (_id, what, params) => debugAnswer({ what, params }),
    onClients: () => () => undefined,
    setLan: async () => ({ clients: [], port: 7461, host: '0.0.0.0', error: '', running: true }),
    loadSettings: async () => null,
    saveSettings: () => undefined,
};

const ui = createEntitiesApp(document.getElementById('app')!, bridge);
(window as any).ui = ui;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $$ = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];

async function run() {
    const lines: string[] = [];
    const check = (name: string, ok: boolean, detail = '') => lines.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
    try {
        await wait(800);
        const { vm } = (ui as any).debug();
        check('connected to the game', vm.clientId === 1 && !!vm.overview);
        const rows = $$('.ec-row').map((r) => r.textContent || '');
        check('systems tab lists the groups and user systems', rows.some((t) => t.includes('SimulationSystemGroup')) && rows.some((t) => t.includes('MoveSystem')));
        const move = vm.systemRows.find((r: any) => r.name === 'MoveSystem');
        check('system shows entities and time', !!move && move.entities >= 2000 && move.ms >= 0, `${move?.entities} entities, ${move?.ms} ms`);
        const row = $$('.ec-row').find((r) => r.textContent?.includes('MoveSystem'))!;
        (row.querySelector('input[type=checkbox]') as HTMLInputElement).click();
        await wait(300);
        check('checkbox disables the system', !world.getSystem(MoveSystem)!.enabled);
        (row.querySelector('input[type=checkbox]') as HTMLInputElement).click();
        await wait(300);
        check('and enables it again', world.getSystem(MoveSystem)!.enabled);

        $$('.ec-tab').find((t) => t.textContent === 'Entities')!.click();
        await wait(200);
        vm.search = 'c:Enemy 12';
        vm.searchChanged();
        await wait(400);
        // Text matches the name or the Entity(index:version) text.
        const matches = (i: any) => i.name.includes('12') || vm.entityText(i.e).includes('12');
        check('search "c:Enemy 12" filters by component and name', vm.entityList.total > 0 && vm.entityList.items.every(matches)
            && vm.entityList.items.every((i: any) => i.name.startsWith('Enemy')), `${vm.entityList.total} found`);
        $$('.ec-item')[0].click();
        await wait(500);
        check('inspector shows the components', !!vm.detail && vm.detail.components.some((c: any) => c.name === 'Velocity'), vm.detail?.name);
        const refText = $$('.ec-ref').map((r) => r.textContent || '').join(' | ');
        check('references and entity links are readable', refText.includes('SpriteFrame "enemy"') && refText.includes('Hero'), refText);
        const field = $$('.ec-field').find((f) => f.querySelector('.ec-field-name')?.textContent === 'X' && f.closest('.ec-comp')?.textContent?.includes('Velocity'));
        const input = field?.querySelector('input') as HTMLInputElement;
        input.value = '123';
        input.dispatchEvent(new Event('change'));
        await wait(300);
        check('editing a field changes the entity', em.getComponent(vm.selected, Velocity).x === 123);
        $$('.ec-ref a')[0]?.click();
        await wait(500);
        check('clicking an entity reference selects it', vm.detail?.name === 'Hero', vm.detail?.name);
        // Back to an enemy for the screenshot.
        $$('.ec-item')[1]?.click();
        await wait(400);

        $$('.ec-tab').find((t) => t.textContent === 'Archetypes')!.click();
        await wait(600);
        const chips = $$('.ec-chip').map((c) => c.textContent);
        check('archetypes list their components', chips.includes('Enemy') && chips.includes('Lifetime'), `${vm.archetypes.length} archetypes`);
        ($$('.ec-btn').find((b) => b.textContent === 'Pause') as HTMLElement).click();
        await wait(300);
        check('pause sets the time scale to 0', world.time.timeScale === 0);
        // Leave the Entities tab open for the screenshot.
        $$('.ec-tab').find((t) => t.textContent === 'Entities')!.click();
        await wait(600);
    } catch (e) {
        lines.push(`FAIL exception: ${(e as Error).stack || e}`);
    }
    const div = document.createElement('div');
    div.id = 'result';
    div.textContent = lines.join('\n');
    document.body.appendChild(div);
}

if (location.hash.includes('interact')) setTimeout(run, 300);
