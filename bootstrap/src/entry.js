import { installBootstrap } from './installBootstrap.js';
installBootstrap(globalThis);
console.log('LANREMOTE_BOOT', new Date().toISOString());
