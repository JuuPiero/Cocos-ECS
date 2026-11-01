/**
 * Records structural changes to play back later (Unity's
 * EntityCommandBuffer), e.g. while iterating a query:
 *
 *     const ecb = this.world.getSystem(EndSimulationEntityCommandBufferSystem).createCommandBuffer();
 *     q.forEach((e, health) => { if (health.value <= 0) ecb.destroyEntity(e); });
 *
 * Entities created by the buffer get temporary (negative) handles; they are
 * replaced by the real entities on playback, also inside `entity` fields set
 * through the buffer.
 */
import { ComponentClass, ComponentType, ComponentValues, typeOf } from './component';
import type { Entity } from './entity';
import type { EntityManager } from './entity-manager';

type TypeArg = ComponentClass | ComponentType;

type Command =
    | { op: 'create'; e: Entity; types: ComponentType[] }
    | { op: 'instantiate'; e: Entity; src: Entity }
    | { op: 'destroy'; e: Entity }
    | { op: 'add'; e: Entity; type: ComponentType; values?: any }
    | { op: 'remove'; e: Entity; type: ComponentType }
    | { op: 'set'; e: Entity; type: ComponentType; values: any }
    | { op: 'enable'; e: Entity; enabled: boolean }
    | { op: 'name'; e: Entity; name: string };

export class EntityCommandBuffer {
    private commands: Command[] = [];
    private nextTemp = -1;

    get isEmpty(): boolean {
        return this.commands.length === 0;
    }

    get length(): number {
        return this.commands.length;
    }

    createEntity(...types: TypeArg[]): Entity {
        const e = this.nextTemp--;
        this.commands.push({ op: 'create', e, types: types.map(typeOf) });
        return e;
    }

    instantiate(src: Entity): Entity {
        const e = this.nextTemp--;
        this.commands.push({ op: 'instantiate', e, src });
        return e;
    }

    destroyEntity(e: Entity): void {
        this.commands.push({ op: 'destroy', e });
    }

    addComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType, values?: ComponentValues<T>): void {
        this.commands.push({ op: 'add', e, type: typeOf(type), values: values && { ...values } });
    }

    removeComponent(e: Entity, type: TypeArg): void {
        this.commands.push({ op: 'remove', e, type: typeOf(type) });
    }

    setComponent<T>(e: Entity, type: ComponentClass<T> | ComponentType, values: ComponentValues<T>): void {
        this.commands.push({ op: 'set', e, type: typeOf(type), values: { ...values } });
    }

    setEnabled(e: Entity, enabled: boolean): void {
        this.commands.push({ op: 'enable', e, enabled });
    }

    setName(e: Entity, name: string): void {
        this.commands.push({ op: 'name', e, name });
    }

    /** Applies every command in order, then empties the buffer. */
    playback(em: EntityManager): void {
        const real = new Map<Entity, Entity>();
        const resolve = (e: Entity) => (e < 0 ? real.get(e) ?? 0 : e);
        const remap = (type: ComponentType, values: any) => {
            if (!values) return values;
            let out = values;
            for (const f of type.fields) {
                if (f.kind === 'entity' && typeof values[f.name] === 'number' && values[f.name] < 0) {
                    if (out === values) out = { ...values };
                    out[f.name] = resolve(values[f.name]);
                }
            }
            return out;
        };
        const commands = this.commands;
        this.commands = [];
        this.nextTemp = -1;
        for (const c of commands) {
            switch (c.op) {
                case 'create':
                    real.set(c.e, em.createEntity(...c.types));
                    break;
                case 'instantiate': {
                    const src = resolve(c.src);
                    if (em.exists(src)) real.set(c.e, em.instantiate(src));
                    break;
                }
                case 'destroy':
                    em.destroyEntity(resolve(c.e));
                    break;
                case 'add': {
                    const e = resolve(c.e);
                    if (em.exists(e)) em.addComponent(e, c.type, remap(c.type, c.values));
                    break;
                }
                case 'remove': {
                    const e = resolve(c.e);
                    if (em.exists(e)) em.removeComponent(e, c.type);
                    break;
                }
                case 'set': {
                    const e = resolve(c.e);
                    if (em.exists(e)) em.setComponent(e, c.type, remap(c.type, c.values));
                    break;
                }
                case 'enable': {
                    const e = resolve(c.e);
                    if (em.exists(e)) em.setEnabled(e, c.enabled);
                    break;
                }
                case 'name': {
                    const e = resolve(c.e);
                    if (em.exists(e)) em.setName(e, c.name);
                    break;
                }
            }
        }
    }
}
