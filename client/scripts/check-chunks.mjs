#!/usr/bin/env node
/**
 * Fails if the built JS chunks import each other in a cycle.
 *
 * A cycle between chunks is not a style problem — it ships a white screen.
 * ES modules evaluate in order, so if chunk A imports B and B imports A, one
 * of them runs while the other's exports are still undefined. That is exactly
 * how `chakra-*.js` came to read `useLayoutEffect` off an undefined React in
 * production: manualChunks had produced
 *
 *     react-vendor → vendor → chakra → react-vendor
 *
 * Rollup emits this without warning, and the dev server never sees it because
 * chunking only happens in a production build. So it has to be checked here.
 *
 * Run after `vite build`; reads dist/assets/*.js.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');

if (!existsSync(assets)) {
    console.error(`check:chunks — no build found at ${assets}. Run \`npm run build\` first.`);
    process.exit(1);
}

const files = readdirSync(assets).filter((f) => f.endsWith('.js'));
if (files.length === 0) {
    console.error('check:chunks — no .js chunks in dist/assets.');
    process.exit(1);
}

// STATIC imports only — `import ... from "./x.js"`, bare `import "./x.js"`,
// `export ... from "./x.js"`. Dynamic `import("./x.js")` is deliberately not an
// edge: it is deferred until after the importing chunk has evaluated, so a
// lazy route pointing back at the entry chunk is normal and harmless. Counting
// those would flag every React.lazy route in the app. The distinguishing
// character is the paren straight after `import`, so requiring a quote next
// excludes them.
const graph = new Map(
    files.map((f) => {
        const src = readFileSync(join(assets, f), 'utf8');
        const deps = new Set(
            [...src.matchAll(/(?:\bfrom|\bimport)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => m[1])
        );
        deps.delete(f); // self-reference within a chunk is fine
        return [f, deps];
    })
);

// Depth-first search, reporting the first cycle found as a readable path.
const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map(files.map((f) => [f, WHITE]));
const cycles = [];

const visit = (node, stack) => {
    colour.set(node, GREY);
    stack.push(node);
    for (const dep of graph.get(node) ?? []) {
        if (!graph.has(dep)) continue;
        const c = colour.get(dep);
        if (c === GREY) {
            cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
        } else if (c === WHITE) {
            visit(dep, stack);
        }
    }
    stack.pop();
    colour.set(node, BLACK);
};

for (const f of files) if (colour.get(f) === WHITE) visit(f, []);

const label = (f) => f.replace(/-[A-Za-z0-9_-]{8,}\.js$/, '');

if (cycles.length > 0) {
    console.error(`\ncheck:chunks — FAIL: ${cycles.length} circular chunk dependenc${cycles.length === 1 ? 'y' : 'ies'}.\n`);
    for (const cycle of cycles) console.error(`  ${cycle.map(label).join(' → ')}`);
    console.error('\nThis ships a blank page: one chunk evaluates while another\'s exports');
    console.error('are still undefined. Fix the manualChunks split in vite.config.ts —');
    console.error('see the comment there for why splitting by package name causes this.\n');
    process.exit(1);
}

console.log(`check:chunks — OK, ${files.length} chunks, no cycles:`);
for (const [f, deps] of graph) {
    console.log(`  ${label(f)} → ${[...deps].map(label).join(', ') || '(leaf)'}`);
}
