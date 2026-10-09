import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const gui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(gui, '../internal/subscriptiongui/web');
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(resolve(gui, 'out'), target, { recursive: true });
await writeFile(resolve(target, '.keep'), 'Build the Next.js frontend before compiling the Go binary.\n');
console.log('Bundled Next.js export into internal/subscriptiongui/web. Rebuild the Go binary to include it.');
