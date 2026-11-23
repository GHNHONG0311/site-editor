import { describe, expect, it } from 'bun:test';
import { diffMtimes } from '../src/providers/polling';

describe('diffMtimes', () => {
    it('reports added, changed and removed files', () => {
        const events = diffMtimes({ a: 1, b: 1, c: 1 }, { a: 1, b: 2, d: 1 });
        expect(events).toEqual([
            { type: 'add', paths: ['d'] },
            { type: 'change', paths: ['b'] },
            { type: 'remove', paths: ['c'] },
        ]);
    });
    it('reports nothing when unchanged', () => {
        expect(diffMtimes({ a: 1 }, { a: 1 })).toEqual([]);
    });
});

