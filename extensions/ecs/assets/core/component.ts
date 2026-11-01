/**
 * Component types (Unity's IComponentData): plain classes whose fields are
 * stored per archetype as columns, numbers in typed arrays.
 *
 *     @component('Velocity')
 *     export class Velocity {
 *         @f32 x = 0;
 *         @f32 y = 0;
 *     }
 *
 *     @component('Enemy')
 *     export class Enemy {}           // no fields: a tag
 *
 * Field kinds: f32, f64, i8, i16, i32, u8, u16, u32, bool, entity (numbers in
 * typed arrays) and ref (any JS value, in a plain array). Without a
 * decorator a field's kind comes from its default value: number → f32,
 * boolean → bool, anything else → ref.
 */
import type { Entity } from './entity';

export type FieldKind = 'f32' | 'f64' | 'i8' | 'i16' | 'i32' | 'u8' | 'u16' | 'u32' | 'bool' | 'entity' | 'ref';

type TypedArrayCtor =
    | Float32ArrayConstructor | Float64ArrayConstructor | Int8ArrayConstructor | Int16ArrayConstructor
    | Int32ArrayConstructor | Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;

export const ARRAY_OF: Record<Exclude<FieldKind, 'ref'>, TypedArrayCtor> = {
    f32: Float32Array,
    f64: Float64Array,
    i8: Int8Array,
    i16: Int16Array,
    i32: Int32Array,
    u8: Uint8Array,
    u16: Uint16Array,
    u32: Uint32Array,
    bool: Uint8Array,
    entity: Int32Array,
};

export type Store = Float32Array | Float64Array | Int8Array | Int16Array | Int32Array | Uint8Array | Uint16Array | Uint32Array | any[];

export interface FieldDef {
    name: string;
    kind: FieldKind;
    /** Default value for new components (a function for ref fields that need a fresh object each time). */
    default: any;
}

export type ComponentClass<T = any> = new () => T;

/** Plain data for a component: some or all of its fields. */
export type ComponentValues<T> = Partial<{ [K in keyof T]: T[K] }>;

const FIELDS = '__ecsFields__';
const TYPE = '__ecsType__';

let nextId = 0;
const byId: ComponentType[] = [];
const byName = new Map<string, ComponentType>();

/** A live accessor for one component of one entity: reads and writes go to the columns. */
export interface ComponentView {
    /** @internal */ _c: Column;
    /** @internal */ _i: number;
}

/** One component's storage inside an archetype: one store per field, plus a change version. */
export interface Column {
    type: ComponentType;
    stores: Record<string, Store>;
    /** World version of the last write through a view or a write access. */
    version: number;
}

export class ComponentType {
    readonly id: number;
    readonly name: string;
    readonly ctor: ComponentClass;
    readonly fields: FieldDef[];
    readonly isTag: boolean;
    /** Prototype of the live views (accessors for each field). */
    readonly viewProto: object;

    constructor(name: string, ctor: ComponentClass, fields: FieldDef[]) {
        this.id = nextId++;
        this.name = name;
        this.ctor = ctor;
        this.fields = fields;
        this.isTag = fields.length === 0;
        const proto: any = {};
        for (const f of fields) {
            const key = f.name;
            if (f.kind === 'bool') {
                Object.defineProperty(proto, key, {
                    get(this: ComponentView) { return this._c.stores[key][this._i] !== 0; },
                    set(this: ComponentView, v: boolean) { (this._c.stores[key] as Uint8Array)[this._i] = v ? 1 : 0; touch(this._c); },
                    enumerable: true,
                });
            } else {
                Object.defineProperty(proto, key, {
                    get(this: ComponentView) { return this._c.stores[key][this._i]; },
                    set(this: ComponentView, v: any) { (this._c.stores[key] as any)[this._i] = v; touch(this._c); },
                    enumerable: true,
                });
            }
        }
        Object.defineProperty(proto, 'toJSON', { value(this: ComponentView) { return readValues(this._c, this._i); } });
        this.viewProto = proto;
    }

    /** Default value of a field (a fresh copy for ref fields). */
    defaultOf(f: FieldDef): any {
        return typeof f.default === 'function' && f.kind === 'ref' ? f.default() : f.default;
    }
}

