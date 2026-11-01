/**
 * Entities window (Unity's Systems / Entities Hierarchy / Archetypes
 * windows): looks into the worlds of a running game.
 */
import { createApp } from 'vue';
import type { ClientInfo, DebugBridge } from './bridge';

export interface EntitiesApp {
    dispose(): void;
    debug(): any;
}

const TEMPLATE = /* html */ `
<div class="ec-root">
  <div class="ec-toolbar">
    <select class="ec-input ec-client" v-model.number="clientId" @change="onClientChange" :disabled="!clients.length" title="Running game">
      <option v-if="!clients.length" :value="0">No game running</option>
      <option v-for="c in clients" :key="c.id" :value="c.id">{{ clientLabel(c) }}</option>
    </select>
    <select class="ec-input" v-model="world" :disabled="!worlds.length" title="World">
      <option v-for="w in worlds" :key="w.name" :value="w.name">{{ w.name }} ({{ w.entities }})</option>
    </select>
    <button class="ec-btn" :class="{ on: paused }" @click="togglePause" :disabled="!clientId" :title="paused ? 'Resume the world' : 'Pause the world (time scale 0)'">{{ paused ? 'Resume' : 'Pause' }}</button>
    <span class="ec-dim">Time Scale</span>
    <input class="ec-input ec-num" type="number" min="0" step="0.1" :value="timeScale" @change="setTimeScale($event.target.value)" :disabled="!clientId">
    <span class="ec-flex"></span>
    <span class="ec-stat" v-if="overview">{{ overview.fps }} fps · {{ overview.entityCount }} entities · {{ (overview.archetypes || []).length }} archetypes</span>
  </div>
  <div class="ec-tabs">
    <button v-for="t in tabs" :key="t" class="ec-tab" :class="{ on: tab === t }" @click="setTab(t)">{{ t }}</button>
    <span class="ec-flex"></span>
    <label class="ec-check" title="Accept games from other devices (a phone running a browser preview)"><input type="checkbox" :checked="lan" @change="setLan($event.target.checked)"> LAN</label>
  </div>

  <div class="ec-empty" v-if="!clientId">
    <div class="ec-empty-title">No running game</div>
    <div>Press Play in the editor or open a browser preview: debug builds of the game connect here by themselves.</div>
    <div class="ec-dim" v-if="server">{{ server.running ? 'Listening on ' + server.host + ':' + server.port : 'Debug server not running: ' + server.error }}</div>
  </div>

  <div class="ec-body" v-else-if="tab === 'Systems'">
    <div class="ec-table">
      <div class="ec-row ec-head"><span class="ec-col-name">System</span><span class="ec-col-num">Entities</span><span class="ec-col-num">Time (ms)</span></div>
      <div v-for="r in systemRows" :key="r.id" class="ec-row" :class="{ group: r.group, off: !r.enabled, idle: !r.running && !r.group }">
        <span class="ec-col-name" :style="{ paddingLeft: (6 + r.depth * 14) + 'px' }">
          <span class="ec-caret" v-if="r.group" @click="toggleGroup(r.id)">{{ collapsed.has(r.id) ? '▸' : '▾' }}</span>
          <input type="checkbox" :checked="r.enabled" @change="setSystemEnabled(r.id, $event.target.checked)" :title="r.enabled ? 'Disable' : 'Enable'">
          <span :title="r.name">{{ r.name }}</span>
        </span>
        <span class="ec-col-num">{{ r.group ? '' : r.entities }}</span>
        <span class="ec-col-num">{{ r.ms.toFixed(2) }}</span>
      </div>
    </div>
  </div>

  <div class="ec-body ec-split" v-else-if="tab === 'Entities'">
    <div class="ec-list">
      <input class="ec-input ec-search" placeholder="Search: name, c:Component" v-model="search" @input="searchChanged">
      <div class="ec-dim ec-pad">{{ entityList.total }} entities<span v-if="entityList.total > entityList.items.length"> (showing {{ entityList.items.length }})</span></div>
      <div class="ec-items">
        <div v-for="it in entityList.items" :key="it.e" class="ec-item" :class="{ on: it.e === selected, off: it.disabled }" @click="select(it.e)" :title="'Archetype ' + it.archetype">
          <span class="ec-item-name">{{ it.name || entityText(it.e) }}</span><span class="ec-dim">{{ entityText(it.e) }}</span>
        </div>
      </div>
      <button class="ec-btn ec-more" v-if="entityList.total > entityList.items.length" @click="loadMore">Show more</button>
    </div>
    <div class="ec-inspector">
      <div v-if="!detail" class="ec-dim ec-pad">{{ selected ? 'The entity no longer exists.' : 'Select an entity.' }}</div>
      <template v-else>
        <div class="ec-insp-head">
          <input type="checkbox" :checked="detail.enabled" @change="setEnabled($event.target.checked)" title="Enabled (Disabled tag)">
          <span class="ec-insp-name">{{ detail.name || detail.text }}</span>
          <span class="ec-dim">{{ detail.text }}</span>
          <span class="ec-flex"></span>
          <button class="ec-btn ec-danger" @click="destroySelected">Destroy</button>
        </div>
        <div v-for="c in detail.components" :key="c.name" class="ec-comp">
          <div class="ec-comp-head" @click="toggleComp(c.name)"><span class="ec-caret">{{ closedComps.has(c.name) ? '▸' : '▾' }}</span>{{ c.name }}<span class="ec-dim" v-if="c.tag"> (tag)</span></div>
          <div v-if="!closedComps.has(c.name) && !c.tag" class="ec-fields">
            <div v-for="f in c.fields" :key="f.name" class="ec-field">
              <span class="ec-field-name" :title="f.kind">{{ nice(f.name) }}</span>
              <input v-if="f.kind === 'bool'" type="checkbox" :checked="!!f.value" @change="setField(c.name, f.name, $event.target.checked)">
              <span v-else-if="f.kind === 'entity'" class="ec-ref">
                <a v-if="f.value" href="#" @click.prevent="select(f.value)">{{ f.entityName || entityText(f.value) }}</a><span v-else class="ec-dim">None</span>
              </span>
              <span v-else-if="f.kind === 'ref'" class="ec-ref" :title="refTitle(f.value)">{{ refText(f.value) }}</span>
              <input v-else class="ec-input ec-value" type="number" step="any" :value="fmt(f.value)" @focus="editing = c.name + '.' + f.name" @blur="editing = ''" @change="setField(c.name, f.name, $event.target.value)">
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>

  <div class="ec-body" v-else-if="tab === 'Archetypes'">
    <div class="ec-table">
      <div class="ec-row ec-head"><span class="ec-col-name">Components</span><span class="ec-col-num">Entities</span><span class="ec-col-num">Capacity</span><span class="ec-col-num">Memory</span></div>
      <div v-for="a in archetypes" :key="a.id" class="ec-row">
        <span class="ec-col-name ec-chips"><span v-for="t in a.types" :key="t" class="ec-chip" @click="filterBy(t)" title="Show these entities">{{ t }}</span><span v-if="!a.types.length" class="ec-dim">(no components)</span></span>
        <span class="ec-col-num">{{ a.count }}</span>
        <span class="ec-col-num">{{ a.capacity }}</span>
        <span class="ec-col-num">{{ kb(a.bytes) }}</span>
      </div>
    </div>
  </div>
</div>
`;

