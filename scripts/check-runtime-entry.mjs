import { access } from 'node:fs/promises';
import { constants } from 'node:fs';

const entry = new URL('../dist/src/index.js', import.meta.url);
await access(entry, constants.R_OK);
console.log('runtime entry: PASS');