/** Bumped by the world as systems run; written columns remember it (change filters). */
export const clock = { version: 1 };

function touch(c: Column): void {
    c.version = clock.version;
}

/** Plain values of the component at a row. */
export function readValues(c: Column, row: number): Record<string, any> {
    const out: Record<string, any> = {};
    for (const f of c.type.fields) {
        const v = c.stores[f.name][row];
        out[f.name] = f.kind === 'bool' ? v !== 0 : v;
    }
    return out;
}

// --------------------------------------------------------------- decorators

function fieldDecorator(kind: FieldKind) {
    return function (target: any, key: string): void {
        const ctor = target.constructor;
        if (!Object.prototype.hasOwnProperty.call(ctor, FIELDS)) {
            Object.defineProperty(ctor, FIELDS, { value: { ...(ctor[FIELDS] || {}) }, enumerable: false });
        }
        ctor[FIELDS][key] = kind;
    };
}

/** 32-bit float field (the default for numbers). */
export const f32 = fieldDecorator('f32');
/** 64-bit float field (JS number precision). */
export const f64 = fieldDecorator('f64');
export const i8 = fieldDecorator('i8');
export const i16 = fieldDecorator('i16');
export const i32 = fieldDecorator('i32');
export const u8 = fieldDecorator('u8');
export const u16 = fieldDecorator('u16');
export const u32 = fieldDecorator('u32');
export const bool = fieldDecorator('bool');
/** A reference to another entity. */
export const entity = fieldDecorator('entity');
/** Any JS value (objects, strings, Cocos assets and nodes...). */
export const ref = fieldDecorator('ref');

function inferKind(v: any): FieldKind {
    if (typeof v === 'number') return 'f32';
    if (typeof v === 'boolean') return 'bool';
    return 'ref';
}

/**
 * Registers a component class (Unity's IComponentData). The name is used by
 * the debug windows and bakers; give it explicitly (class names are minified
 * in release builds).
 */
export function component(name?: string) {
    return function <T extends ComponentClass>(ctor: T): T {
        registerComponent(ctor, name);
        return ctor;
    };
}

export function registerComponent(ctor: ComponentClass, name?: string): ComponentType {
    if (Object.prototype.hasOwnProperty.call(ctor, TYPE)) return (ctor as any)[TYPE];
    const typeName = name || ctor.name || `Component${nextId}`;
    const sample: any = new ctor();
    const declared: Record<string, FieldKind> = (ctor as any)[FIELDS] || {};
    const keys = new Set<string>([...Object.keys(sample), ...Object.keys(declared)]);
    const fields: FieldDef[] = [];
    for (const key of keys) {
        const kind = declared[key] || inferKind(sample[key]);
        let def = sample[key];
        if (kind === 'ref' && def !== null && typeof def === 'object') {
            // Objects/arrays: a fresh copy per component, like a field initializer.
            def = () => (new ctor() as any)[key];
        }
        if (kind === 'bool') def = def ? 1 : 0;
        else if (kind === 'entity') def = def || 0;
        else if (kind !== 'ref' && typeof def !== 'number') def = 0;
        fields.push({ name: key, kind, default: def });
    }
    // Same name again (scripts reloaded in the editor): a new type replaces the name,
    // worlds made before keep using the old one.
    const type = new ComponentType(typeName, ctor, fields);
    byId[type.id] = type;
    byName.set(typeName, type);
    Object.defineProperty(ctor, TYPE, { value: type, enumerable: false, configurable: true });
    return type;
}

/** The ComponentType of a component class (registered on first use when not decorated). */
export function typeOf(ctor: ComponentClass | ComponentType): ComponentType {
    if (ctor instanceof ComponentType) return ctor;
    const t = Object.prototype.hasOwnProperty.call(ctor, TYPE) ? (ctor as any)[TYPE] : null;
    return t || registerComponent(ctor);
}

export function componentTypeById(id: number): ComponentType | undefined {
    return byId[id];
}

export function componentTypeByName(name: string): ComponentType | undefined {
    return byName.get(name);
}

export function allComponentTypes(): ComponentType[] {
    return byId.filter(Boolean);
}

export type { Entity };
