// Browser stand-in for 'cc' (the debug agent only uses the director).
export const Director = { EVENT_AFTER_UPDATE: 'after-update', EVENT_BEFORE_UPDATE: 'before-update' };
export const director = { on() {}, off() {}, once() {} };
