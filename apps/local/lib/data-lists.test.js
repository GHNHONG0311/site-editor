import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { editTable, listTables } from './data-lists.js';

const SRC = `export type P = { name: string; price: number | null }[];
export const ITEMS: { name: string; price: number | null }[] = [
  { name: 'Cake', price: null, sample: true }, // first
  { name: "Bun's", price: 3 },
];
const LINKS = [
  ['/', 'Home'],
  ['/a', 'About'],
];
export const fmt = (n: number) => \`RM \${n}\`;
`;

function site() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'lib/data.ts'), SRC);
    return root;
}
const read = (root) => fs.readFileSync(path.join(root, 'lib/data.ts'), 'utf8');
const table = (root, label) => listTables(root).find((t) => t.label === label);

test('finds object and tuple tables', () => {
    const root = site();
    const items = table(root, 'ITEMS');
    assert.deepEqual(items.columns, ['name', 'price', 'sample']);
    assert.deepEqual(items.types, { name: 'string', price: 'number', sample: 'boolean' });
    assert.deepEqual(items.rows.map((r) => r.cells), [{ name: 'Cake', price: '', sample: 'true' }, { name: "Bun's", price: '3' }]);
    assert.deepEqual(table(root, 'LINKS').rows[1].cells, { 1: '/a', 2: 'About' });
});

test('edits cells, keeps numbers as numbers, adds missing properties', () => {
    const root = site();
    let t = table(root, 'ITEMS');
    editTable(root, { file: t.file, table: t.start, row: t.rows[0].start, op: 'set', key: 'name', value: "Mum's cake" });
    t = table(root, 'ITEMS');
    editTable(root, { file: t.file, table: t.start, row: t.rows[0].start, op: 'set', key: 'price', value: '12.5' });
    t = table(root, 'ITEMS');
    assert.throws(() => editTable(root, { file: t.file, table: t.start, row: t.rows[1].start, op: 'set', key: 'price', value: 'abc' }), /数字/);
    editTable(root, { file: t.file, table: t.start, row: t.rows[1].start, op: 'set', key: 'sample', value: 'false' });
    assert.match(read(root), /\{ name: 'Mum\\'s cake', price: 12\.5, sample: true \}, \/\/ first/);
    assert.match(read(root), /\{ name: "Bun's", price: 3, sample: false \},/);
});

test('duplicates and deletes rows, with undo data', () => {
    const root = site();
    let t = table(root, 'LINKS');
    editTable(root, { file: t.file, table: t.start, row: t.rows[1].start, op: 'duplicate' });
    assert.equal(table(root, 'LINKS').rows.length, 3);
    t = table(root, 'ITEMS');
    const { before } = editTable(root, { file: t.file, table: t.start, row: t.rows[0].start, op: 'delete' });
    assert.equal(before, SRC.replace("  ['/a', 'About'],\n", "  ['/a', 'About'],\n  ['/a', 'About'],\n").replace("['/a', 'About'],\n  ['/a', 'About'],", "['/a', 'About'],\n  ['/a', 'About'],"));
    assert.match(read(root), /= \[\n  \{ name: "Bun's", price: 3 \},\n\];/);
    t = table(root, 'ITEMS');
    editTable(root, { file: t.file, table: t.start, row: t.rows[0].start, op: 'delete' });
    assert.match(read(root), /\[\] = \[\n\];/);
});
