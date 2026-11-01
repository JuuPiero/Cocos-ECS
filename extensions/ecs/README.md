# ECS for Cocos Creator 3.8

A data-oriented Entity Component System in the style of **Unity Entities (DOTS)**, for Cocos Creator 3.8.6+. It gives you:

- **Entities** that are plain numbers. Their components live in typed arrays, grouped by archetype.
- **Systems** with queries, change filters, entity command buffers and update ordering.
- **Transforms** with parenting.
- **Baking**: build scenes with ordinary nodes, and a `SubScene` turns them into entities when the game runs.
- **Rendering without nodes**: batched 2D sprites (one draw call per texture, in a Canvas or in 3D) and GPU-instanced 3D meshes.
- **An Entities window** that looks into the running game, in Play in Editor, browser previews, and phones on your network.

Moving 100,000 entities through their position columns takes about **0.4 ms** a frame.

| Unity Entities | Here |
|---|---|
| `IComponentData` struct | class with `@component('Name')` and field decorators (`@f32`, `@i32`, `@entity`, `@ref`…) |
| Tag component | `@component` class with no fields |
| `Entity`, `EntityManager` | `Entity` (a number), `world.entityManager` |
| `SystemBase`, `[UpdateInGroup]`, `[UpdateBefore/After]` | `SystemBase`, `@system({ group, updateBefore, updateAfter, orderFirst, orderLast })` |
| `[DisableAutoCreation]` | `@disableAutoCreation` |
| `EntityQuery`, `WithAll / WithAny / WithNone` | `this.query(A, B)`, `this.getQuery({ all, any, none })` |
| `Entities.ForEach` / `IJobChunk` | `query.forEach((e, a, b) => …)` / `for (const arch of query.archetypes)` |
| `SetChangedVersionFilter` | `query.setChangeFilter(Type)` |
| `EntityCommandBuffer`, `EndSimulationEntityCommandBufferSystem` | `this.commandBuffer(EndSimulationEntityCommandBufferSystem)` |
| `RequireForUpdate`, `SystemAPI.GetSingleton` | `this.requireForUpdate(T)`, `this.getSingleton(T)` |
| Initialization / Simulation / Presentation, `FixedStepSimulationSystemGroup` | same names |
| `LocalTransform`, `Parent`, `LocalToWorld`, `PostTransformMatrix` | `LocalTransform`, `Parent`, `LocalToWorld`, `PostTransformScale` |
| `Disabled`, `Prefab`, `LinkedEntityGroup` | same names |
| SubScene, `Baker<T>`, `GetEntity(prefab)` | `SubScene` component, `Baker<T>` + `@baker(T)`, `this.getEntity(prefab)` |
| Companion GameObjects | `linkNode(world, node)`, `EntityLink` |
| Entities Graphics (`RenderMeshArray`) | `RenderMesh` + `EntityMeshRenderer`, `RenderSprite` + `EntitySpriteRenderer` |
| Entities Hierarchy / Systems / Archetypes windows | **Panel → ECS Entities** |

## Contents

