import { EventEmitter } from 'events';

// Global event emitter for the API process to handle inter-module events
// such as new email arrivals for long-polling (Wait API).
export const globalEvents = new EventEmitter();

// Allow unlimited listeners as each pending Wait API request adds a listener
globalEvents.setMaxListeners(0);
