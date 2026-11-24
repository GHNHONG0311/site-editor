// Run: node --test apps/local/lib/*.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyReplace, findMatches } from './source-edit.js';

function site(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'se-'));
    for (const [f, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
        fs.writeFileSync(path.join(root, f), c);
    }
    return root;
}

test('JSX text spread over lines is found and replaced', () => {
    const root = site({ 'app/page.tsx': '<h1>\n  Fresh   bread\n  daily\n</h1>', 'node_modules/x.js': 'Fresh bread daily' });
    const m = findMatches(root, 'Fresh bread daily');
    assert.equal(m.length, 1);
    applyReplace(root, m, 0, 'Cakes {today}');
    assert.equal(fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8'), "<h1>\n  Cakes {'{'}today{'}'}\n</h1>");
});

test('text inside a string literal escapes its quote', () => {
    const root = site({ 'lib/data.ts': "export const name = 'Seed Pastry';" });
    const m = findMatches(root, 'Seed Pastry');
    applyReplace(root, m, 0, "Mai's Bakery");
    assert.equal(fs.readFileSync(path.join(root, 'lib/data.ts'), 'utf8'), "export const name = 'Mai\\'s Bakery';");
});

test('an apostrophe in JSX text is not taken for a string', () => {
    const root = site({ 'a.tsx': "<p>Don't worry, be happy</p>" });
    applyReplace(root, findMatches(root, 'be happy'), 0, 'it\'s "fine"');
    assert.equal(fs.readFileSync(path.join(root, 'a.tsx'), 'utf8'), '<p>Don\'t worry, it\'s "fine"</p>');
});

test('several matches: one or all, and undo data restores', () => {
    const root = site({ 'a.tsx': '<b>Hi</b><i>Hi</i>', 'b.html': '<p>Hi</p>' });
    const m = findMatches(root, 'Hi');
    assert.equal(m.length, 3);
    const undo = applyReplace(root, m, 'all', 'Yo');
    assert.equal(fs.readFileSync(path.join(root, 'a.tsx'), 'utf8'), '<b>Yo</b><i>Yo</i>');
    for (const u of undo) fs.writeFileSync(path.join(root, u.file), u.before);
    assert.equal(fs.readFileSync(path.join(root, 'b.html'), 'utf8'), '<p>Hi</p>');
});

test('HTML files get HTML-escaped text', () => {
    const root = site({ 'index.html': '<p>We bake\n  bread.</p>' });
    applyReplace(root, findMatches(root, 'We bake bread.'), 0, 'Cakes & <pies>');
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), '<p>Cakes &amp; &lt;pies&gt;</p>');
});

test('whole-value matches come first and are marked', () => {
    const root = site({ 'a.tsx': "const d = 'Miri 麦子屋 shop'; const n = '麦子屋';", 'README.md': '麦子屋' });
    const m = findMatches(root, '麦子屋');
    assert.equal(m.length, 2);
    assert.deepEqual(m.map((x) => x.whole), [true, false]);
});
