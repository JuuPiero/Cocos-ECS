/**
 * Entities window (Panel > ECS Entities): systems, entities and archetypes
 * of a running game.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { createEntitiesApp, EntitiesApp } from './app';
import { editorBridge } from './bridge';

const CSS = readFileSync(join(__dirname, '../../static/style/panel.css'), 'utf8');

const apps = new WeakMap<object, EntitiesApp>();

module.exports = Editor.Panel.define({
    template: '<div id="app"></div>',
    style: CSS,
    $: { app: '#app' },
    methods: {},
    ready() {
        apps.set(this, createEntitiesApp((this as any).$.app as HTMLElement, editorBridge()));
    },
    close() {
        apps.get(this)?.dispose();
    },
});
