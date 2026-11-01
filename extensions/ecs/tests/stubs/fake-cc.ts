/**
 * Minimal 'cc' for tests of modules that only touch the director (the debug
 * agent). Import this first: imports run in order.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
const load = Module._load;
export const fakeCC = {
    Director: { EVENT_AFTER_UPDATE: 'after-update', EVENT_BEFORE_UPDATE: 'before-update' },
    director: { on() {}, off() {}, once() {} },
};
Module._load = function (request: string, ...rest: any[]) {
    if (request === 'cc') return fakeCC;
    return load.call(this, request, ...rest);
};
