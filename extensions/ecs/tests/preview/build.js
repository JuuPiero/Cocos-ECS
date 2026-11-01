/*
 * Builds tests/preview/out/preview.html: the Entities window in a plain page,
 * talking to a real World running in the page through the debug agent.
 *
 *   node tests/preview/build.js
 *   (open out/preview.html, or out/preview.html#interact to run checks)
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, 'out');
fs.mkdirSync(out, { recursive: true });

esbuild.build({
    absWorkingDir: root,
    entryPoints: [path.join(__dirname, 'harness.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2019',
    outfile: path.join(out, 'harness.js'),
    alias: {
        vue: 'vue/dist/vue.esm-bundler.js',
        cc: './tests/preview/fake-cc.ts',
        'cc/env': './tests/stubs/cc-env.ts',
    },
    define: {
        'process.env.NODE_ENV': '"production"',
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    logLevel: 'warning',
}).then(() => {
    const css = fs.readFileSync(path.join(root, 'static', 'style', 'panel.css'), 'utf8');
    fs.writeFileSync(path.join(out, 'preview.html'), `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ECS Entities</title>
<style>
html, body { margin: 0; height: 100%; background: #232323; }
#host { position: relative; width: 820px; height: 520px; }
#result { white-space: pre; font: 12px monospace; padding: 8px; color: #ccc; }
${css}
</style>
</head>
<body>
<div id="host"><div id="app"></div></div>
<script src="harness.js"></script>
</body>
</html>
`);
    console.log('wrote', path.join(out, 'preview.html'));
}).catch(() => process.exit(1));
