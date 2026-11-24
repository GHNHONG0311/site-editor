import assert from 'node:assert/strict';
import test from 'node:test';
import { varsIn } from './css-vars.js';

test('reads :root and @theme variables with exact value ranges', () => {
    const src = ':root {\n  --color-bg: #FAF6EC; --font-brand: Georgia, serif;\n  --radius: 6px\n}\n.a { --x: 1px; }\n@theme inline { --color-primary: oklch(0.5 0.1 30); }';
    const vars = varsIn(src);
    assert.deepEqual(vars.map((v) => [v.name, v.value, v.kind]), [
        ['--color-bg', '#FAF6EC', 'color'], ['--font-brand', 'Georgia, serif', 'font'], ['--radius', '6px', 'size'], ['--color-primary', 'oklch(0.5 0.1 30)', 'color'],
    ]);
    for (const v of vars) assert.equal(src.slice(v.start, v.end), v.value);
});
