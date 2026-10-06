import {
  NODE_KINDS,
  allNodes,
  createBuilder,
  type IrNode,
  type NodeKind,
  type Program,
} from '@textscript/core';
import { kitchenSink, said, workedExample } from '@textscript/core/testing';
import { describe, expect, it } from 'vitest';
import { INDENT_UNIT, nodeAtOffset, render, textOf, type RenderResult } from '../src';

const S = said(0);

function only(root: IrNode, kind: NodeKind): IrNode {
  const matches = allNodes(root).filter((node) => node.kind === kind);
  const [match] = matches;
  if (match === undefined || matches.length !== 1) {
    throw new Error(`expected one ${kind}, found ${String(matches.length)}`);
  }
  return match;
}

function lineTexts(result: RenderResult): string[] {
  return result.lines.map((line) => line.map((token) => token.text).join(''));
}

describe('render', () => {
  it('defaults to export mode', () => {
    const program = workedExample().program;
    expect(render(program).mode).toBe('export');
    expect(render(program)).toEqual(render(program, { mode: 'export' }));
  });

  it('is deterministic', () => {
    const program = kitchenSink().program;
    expect(render(program)).toEqual(render(program));
  });

  it('renders an empty program as empty text', () => {
    const b = createBuilder();
    const program = b.program([]);
    const result = render(program);
    expect(result.text).toBe('');
    expect(result.lines).toEqual([]);
    expect(result.sourceMap.nodes.get(program.id)).toEqual({
      start: { line: 0, column: 0, offset: 0 },
      end: { line: 0, column: 0, offset: 0 },
    });
  });

  describe.each(['export', 'ui'] as const)('in %s mode', (mode) => {
    const program = kitchenSink().program;
    const result = render(program, { mode });

    it('builds the text from the tokens', () => {
      expect(
        lineTexts(result)
          .map((line) => line + '\n')
          .join(''),
      ).toBe(result.text);
    });

    it('maps every node, of every kind', () => {
      const nodes = allNodes(program);
      expect(new Set(nodes.map((node) => node.kind))).toEqual(new Set(NODE_KINDS));
      for (const node of nodes) expect(result.sourceMap.nodes.has(node.id)).toBe(true);
    });

    it('maps every note to its comment line', () => {
      const notes = allNodes(program).flatMap((node) => node.notes ?? []);
      expect(notes.length).toBeGreaterThan(0);
      for (const note of notes) {
        const range = result.sourceMap.notes.get(note.id);
        expect(range && result.text.slice(range.start.offset, range.end.offset)).toBe(
          `# Complexity: ${note.text}`,
        );
      }
    });

    it('gives the program the whole text', () => {
      expect(textOf(result, program.id)).toBe(result.text);
    });

    it('keeps line, column and offset consistent', () => {
      const lineStarts = [0];
      for (const line of lineTexts(result))
        lineStarts.push((lineStarts.at(-1) ?? 0) + line.length + 1);
      for (const range of result.sourceMap.nodes.values()) {
        for (const position of [range.start, range.end]) {
          expect(position.offset).toBe((lineStarts[position.line] ?? NaN) + position.column);
        }
      }
    });
  });
});

describe('tokens', () => {
  const program = workedExample().program;
  const result = render(program);

  it('indent nested lines with one indent token per line', () => {
    const returnLine = result.lines.find((line) => line.some((token) => token.text === 'return'));
    expect(returnLine?.[0]).toEqual({ kind: 'indent', text: INDENT_UNIT.repeat(2) });
  });

  it('carry the innermost node that produced them', () => {
    const membership = only(program, 'Membership');
    const inToken = result.lines
      .flat()
      .find((token) => token.text === 'in' && token.nodeId === membership.id);
    expect(inToken).toEqual({ kind: 'keyword', text: 'in', nodeId: membership.id });
  });

  it('mark holes and note comments', () => {
    const b = createBuilder();
    const hole = b.condHole('it is valid');
    const note = b.note('runs once', 'general', S.provenance ?? []);
    const stmt = b.while({ cond: hole, body: b.block([b.break(S)]) }, { ...S, notes: [note] });
    const tokens = render(b.program([stmt]), { mode: 'ui' }).lines.flat();

    expect(tokens).toContainEqual({ kind: 'hole', text: '⟨it is valid⟩', nodeId: hole.id });
    expect(tokens.find((token) => token.kind === 'comment')).toMatchObject({
      text: '# runs once',
      noteId: note.id,
    });
  });
});

describe('source map', () => {
  it('excludes the parentheses a parent adds', () => {
    const b = createBuilder();
    const sum = b.binOp({ op: '+', left: b.name('a', S), right: b.name('b', S) }, S);
    const product = b.binOp({ op: '*', left: sum, right: b.name('c', S) }, S);
    const result = render(b.program([b.exprStmt(product, S)]));
    expect(result.text).toBe('(a + b) * c\n');
    expect(textOf(result, sum.id)).toBe('a + b');
    expect(textOf(result, product.id)).toBe('(a + b) * c');
  });

  it('covers a compound statement through the end of its block', () => {
    const program = workedExample().program;
    const result = render(program);
    const loop = only(program, 'ForEach');
    expect(textOf(result, loop.id)).toBe(
      [
        'for num in nums:',
        '    if num in seen:',
        '        return True',
        '    else:',
        '        seen.add(num)',
      ].join('\n'),
    );
  });

  it('covers trailing TODO comments of the statement they belong to', () => {
    const b = createBuilder();
    const stmt = b.assign({ target: b.nameHole('unnamed'), value: b.literal(1, S) }, S);
    const result = render(b.program([stmt]));
    expect(textOf(result, stmt.id)).toBe('__hole_n1__ = 1  # TODO(textscript): unnamed');
  });

  it('finds the innermost node at an offset', () => {
    const program = workedExample().program;
    const result = render(program);
    const offset = result.text.indexOf('seen.add') + 1;
    const target = allNodes(program).find(
      (node) =>
        node.kind === 'Name' &&
        node.name === 'seen' &&
        result.sourceMap.nodes.get(node.id)?.start.offset === offset - 1,
    );
    expect(nodeAtOffset(result, offset)).toBe(target?.id);
    expect(nodeAtOffset(result, result.text.length + 5)).toBeUndefined();
  });

  it('returns undefined for unknown nodes', () => {
    expect(textOf(render(workedExample().program), 'n999')).toBeUndefined();
  });
});

describe('modes', () => {
  function both(program: Program) {
    return { exported: render(program).text, ui: render(program, { mode: 'ui' }).text };
  }

  it('differ only where there are holes', () => {
    const { exported, ui } = both(workedExample().program);
    expect(ui).toBe(exported);
  });

  it('render each hole form', () => {
    const b = createBuilder();
    const { exported, ui } = both(
      b.program([
        b.assign({ target: b.nameHole('unnamed'), value: b.exprHole('some value') }, S),
        b.while({ cond: b.name('x', S), body: b.block([b.blockHole('not described')]) }, S),
      ]),
    );
    expect(exported).toBe(
      [
        '__hole_n1__ = __hole__("some value")  # TODO(textscript): unnamed',
        'while x:',
        '    ...  # TODO(textscript): not described',
        '',
      ].join('\n'),
    );
    expect(ui).toBe(['⟨unnamed⟩ = ⟨some value⟩', 'while x:', '    ⟨not described⟩', ''].join('\n'));
  });
});