function flatten(nodes: any[], depth: number, collapsed: Set<number>, out: any[]): any[] {
    for (const n of nodes || []) {
        out.push({ ...n, depth });
        if (n.children && !collapsed.has(n.id)) flatten(n.children, depth + 1, collapsed, out);
    }
    return out;
}

export function parseSearch(text: string): { text: string; components: string[] } {
    const components: string[] = [];
    const words: string[] = [];
    for (const w of text.trim().split(/\s+/).filter(Boolean)) {
        const m = /^c:(.+)$/i.exec(w);
        if (m) components.push(m[1]);
        else words.push(w);
    }
    return { text: words.join(' '), components };
}

export function createEntitiesApp(el: HTMLElement, bridge: DebugBridge): EntitiesApp {
    let vm: any = null;
    let timer: any = null;
    let tick = 0;
    let busy = false;
    let off: (() => void) | null = null;

    const app = createApp({
        template: TEMPLATE,
        data() {
            return {
                tabs: ['Systems', 'Entities', 'Archetypes'],
                tab: 'Systems',
                clients: [] as ClientInfo[],
                clientId: 0,
                server: null as any,
                lan: false,
                worlds: [] as { name: string; entities: number }[],
                world: '',
                overview: null as any,
                collapsed: new Set<number>(),
                search: '',
                limit: 200,
                entityList: { total: 0, items: [] as any[] },
                selected: 0,
                detail: null as any,
                // The matrix is rarely interesting: closed until opened.
                closedComps: new Set<string>(['LocalToWorld']),
                editing: '',
            };
        },
        computed: {
            systemRows(this: any) {
                return flatten(this.overview?.systems || [], 0, this.collapsed, []);
            },
            archetypes(this: any) {
                return (this.overview?.archetypes || []).slice().sort((a: any, b: any) => b.count - a.count);
            },
            paused(this: any) {
                return this.overview?.time?.timeScale === 0;
            },
            timeScale(this: any) {
                return this.overview?.time?.timeScale ?? 1;
            },
        },
        methods: {
            clientLabel(c: ClientInfo) {
                let where = '';
                try {
                    where = c.url ? new URL(c.url).host : '';
                } catch {
                    where = '';
                }
                return `${c.runtime}${where ? ' – ' + where : ''}`;
            },
            entityText(e: number) {
                return `Entity(${e & 0xfffff}:${e >>> 20})`;
            },
            nice(name: string) {
                return name.replace(/^_+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
            },
            fmt(v: any) {
                return typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 10000) / 10000 : v;
            },
            kb(bytes: number) {
                return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
            },
            refText(v: any) {
                if (v === null || v === undefined) return 'None';
                if (typeof v !== 'object') return JSON.stringify(v);
                if (v.kind === 'asset') return `${v.type.replace(/^cc\./, '')} "${v.name}"`;
                if (v.kind === 'node') return `Node "${v.name}"${v.valid === false ? ' (destroyed)' : ''}`;
                if (v.kind === 'array') return `Array(${v.length})`;
                return v.type || 'Object';
            },
            refTitle(v: any) {
                try {
                    return JSON.stringify(v, null, 1).slice(0, 2000);
                } catch {
                    return '';
                }
            },
            setTab(t: string) {
                this.tab = t;
                this.save();
                poll(true);
            },
            toggleGroup(id: number) {
                const s = new Set(this.collapsed);
                if (s.has(id)) s.delete(id);
                else s.add(id);
                this.collapsed = s;
            },
            toggleComp(name: string) {
                const s = new Set(this.closedComps);
                if (s.has(name)) s.delete(name);
                else s.add(name);
                this.closedComps = s;
            },
            onClientChange() {
                this.overview = null;
                this.selected = 0;
                this.detail = null;
                poll(true);
            },
            searchChanged() {
                this.limit = 200;
                poll(true);
            },
            loadMore() {
                this.limit += 200;
                poll(true);
            },
            filterBy(type: string) {
                this.search = `c:${type}`;
                this.tab = 'Entities';
                poll(true);
            },
            select(e: number) {
                this.selected = e;
                this.tab = 'Entities';
                pollEntity();
            },
            async command(params: any) {
                if (!this.clientId) return null;
                const r = await bridge.request(this.clientId, 'command', { world: this.world, ...params });
                if (r && r.ok === false) console.warn('[ECS]', r.error);
                poll(true);
                return r;
            },
            setSystemEnabled(id: number, enabled: boolean) {
                this.command({ op: 'setSystemEnabled', id, enabled });
            },
            togglePause() {
                this.command({ op: 'timeScale', value: this.paused ? 1 : 0 });
            },
            setTimeScale(v: string) {
                this.command({ op: 'timeScale', value: Number(v) });
            },
            setField(component: string, field: string, value: any) {
                this.command({ op: 'setField', e: this.selected, component, field, value });
            },
            setEnabled(enabled: boolean) {
                this.command({ op: 'setEnabled', e: this.selected, enabled });
            },
            destroySelected() {
                this.command({ op: 'destroy', e: this.selected });
            },
            async setLan(on: boolean) {
                this.server = await bridge.setLan(on);
                this.lan = on;
            },
            save() {
                bridge.saveSettings({ tab: this.tab });
            },
        },
        mounted(this: any) {
            vm = this;
        },
    });

    async function refreshStatus(): Promise<void> {
        const s = await bridge.status().catch(() => null);
        if (!s || !vm) return;
        vm.server = s;
        setClients(s.clients);
    }

    function setClients(clients: ClientInfo[]): void {
        vm.clients = clients;
        if (!clients.some((c) => c.id === vm.clientId)) {
            vm.clientId = clients.length ? clients[clients.length - 1].id : 0;
            vm.overview = null;
            vm.detail = null;
        }
    }

    async function pollEntity(): Promise<void> {
        if (!vm.clientId || !vm.selected) {
            vm.detail = null;
            return;
        }
        const d = await bridge.request(vm.clientId, 'entity', { world: vm.world, e: vm.selected });
        if (!vm) return;
        // Keep the field being typed in.
        if (d && vm.editing && vm.detail) {
            const [comp, field] = vm.editing.split('.');
            const old = vm.detail.components.find((c: any) => c.name === comp)?.fields.find((f: any) => f.name === field);
            const now = d.components.find((c: any) => c.name === comp)?.fields.find((f: any) => f.name === field);
            if (old && now) now.value = old.value;
        }
        vm.detail = d;
    }

    async function poll(force = false): Promise<void> {
        if (!vm || (busy && !force)) return;
        busy = true;
        try {
            if (!vm.clientId) {
                if (force || tick % 4 === 0) await refreshStatus();
                return;
            }
            const o = await bridge.request(vm.clientId, 'overview', { world: vm.world });
            if (!vm) return;
            if (o) {
                vm.overview = o;
                vm.worlds = o.worlds || [];
                if (!vm.world || !vm.worlds.some((w: any) => w.name === vm.world)) vm.world = o.world || vm.worlds[0]?.name || '';
            } else if (!force) {
                await refreshStatus();
            }
            if (vm.tab === 'Entities') {
                if (force || tick % 2 === 0) {
                    const q = parseSearch(vm.search);
                    const list = await bridge.request(vm.clientId, 'entities', { world: vm.world, text: q.text, components: q.components, limit: vm.limit });
                    if (list && vm) vm.entityList = list;
                }
                await pollEntity();
            }
        } finally {
            busy = false;
        }
    }

    app.mount(el);
    off = bridge.onClients((clients) => vm && setClients(clients));
    bridge.loadSettings().then((s) => {
        if (s && vm && typeof s.tab === 'string' && vm.tabs.includes(s.tab)) vm.tab = s.tab;
    });
    refreshStatus().then(() => poll(true));
    timer = setInterval(() => {
        tick++;
        if (typeof document !== 'undefined' && document.hidden) return;
        poll();
    }, 500);

    return {
        dispose() {
            clearInterval(timer);
            off?.();
            app.unmount();
            vm = null;
        },
        debug: () => ({ vm, poll }),
    };
}