- [Quick start](#quick-start)
- [Components](#components)
- [Entities](#entities)
- [Systems](#systems)
- [Queries](#queries)
- [Command buffers](#command-buffers)
- [Transforms](#transforms)
- [When things run](#when-things-run)
- [Baking: SubScene and bakers](#baking-subscene-and-bakers)
- [Prefabs](#prefabs)
- [Nodes and entities together](#nodes-and-entities-together)
- [2D sprites](#2d-sprites)
- [3D meshes](#3d-meshes)
- [The Entities window](#the-entities-window)
- [Performance](#performance)
- [Samples](#samples)
- [Limitations](#limitations)
- [Development](#development)

## Quick start

Import everything from `db://ecs/index`. The extension mounts its runtime as the `db://ecs` asset folder.

```ts
import { _decorator, Component, SpriteFrame } from 'cc';
import { LocalToWorld, LocalTransform, RenderSprite, SystemBase, component, defaultWorld, f32, system } from 'db://ecs/index';

// 1. Data: a component is a class of numeric fields.
@component('Velocity')
export class Velocity {
    @f32 x = 0;
    @f32 y = 0;
}

// 2. Behaviour: a system runs every frame over the entities that match its query.
@system({ name: 'MoveSystem' })
export class MoveSystem extends SystemBase {
    private movers = this.query(LocalTransform, Velocity);

    onUpdate() {
        const dt = this.time.deltaTime;
        this.movers.forEach((e, t, v) => {
            t.x += v.x * dt;
            t.y += v.y * dt;
        });
    }
}

// 3. Entities: create them from any script (here, a component on a node in a Canvas).
const { ccclass, property } = _decorator;

@ccclass('Spawner')
export class Spawner extends Component {
    @property(SpriteFrame) frame: SpriteFrame | null = null;

    start() {
        const em = defaultWorld()!.entityManager;
        for (let i = 0; i < 1000; i++) {
            const e = em.createEntity(LocalTransform, LocalToWorld, Velocity, RenderSprite);
            em.setComponent(e, LocalTransform, { x: Math.random() * 960, y: Math.random() * 640 });
            em.setComponent(e, Velocity, { x: Math.random() * 100 - 50, y: Math.random() * 100 - 50 });
            em.setComponent(e, RenderSprite, { frame: this.frame, width: 32, height: 32 });
        }
    }
}
```

To draw the sprites, add **ECS → EntitySpriteRenderer** to a node in the Canvas. In a Canvas, Cocos also needs a UI renderer on that node, so add `EcsUIRenderer` too. A `SubScene` adds both by itself (see [Baking](#baking-subscene-and-bakers)).

Press **Play** and open **Panel → ECS Entities** to watch the systems and entities.

> **Tip:** VS Code imports the project's `db://` paths when `.vscode/settings.json` has
> `"typescript.preferences.importModuleSpecifier": "non-relative"`. Without it, it writes
> `../../extensions/ecs/assets/...` paths, which also work.

## Components

A component is a class with `@component('Name')`. Each field becomes a typed-array column: entities with the same set of components (an *archetype*) store each field in one contiguous array.

```ts
@component('Health')
export class Health {
    @f32 value = 100;
    @f32 max = 100;
    @bool invulnerable = false;
}

@component('Enemy')          // no fields: a tag
export class Enemy {}

@component('Target')
export class Target {
    @entity who: Entity = 0;      // a reference to another entity
    @ref node: Node | null = null; // any JS value: assets, nodes, strings, arrays…
}
```

| Decorator | Stored as | Use for |
|---|---|---|
| `@f32` | `Float32Array` | most numbers (the default for undecorated numbers) |
| `@f64` | `Float64Array` | numbers that need full JS precision (times, big counters) |
| `@i8` `@i16` `@i32` | `Int8/16/32Array` | integers |
| `@u8` `@u16` `@u32` | `Uint8/16/32Array` | non-negative integers, packed colors |
| `@bool` | `Uint8Array` (0 / 1) | flags |
| `@entity` | `Int32Array` | other entities; remapped by `instantiate` and command buffers |
| `@ref` | plain `Array` | strings, objects, Cocos assets and nodes |

- **Give every component a name.** Builds minify class names, and bakers, the debug window and reloads rely on it.
- An undecorated field is inferred from its default: a number becomes `f32`, a boolean becomes `bool`, anything else becomes `ref`.
- The field initializers are the defaults of new entities. `@ref` objects and arrays are copied for each entity.
- Re-registering a name (a script reload in the editor) makes a fresh component type. Play starts a new world anyway.

## Entities

An `Entity` is a number: a 20-bit index plus an 11-bit version. Destroyed entities don't come back: their index is reused with a new version, so `exists()` on a stale id returns `false`. `0` is "no entity". Use `entityToString(e)` for logs (`Entity(12:3)`).

```ts
const world = defaultWorld()!;          // null while editing scenes
const em = world.entityManager;

const e = em.createEntity(LocalTransform, LocalToWorld, Health);
const many = em.createEntities(500, LocalTransform, LocalToWorld, Enemy);

em.addComponent(e, Enemy);
em.addComponent(e, Target, { who: many[0] });
em.setComponent(e, Health, { value: 50 });      // only the fields you give
em.removeComponent(e, Enemy);
em.hasComponent(e, Health);

const h = em.getComponent(e, Health);           // live view: writes go to the arrays
h.value -= 10;
const copy = em.getComponentData(e, Health);    // plain copy

em.setName(e, 'Player');                        // shown in the Entities window
em.setEnabled(e, false);                        // adds the Disabled tag
em.destroyEntity(e);                            // also takes arrays
em.exists(e);                                   // false
```

**Singletons** are components held by one entity:

```ts
em.setSingleton(GameSettings, { gravity: -9.8 });
em.getSingleton(GameSettings).gravity;
em.hasSingleton(GameSettings);
```

## Systems

```ts
@system({ group: SimulationSystemGroup, updateAfter: [InputSystem], name: 'MoveSystem' })
export class MoveSystem extends SystemBase {
    private movers = this.query(LocalTransform, Velocity);   // queries can be fields

    protected onCreate() { this.requireForUpdate(Velocity); } // skip while none exist
    protected onStartRunning() {}
    protected onUpdate() { /* every frame */ }
    protected onStopRunning() {}
    protected onDestroy() {}
}
```

- **`@system()` registers the class.** It is created in the default world when the game starts, or right away when the script loads later (bundles).
- **`name`** is shown in the debug window. Set it, because builds minify class names.
- **Groups**: `InitializationSystemGroup`, `SimulationSystemGroup` (the default), `PresentationSystemGroup`, `FixedStepSimulationSystemGroup`, or your own `ComponentSystemGroup` subclass registered with `@system`.
- **Order** inside a group: `orderFirst`, then `updateBefore` / `updateAfter`, then `orderLast`. Otherwise systems run in registration order.
- **Inside a system**:
  - `this.world`, `this.entityManager`, `this.time` (`deltaTime`, `elapsedTime`, `frameCount`, `timeScale`)
  - `this.getSingleton(T)`, `this.setSingleton(T, values)`, `this.hasSingleton(T)`
  - `this.commandBuffer(...)`
- **`enabled = false`** stops a system. You can also untick it in the Entities window.
- **`requireForUpdate(T or query)`**: `onUpdate` runs only while every required query has entities. A system without requirements always runs.
- **`@disableAutoCreation`** keeps a system out of the default world. Add it yourself with `world.addSystem(MySystem)`.
- **`FixedStepSimulationSystemGroup`** updates its systems zero or more times a frame with `deltaTime = timestep` (1/60 by default, at most `maxSteps` = 4 steps a frame). Put physics-like systems there with `group: FixedStepSimulationSystemGroup`.
- **Slow motion and pause**: `world.time.timeScale = 0.5`, or `0` to pause. The window's **Pause** button does the same.

**Your own worlds** (tests, tools, a server simulation) are updated by hand:

```ts
const world = World.createDefault('Test World');  // every @system, unless you pass a list
world.update(1 / 60);
world.dispose();
```

## Queries

```ts
const q1 = this.query(LocalTransform, Velocity);                     // all of these
const q2 = this.getQuery({ all: [Health], any: [Enemy, Boss], none: [Dead] });
const q3 = this.getQuery({ all: [Health], includeDisabled: true, includePrefab: true });
```

Disabled entities and prefabs are skipped unless you ask for them, or name `Disabled` / `Prefab` in the query.

There are two ways to iterate:

```ts
// Convenient: one call per entity, with live views of the components.
q.forEach((e, t, v) => { t.x += v.x * dt; });

// Fastest: per archetype, straight on the typed arrays (about 20× faster).
for (const a of q.archetypes) {
    const t = a.write(LocalTransform);   // write(): marks the column as changed
    const v = a.get(Velocity);           // get(): read only
    for (let i = 0; i < a.count; i++) {
        t.x[i] += v.x[i] * dt;
        t.y[i] += v.y[i] * dt;
    }
    // a.entities[i] is the entity of row i
}
```

Other query methods: `count()`, `isEmpty()`, `toEntityArray()`, `getSingletonEntity()`.

**Change filters** skip archetypes whose columns weren't written since the system last ran:

```ts
private changed = this.getQuery({ all: [Health] }).setChangeFilter(Health);
```

Writing through a view, `setComponent` or `write()` marks the column. `get()` doesn't. As in Unity, the filter works per archetype, not per entity.

**Structural changes** (create, destroy, add or remove a component, instantiate) can't happen inside `forEach`, because they move rows around. Record them in a command buffer, or collect the entities first with `toEntityArray()`.

## Command buffers

A command buffer records structural changes and plays them back later, at a known point of the frame:

```ts
protected onUpdate() {
    const ecb = this.commandBuffer(EndSimulationEntityCommandBufferSystem);
    this.q.forEach((e, life) => {
        life.seconds -= this.time.deltaTime;
        if (life.seconds <= 0) ecb.destroyEntity(e);
    });
}
```

- **Playback points**: `Begin`/`EndInitialization`, `Begin`/`EndSimulation` and `BeginPresentation`, each followed by `EntityCommandBufferSystem`.
- **Commands**: `createEntity`, `instantiate`, `destroyEntity`, `addComponent`, `removeComponent`, `setComponent`, `setEnabled`, `setName`.
- **Deferred entities**: `createEntity` and `instantiate` return a temporary id. You can use it in later commands and in `@entity` fields of the same buffer; it becomes the real entity at playback.

## Transforms

| Component | Meaning |
|---|---|
| `LocalTransform` | `x y z`, rotation quaternion `qx qy qz qw`, uniform `scale`. Relative to the `Parent`, or to the world without one. |
| `Parent` | `value`: the parent entity |
| `PostTransformScale` | non-uniform `x y z` scale applied after `LocalTransform` |
| `LocalToWorld` | the world matrix `m00…m15`, column-major like Cocos' `Mat4`; `m12 m13 m14` is the position |

`LocalToWorldSystem` writes `LocalToWorld` at the end of the simulation (in `TransformSystemGroup`). It handles parents at any depth, created in any order. Entities need **both** `LocalTransform` and `LocalToWorld` to be moved and drawn.

Helpers:

- `setAngle(t, degrees)` / `getAngle(t)`: rotation around Z, for 2D.
- `setEuler(t, x, y, z)`: rotation from Euler angles in degrees, like `Quat.fromEuler`.
- `composeMatrix`, `multiplyMatrix`, `worldPosition(ltw)`.

If a system moves entities later in the frame (in Presentation), `LateTransformSystem` updates their `LocalToWorld` again before they are drawn.

## When things run

The default world hooks into Cocos' frame:

```
Director.EVENT_BEFORE_UPDATE
    InitializationSystemGroup   (CopyTransformFromNodeSystem…)
    SimulationSystemGroup       (FixedStep group, your systems, TransformSystemGroup, EndSimulation ECB)
Component.update / lateUpdate   (your node scripts)
Director.EVENT_AFTER_UPDATE
    PresentationSystemGroup     (LateTransformSystem, CopyTransformToNodeSystem, sprite and mesh rendering)
render
```

- The default world exists only where the game runs: builds, browser previews and Play in Editor. While you edit scenes, `defaultWorld()` returns `null` and `isPlaying()` returns `false`.
- The world starts once the game has loaded the project's scripts. Every `@system` known by then is created.

## Baking: SubScene and bakers

Build levels the usual way, with nodes and components in the scene editor, then let them become entities:

1. Add **ECS → SubScene** to a node.
2. Put the content under it: sprites, meshes, and your own authoring components.
3. Press Play. In `onLoad`, the SubScene turns its children into entities and removes the nodes.

| Property | Meaning |
|---|---|
| **Keep Nodes** | Keep the nodes and link each one to its entity. The entity moves the node, and the nodes keep rendering themselves. Use it for content that needs Cocos components (Spine, particles, UI). |
| **Destroy Entities With Node** | Destroy the baked entities when the SubScene node goes away, for example when the scene unloads. |
| **Sprite Material** | The material of the `EntitySpriteRenderer` that the SubScene adds for baked sprites. It is filled in when you add the component, so builds include the material. |

Every node becomes an entity with `LocalTransform`, `LocalToWorld` and its name.

- Top nodes are placed in world space.
- Children get a `Parent`, and non-uniform scale becomes `PostTransformScale`.
- Inactive nodes become `Disabled` entities.

**Built-in bakers:**

- `cc.Sprite` → `RenderSprite`: frame, color, size and anchor.
- `cc.MeshRenderer` → `RenderMesh`. A material that doesn't use the `ecs-mesh` effect gives its `mainColor` to the default instanced material.

If baked sprites need a renderer, the SubScene adds an `EntitySpriteRenderer`, plus `EcsUIRenderer` inside a Canvas. This includes sprites in prefabs that bakers asked for. Meshes need an `EntityMeshRenderer` somewhere in the scene.

**Your own bakers** convert an authoring component (a normal Cocos component with `@property` fields) into ECS data:

```ts
@ccclass('SpinAuthoring')
export class SpinAuthoring extends Component {
    @property speed = 90;
}

@component('Spin')
export class Spin {
    @f32 speed = 90;
}

@baker(SpinAuthoring)
export class SpinBaker extends Baker<SpinAuthoring> {
    bake(a: SpinAuthoring) {
        this.addComponent(Spin, { speed: a.speed });
    }
}
```

Inside `bake`:

- `this.entity`, `this.node`
- `this.addComponent(T, values?, target?)`, `this.setComponent(...)`
- `this.createAdditionalEntity(name)`
- `this.getEntity(node)`: the entity of another baked node.
- `this.getEntity(prefab)`: an entity prefab.
- `this.keepingNodes`: true with **Keep Nodes**.

Bakers also run for subclasses of the authoring class.

To bake from code, use `bakeNodes(world, roots, { worldRoots, prefab, keepNodes })`. It returns `{ entities, nodeToEntity, prefabs }`.

## Prefabs

A Cocos Prefab can be baked once into an **entity prefab**, then instantiated many times without any nodes:

```ts
// In a baker: store it in an @entity field.
this.addComponent(Spawner, { prefab: this.getEntity(authoring.prefab) });

// Or from code.
const prefabEntity = bakePrefab(world, prefabAsset);   // cached per world
const copies = em.instantiate(prefabEntity, 100);
```

- Entity prefabs carry the `Prefab` tag, so queries skip them.
- The root lists the whole hierarchy in `LinkedEntityGroup`. `instantiate` copies the group and points `@entity` fields inside it at the new copies.
- Destroying an instance's root destroys its whole group, as in Unity.
- In a system, instantiate through a command buffer: `ecb.instantiate(prefab)`.

## Nodes and entities together

Some things still need nodes: Spine, particles, UI, physics, audio. Link a node to an entity, and either side can drive the other:

```ts
const e = linkNode(world, node, { copy: 'to-node' });    // the entity moves the node
const e2 = linkNode(world, node2, { copy: 'from-node' }); // the node moves the entity
entityOf(node);                                          // the node's entity, or 0
```

- **Copying**: `CopyTransformToNodeSystem` (Presentation) writes the entity's world transform to the node. `CopyTransformFromNodeSystem` (Initialization) reads the node into the entity.
- **Destroying**: an entity destroyed while it has `NodeLink.destroyNodeWithEntity` destroys its node. A node destroyed while its `EntityLink.destroyEntityWithNode` is set destroys its entity.
- **From the node's own scripts**, `node.getComponent(EntityLink).entity` gives the entity.
- **Links in data**: an entity can also point at any node or asset with a `@ref` field.

## 2D sprites

```ts
em.setComponent(e, RenderSprite, {
    frame,                       // SpriteFrame (trimmed and rotated atlas frames work)
    color: rgba(255, 200, 200),  // packed RGBA; packColor(cc.Color) also works
    width: 64, height: 64,       // 0: the frame's original size
    anchorX: 0.5, anchorY: 0.5,
    order: 10,                   // draw order with sortMode Order
    layer: 0,                    // which EntitySpriteRenderer draws it
    flipX: false, flipY: false,
});
```

An **EntitySpriteRenderer** (Add Component → ECS → EntitySpriteRenderer) draws every `RenderSprite` of its **Layer**.

- **Position**: sprites are drawn at their world position (`LocalToWorld`), seen from the renderer's node, so put the renderer under the Canvas or camera that shows them.
- **Draw calls**: one per texture. Pack sprites into atlases to keep it low.

**Sort Mode**:

| Value | Order |
|---|---|
| `None` | creation order (fastest) |
| `Order` | `RenderSprite.order` (default) |
| `Y` | lower on screen in front (top-down games), then `order` |
| `OrderThenY` | `order`, then lower Y in front |

**In a Canvas**, also add `EcsUIRenderer`. The sprites then sort with the UI like any other UI node. **In a 3D scene**, no extra component is needed.

**Materials**:

- `ecs-sprite-ui.mtl`: for the Canvas (no depth).
- `ecs-sprite-world.mtl`: for 3D (depth test, alpha blend).

Both use `ecs/effects/ecs-sprite.effect`, and the right one is chosen by default. For custom shaders, copy the effect and keep its vertex inputs (position, UV, color).

## 3D meshes

```ts
em.setComponent(e, RenderMesh, {
    mesh,                        // cc.Mesh
    material: null,              // null: the renderer's material
    subMesh: 0,
    color: rgba(255, 80, 80),    // per-instance tint
    layer: 0,
});
```

An **EntityMeshRenderer** (Add Component → ECS → EntityMeshRenderer) draws every `RenderMesh` of its **Layer**.

- **GPU instancing**: one draw call per mesh, sub-mesh and material. Each instance sends its world matrix and color.
- **Culling**: each group gets bounds, so the camera skips groups off screen.

**Materials** must use the extension's **`ecs-mesh`** effect, which reads the instance data:

| Technique | Material |
|---|---|
| `lit` | `ecs-mesh-lit.mtl` (default): main directional light + ambient |
| `unlit` | `ecs-mesh-unlit.mtl` |
| `transparent` | alpha-blended, unlit |

Create a material from `ecs/effects/ecs-mesh.effect` for your own textures and colors (`mainTexture`, `mainColor`).

## The Entities window

Open **Panel → ECS Entities** (or **Extension → ECS → ECS Entities**), then press **Play** or open a browser preview. The window connects to the running game by itself.

**Toolbar**:

- the game it shows (when several are connected) and the world;
- **Pause** and **Time Scale**;
- the frame rate and entity count;
- **LAN**: lets other devices connect.

**Systems tab**:

- the group tree in update order;
- each system's entity count and average time in ms;
- a checkbox to turn the system off or on.

**Entities tab**:

- a paged list of entities;
- search by name or `Entity(index:version)` text, and filter by component with `c:Name`, for example `c:Enemy boss` or `c:Health c:Enemy`;
- the selected entity's components and their live values. You can edit numbers and booleans, and enable or destroy the entity;
- `@entity` fields are links: click one to select that entity;
- `@ref` fields show a summary, for example `SpriteFrame "hero"`.

**Archetypes tab**: every archetype with its components, entity count, capacity and memory.

**How it connects**:

- The editor runs a small WebSocket server on the first free port of **7461–7463**.
- Debug builds of the game (Play in Editor, browser previews) connect to it.
- Release builds don't connect: the agent only runs when `DEBUG` is true.

**Phones and other PCs**:

1. Tick **LAN** in the window, or set it before playing. The server then listens on every network interface instead of 127.0.0.1.
2. Open the preview URL on the device with the PC's IP address, for example `http://192.168.1.10:7456`.
3. Allow the ports through the PC's firewall.

The game connects back to the host it was loaded from. Native builds aren't supported, because they have no host to connect back to.

The window sends only a fixed set of requests: overview, entity list, entity details, and the commands above. Nothing else runs in the game.

From game code, `debugConnected()` tells whether the window is attached.

## Performance

Measured in Node.js on a desktop PC (`tests/bench.test.ts`):

| 100,000 entities | Time |
|---|---|
| Create (3 components) | ~20 ms |
| Move, per archetype on the typed arrays | **~0.4 ms** |
| Move, with `forEach` views | ~7 ms |
| Destroy 10,000 through a command buffer | ~22 ms |
| Remove a component from 10,000 | ~18 ms |

Tips:

- **Hot loops**: iterate `query.archetypes` with `get()` / `write()`. Use `forEach` where convenience matters more than speed.
- **Batch structural changes**:
  - create in bulk with `createEntities(n, …)` or `instantiate(prefab, n)`;
  - change archetypes in a command buffer rather than one at a time.
- **Prefer data over adding and removing components every frame**: each add or remove moves the entity to another archetype. A `@bool` field is often cheaper.
- **Keep components small and focused.** Systems that read only what they need touch less memory.
- **Use `@ref` sparingly.** It is a plain JS array, not a typed one. Keep assets in it, not per-frame numbers.
- **Draw calls**: one atlas for many sprites, and one material per mesh.
- **Profile in the window**: the Systems tab shows each system's ms, and the Archetypes tab shows memory.

## Samples

The ECS project contains three samples in `assets/samples`. They live in the project, not in the extension, so their systems don't appear in other projects. Copy them into a project to try them.

| Script | Setup | Shows |
|---|---|---|
| `SpriteSwarmDemo` | on a node in a Canvas, with a Sprite Frame | thousands of bouncing sprites in one draw call, a column-based system, a singleton |
| `MeshSwarmDemo` | on a node in a 3D scene | thousands of instanced cubes, a `forEach` system, `setEuler` |
| `SpinAuthoring` + `SpawnerAuthoring` | `SubScene` with a sprite + `SpinAuthoring`, and a node with `SpawnerAuthoring` (Prefab: a sprite) | authoring components, bakers, entity prefabs, command buffers |

Cocos allows **one Component class per script**: put each authoring component (with its baker and systems) in its own file.

## Limitations

- **Single-threaded.** There is no job system or Burst; systems run on the main thread.
- **Not implemented**:
  - shared components, chunk components, enableable components and buffers. Use a `@ref` array, or another entity, for lists;
  - physics on entities. Use hybrid nodes for physics;
  - skinned or animated meshes. Use hybrid nodes for those too.
- **Native builds** run the ECS, but the Entities window can't connect to them.
- **The Inspector** doesn't show entities while you edit scenes. Entities exist only while the game runs. Bake from nodes to author content.

## Development

```
extensions/ecs
├─ assets/              runtime (mounted as db://ecs)
│  ├─ core/             entities, archetypes, queries, systems, worlds, transforms
│  ├─ cocos/            bootstrap, hybrid, batched renderers, sprites, meshes, baking
│  ├─ debug/agent.ts    the game side of the Entities window
│  ├─ effects/          ecs-sprite, ecs-mesh
│  └─ materials/
├─ source/              editor side: main process (debug server), Entities panel (Vue 3)
├─ static/              panel style, icon
└─ tests/               Node tests, benchmark, headless preview of the panel
```

```bash
npm install
npm run build        # typecheck + bundle dist/
npm run watch        # rebuild on change
npm test             # core, transforms, debug bridge, benchmark
npm run preview      # tests/preview/out/preview.html: the Entities window against a live world in the page
```

Open `tests/preview/out/preview.html#interact` to run the panel checks in a browser.

After changing `source/` or `package.json`, rebuild and reload the extension: **Extension → Extension Manager → ecs → Reload**. Changes under `assets/` are picked up by Cocos like any script.
