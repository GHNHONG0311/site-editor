import assert from 'node:assert/strict';
import test from 'node:test';
import { allElements, children, deleteElement, duplicateElement, elementAt, moveElement, setStyles } from './markup.js';

const JSX = `import Link from 'next/link';
export default function Home({ items }: { items: string[] }) {
  const n = items.length < 3 ? 'few' : "many";
  return (
    <main className="wrap">
      <h1>Don't {n} <span>shop</span></h1>
      <Link className="btn" href={\`/x/\${n}\`}>Order</Link>
      {items.map((t) => <p key={t}>{t}</p>)}
      <img src="/a.png" alt="" />
    </main>
  );
}
`;

test('finds JSX elements and their ends', () => {
    const names = allElements(JSX).map((e) => e.name);
    assert.deepEqual(names, ['main', 'h1', 'span', 'Link', 'p', 'img']);
    const h1 = elementAt(JSX, JSX.indexOf('<h1'));
    assert.equal(JSX.slice(h1.start, h1.end), "<h1>Don't {n} <span>shop</span></h1>");
});

test('delete, duplicate and move keep the rest intact', () => {
    const link = elementAt(JSX, JSX.indexOf('<Link'));
    assert.ok(!deleteElement(JSX, link).includes('Order'));
    assert.equal(duplicateElement(JSX, link).split('>Order</Link>').length, 3);
    const up = moveElement(JSX, link, -1);
    assert.ok(up.indexOf('<Link') < up.indexOf('<h1'));
    const img = elementAt(JSX, JSX.indexOf('<img'));
    assert.equal(moveElement(JSX, img, 1), null);
});

test('inline styles merge in JSX and HTML', () => {
    const h1 = elementAt(JSX, JSX.indexOf('<h1'));
    const a = setStyles(JSX, h1, { color: '#f00', fontSize: '20px' });
    assert.ok(a.includes("<h1 style={{ color: '#f00', fontSize: '20px' }}>"));
    const b = setStyles(a, elementAt(a, a.indexOf('<h1')), { color: '' });
    assert.ok(b.includes("<h1 style={{ fontSize: '20px' }}>"));
    const html = '<body><p class="x" style="margin: 0">Hi</p><br><img src="a"></body>';
    const els = allElements(html, true);
    assert.deepEqual(els.map((e) => e.name), ['body', 'p', 'br', 'img']);
    const p = setStyles(html, els[1], { color: 'red' }, true);
    assert.ok(p.includes('<p class="x" style="margin: 0; color: red">'));
});

test('html: an unclosed tag ends at its parent\'s closing tag', () => {
    const src = '<body><h1>Hi</h1><p>Cakes & <bread></p><img src="a.png"></body>';
    const body = allElements(src, true).find((e) => e.name === 'body');
    const kids = children(src, body, true).map((e) => src.slice(e.start, e.end));
    assert.deepEqual(kids, ['<h1>Hi</h1>', '<p>Cakes & <bread></p>', '<img src="a.png">']);
    const moved = moveElement(src, children(src, body, true)[0], 1, true);
    assert.equal(moved, '<body><p>Cakes & <bread></p><h1>Hi</h1><img src="a.png"></body>');
});
