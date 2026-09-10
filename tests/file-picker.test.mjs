import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const source = ts.transpileModule(readFileSync(new URL('../src/FilePicker.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function picker(props) {
  const state = []; let cursor = 0;
  const module = { exports: {} };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; },
    useMemo(fn) { return fn(); }, useEffect() {},
  };
  new Function('require', 'module', 'exports', source)(name => name === 'react' ? hooks : require(name), module, module.exports);
  const render = () => { cursor = 0; return module.exports.FilePicker(props); };
  const drop = files => render().props.onDrop({ preventDefault() {}, dataTransfer: { files } });
  return { render, drop, state };
}
function nodes(node) { return !node || typeof node !== 'object' ? [] : [node, ...[node.props?.children].flat(Infinity).flatMap(nodes)]; }
const png = name => new File(['image'], name, { type: 'image/png', lastModified: 1 });

test('image drop appends all files, deduplicates, supports removal, and disabled drop does nothing', () => {
  const props = { label: '图片', accept: 'image/png', files: [], onFiles(files) { props.files = files; } };
  const view = picker(props), first = png('1.png'), second = png('2.png');
  view.drop([first, second]); assert.equal(props.files.length, 2);
  view.drop([first, png('3.png')]); assert.equal(props.files.length, 3);
  const remove = nodes(view.render()).find(node => node.type === 'button' && node.props['aria-label'].includes('2.png'));
  remove.props.onClick(); assert.deepEqual(props.files.map(file => file.name), ['1.png', '3.png']);
  props.disabled = true; view.drop([png('4.png')]); assert.equal(props.files.length, 2);
});

test('single spreadsheet rejects multiple files, validates type, and accepts file-dialog selection', () => {
  const props = { label: '采购单', accept: '.xlsx,.xls', file: null, onFile(file) { props.file = file; } };
  const view = picker(props), sheet = name => new File(['sheet'], name);
  view.drop([sheet('a.xlsx'), sheet('b.xlsx')]); assert.equal(props.file, null); assert.match(view.state[1], /每次只能/);
  view.drop([png('a.png')]); assert.equal(props.file, null);
  const input = nodes(view.render()).find(node => node.type === 'input');
  input.props.onChange({ target: { files: [sheet('a.xlsx')], value: 'a.xlsx' } }); assert.equal(props.file.name, 'a.xlsx');
});

test('mixed attachment input allows several images but only one document', () => {
  const props = { label: '附件', files: [], onFiles(files) { props.files = files; } };
  const view = picker(props), doc = name => new File(['pdf'], name, { type: 'application/pdf' });
  view.drop([doc('one.pdf'), png('1.png'), png('2.png')]); assert.equal(props.files.length, 3);
  view.drop([doc('two.pdf')]); assert.equal(props.files.length, 3); assert.match(view.state[1], /只能保留一份/);
});
