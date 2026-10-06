import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  IrDocumentSchema,
  allNodes,
  buildSymbolTable,
  deserialize,
  findNode,
  indexTree,
  irDocumentJsonSchema,
  parentOf,
  parseDocument,
  pathTo,
  serialize,
  updateNode,
  type IrDocument,
  type Name,
} from '../src';
import { document } from './arbitraries';

const validateJsonSchema = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(
  irDocumentJsonSchema(),
);

/** A deep copy. Zod builds new objects as it parses, so this never shares structure. */
function clone(doc: IrDocument): IrDocument {
  return IrDocumentSchema.parse(doc);
}

/** Picks an item using a random number, for choosing a node inside a property. */
function pick<T>(items: readonly T[], seed: number): T {
  const item = items[seed % items.length];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

describe('random valid documents', () => {
  it('are valid (sanity check of the generator)', () => {
    fc.assert(
      fc.property(document, (doc) => {
        const result = parseDocument(doc);
        expect(result.ok ? [] : result.issues).toEqual([]);
      }),
    );
  });

  it('survive serialization unchanged', () => {
    fc.assert(
      fc.property(document, (doc) => {
        const text = serialize(doc);
        const result = deserialize(text);
        expect(result).toEqual({ ok: true, document: doc });
        // And writing again gives the same bytes.
        if (result.ok) expect(serialize(result.document)).toBe(text);
      }),
      { numRuns: 200 },
    );
  });

  it('are accepted by the exported JSON Schema', () => {
    fc.assert(
      fc.property(document, (doc) => {
        expect(validateJsonSchema(doc)).toBe(true);
      }),
    );
  });
});

describe('Zod and the JSON Schema agree', () => {
  it('when a random key is removed from a random node', () => {
    fc.assert(
      fc.property(document, fc.nat(), fc.nat(), (doc, nodeSeed, keySeed) => {
        const copy = clone(doc);
        const node = pick(allNodes(copy.program), nodeSeed);
        const key = pick(Object.keys(node), keySeed);
        Reflect.deleteProperty(node, key);
        expect(validateJsonSchema(copy)).toBe(IrDocumentSchema.safeParse(copy).success);
      }),
    );
  });

  it('when a random node is given the wrong kind', () => {
    fc.assert(
      fc.property(
        document,
        fc.nat(),
        fc.constantFrom('Name', 'Block', 'If', 'Bogus'),
        (doc, seed, kind) => {
          const copy = clone(doc);
          Object.assign(pick(allNodes(copy.program), seed), { kind });
          expect(validateJsonSchema(copy)).toBe(IrDocumentSchema.safeParse(copy).success);
        },
      ),
    );
  });
});

describe('tree utilities on random documents', () => {
  it('index, find, path and parent agree with each other', () => {
    fc.assert(
      fc.property(document, (doc) => {
        const nodes = allNodes(doc.program);
        const index = indexTree(doc.program);
        expect(index.size).toBe(nodes.length);
        for (const node of nodes) {
          expect(findNode(doc.program, node.id)).toBe(node);
          expect(pathTo(doc.program, node.id)?.at(-1)).toBe(node);
          expect(parentOf(doc.program, node.id)).toBe(index.get(node.id)?.position?.parent);
        }
      }),
      { numRuns: 50 },
    );
  });

  it('updateNode changes one node, shares everything off its path, and leaves the original intact', () => {
    fc.assert(
      fc.property(document, fc.nat(), (doc, seed) => {
        const nodes = allNodes(doc.program).slice(1); // the root can't be replaced
        fc.pre(nodes.length > 0);
        const target = pick(nodes, seed);
        const before = serialize(doc);

        const program = updateNode(doc.program, target.id, (node) => ({
          ...node,
          label: 'changed',
        }));
        const next: IrDocument = { ...doc, program };

        expect(serialize(doc)).toBe(before);
        expect(findNode(program, target.id)?.label).toBe('changed');
        expect(parseDocument(next).ok).toBe(true);
        const onPath = new Set(pathTo(doc.program, target.id)?.map((node) => node.id));
        for (const node of allNodes(doc.program)) {
          if (!onPath.has(node.id)) expect(findNode(program, node.id)).toBe(node);
        }
      }),
      { numRuns: 50 },
    );
  });
});

describe('symbol table on random documents', () => {
  it('records every Name node exactly once, as a definition or a reference', () => {
    fc.assert(
      fc.property(document, (doc) => {
        const table = buildSymbolTable(doc.program);
        const names = allNodes(doc.program).filter((node): node is Name => node.kind === 'Name');
        const recorded = [
          ...table.references.map((ref) => ref.nodeId),
          ...table.symbols.flatMap((symbol) => symbol.definitions.map((d) => d.nodeId)),
        ];
        expect(recorded.sort()).toEqual(names.map((name) => name.id).sort());
      }),
    );
  });

  it('gives every occurrence a distinct evaluation order', () => {
    fc.assert(
      fc.property(document, (doc) => {
        const table = buildSymbolTable(doc.program);
        const orders = [
          ...table.references.map((ref) => ref.order),
          ...table.symbols.flatMap((symbol) => symbol.definitions.map((d) => d.order)),
        ];
        expect(new Set(orders).size).toBe(orders.length);
      }),
    );
  });
});
