/**
 * Runs the default world in the game (and in Play in Editor, not while
 * editing): Initialization and Simulation before the components' update(),
 * Presentation after lateUpdate() (node sync and batched rendering happen
 * there, before the frame renders).
 */
import { Director, Game, director, game } from 'cc';
import { EDITOR_NOT_IN_PREVIEW } from 'cc/env';
import { World } from '../core/world';
import { SystemClass, isAutoCreated, onSystemRegistered, systemRegistry } from '../core/system';

let hooked = false;

function onBeforeUpdate(): void {
    const w = World.defaultWorld;
    if (!w || w.disposed) return;
    w.beginFrame(game.deltaTime);
    w.initialization.update();
    w.simulation.update();
}

function onAfterUpdate(): void {
    const w = World.defaultWorld;
    if (!w || w.disposed) return;
    w.presentation.update();
}

/** True where the game runs (build, browser preview, Play in Editor), false while editing scenes. */
export function isPlaying(): boolean {
    return !EDITOR_NOT_IN_PREVIEW;
}

/**
 * The default world (Unity's World.DefaultGameObjectInjectionWorld), created
 * with every @system on first use. Null while editing scenes.
 */
export function defaultWorld(): World | null {
    if (!isPlaying()) return null;
    if (!World.defaultWorld || World.defaultWorld.disposed) {
        World.defaultWorld = World.createDefault('Default World');
    }
    if (!hooked) {
        hooked = true;
        director.on(Director.EVENT_BEFORE_UPDATE, onBeforeUpdate);
        director.on(Director.EVENT_AFTER_UPDATE, onAfterUpdate);
    }
    return World.defaultWorld;
}

// Systems from scripts loaded later (bundles) join the running default world.
onSystemRegistered((cls: SystemClass) => {
    const w = World.defaultWorld;
    if (w && !w.disposed && isAutoCreated(cls) && !w.getSystem(cls)) w.addSystem(cls);
});

if (isPlaying()) {
    // Start once the game has loaded the project's scripts (all @system classes registered).
    const start = () => defaultWorld();
    if (game.inited) director.once(Director.EVENT_BEFORE_SCENE_LAUNCH, start);
    else game.once(Game.EVENT_GAME_INITED, start);
    // Safety: the first frame creates it at the latest.
    director.once(Director.EVENT_BEFORE_UPDATE, start);
}

export { systemRegistry };
