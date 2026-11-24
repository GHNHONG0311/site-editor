import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrame } from './locate.js';

test('parses a hot-reloaded server frame with parentheses and a second ? in the query', () => {
    const line = '    at Home (about://React/Server/file:///tmp/s/.next/dev/server/chunks/ssr/%255Broot%255D__1w._.js?id=%255Bproject%255D/app/(site)/page.tsx+%255Bapp-rsc%255D+(ecmascript)?46:34:276)';
    assert.deepEqual(parseFrame(line), ['about://React/Server/file:///tmp/s/.next/dev/server/chunks/ssr/%255Broot%255D__1w._.js?id=%255Bproject%255D/app/(site)/page.tsx+%255Bapp-rsc%255D+(ecmascript)?46', 34, 276]);
});

test('parses a plain client frame', () => {
    assert.deepEqual(parseFrame('at X (http://127.0.0.1:4001/_next/static/chunks/a.js:10:5)'), ['http://127.0.0.1:4001/_next/static/chunks/a.js', 10, 5]);
});
