/**
 * Bundles each tests/*.test.ts with esbuild and runs it with node.
 *
 *   node tests/run.js            all tests
 *   node tests/run.js core       only files containing "core"
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });
const filter = process.argv[2] || '';

let failed = false;
for (const file of fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.ts') && f.includes(filter))) {
    const bundle = path.join(out, file.replace(/\.ts$/, '.js'));
    esbuild.buildSync({
        absWorkingDir: root,
        entryPoints: [path.join('tests', file)],
        outfile: bundle,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node16',
        sourcemap: 'inline',
        logLevel: 'warning',
        // The engine is replaced by small stubs (tests/stubs).
        alias: { 'cc/env': './tests/stubs/cc-env.ts' },
        external: ['cc'],
    });
    console.log(`\n# ${file}`);
    const r = spawnSync(process.execPath, ['--enable-source-maps', bundle], { stdio: 'inherit' });
    if (r.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;

