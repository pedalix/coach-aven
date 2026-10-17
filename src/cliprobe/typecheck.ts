// Checks recorded frames against the SDK's type declarations (design D5) with the TypeScript compiler
// API. It does not hand an object literal to the compiler: assignability stops at the first excess
// property and would hide a missing one behind an extra one. It walks each frame against the declared
// type instead and collects every finding:
//   - candidates: the union members whose literal-typed properties (type, subtype, isReplay, …) the
//     value matches — at the top level and in every nested union;
//   - a required property missing, or a value its declared type does not allow → violation, at a path;
//   - a property the type does not declare (and no index signature covers) → undeclared field;
//   - no top-level candidate → undeclared kind.
// A frame keeps the candidate with the fewest violations (then the fewest undeclared fields).
// Each finding carries its origin: a property declared by the agent SDK itself belongs to the
// protocol; one declared in `@anthropic-ai/sdk` belongs to the API's message model, which the
// protocol's `message`/`usage`/`event` fields import — the CLI's transcript objects are not the
// API's responses field for field, so those are listed, never failed.
import ts from 'typescript';
import { dirname, join } from 'node:path';
import { frameKind, type Finding } from './report.js';
import type { Frame, RecordLine } from './types.js';

/** Where the violated declaration lives: the protocol's own (the agent SDK) or the API message model it imports. */
export type Origin = 'protocol' | 'api';
interface Raw {
  kind: 'violation' | 'undeclared-field';
  path: string;
  detail: string;
  origin: Origin;
}

export interface LoadOptions {
  sdkDts: string;
  /** The declared (unexported) union of everything the CLI writes. */
  outUnion?: string;
  /** What a host writes. */
  inTypes?: readonly string[];
  /** node_modules/@types of a checkout, for `crypto`'s UUID. */
  typeRoots?: readonly string[];
}

export interface FrameChecker {
  check(frame: Frame, dir: 'out' | 'in'): { kind: string; findings: Raw[]; undeclaredKind: boolean };
}

const MAX_DEPTH = 40;
const short = (s: string): string => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

export function loadChecker(o: LoadOptions): FrameChecker {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
    typeRoots: [...(o.typeRoots ?? [join(process.cwd(), 'node_modules', '@types')])],
  };
  const program = ts.createProgram([o.sdkDts], options);
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(o.sdkDts);
  if (!sf) throw new Error(`cannot read ${o.sdkDts}`);
  const aliasType = (name: string): ts.Type => {
    for (const st of sf.statements) {
      if ((ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) && st.name.text === name) return checker.getTypeAtLocation(st.name);
    }
    throw new Error(`${name} is not declared in ${o.sdkDts} (${dirname(o.sdkDts)})`);
  };
  const members = (t: ts.Type): ts.Type[] => (t.isUnion() ? t.types : [t]);
  const outMembers = members(aliasType(o.outUnion ?? 'StdoutMessage'));
  const inMembers = (o.inTypes ?? ['SDKUserMessage', 'SDKControlRequest', 'SDKControlResponse', 'SDKControlCancelRequest']).flatMap((n) => members(aliasType(n)));
  const str = (t: ts.Type): string => short(checker.typeToString(t));

  // The literal values a type admits, or undefined when it is not (only) literals.
  const literals = (t: ts.Type): unknown[] | undefined => {
    const ms = t.isUnion() ? t.types : [t];
    const vals: unknown[] = [];
    for (const m of ms) {
      if (m.flags & ts.TypeFlags.Undefined) continue;
      if (m.isStringLiteral() || m.isNumberLiteral()) vals.push(m.value);
      else if (m.flags & ts.TypeFlags.BooleanLiteral) vals.push((m as unknown as { intrinsicName: string }).intrinsicName === 'true');
      else return undefined;
    }
    return vals.length ? vals : undefined;
  };
  // Would `t` exclude this object value by one of its literal-typed properties?
  const excludedBy = (t: ts.Type, v: Record<string, unknown>): boolean => {
    for (const p of checker.getPropertiesOfType(t)) {
      if (!(p.name in v)) continue;
      const lits = literals(checker.getTypeOfSymbol(p));
      if (lits && !lits.includes(v[p.name])) return true;
    }
    return false;
  };
  const score = (fs: Raw[]): [number, number] => [fs.filter((f) => f.kind === 'violation').length, fs.length];
  const best = (all: Raw[][]): Raw[] =>
    all.reduce((a, b) => {
      const [va, ta] = score(a);
      const [vb, tb] = score(b);
      return vb < va || (vb === va && tb < ta) ? b : a;
    });
  const originOf = (p: ts.Symbol, fallback: Origin): Origin => {
    const file = p.declarations?.[0]?.getSourceFile().fileName ?? '';
    if (/[\\/]@anthropic-ai[\\/]sdk[\\/]/.test(file)) return 'api';
    if (/[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]/.test(file) || file === o.sdkDts) return 'protocol';
    return fallback;
  };

  const PRIMITIVE = ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.BigIntLike;
  const isArrayLike = (m: ts.Type): boolean => checker.isArrayType(m) || checker.isTupleType(m);
  // Does a union member have the same kind of value at all (array / object / string / …)?
  const kindFits = (v: unknown, m: ts.Type): boolean => {
    const mf = m.flags;
    if (mf & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
    if (m.isIntersection()) return m.types.some((part) => kindFits(v, part));
    if (v === null) return (mf & ts.TypeFlags.Null) !== 0;
    if (typeof v === 'string') return (mf & ts.TypeFlags.StringLike) !== 0;
    if (typeof v === 'number') return (mf & (ts.TypeFlags.NumberLike | ts.TypeFlags.Enum)) !== 0;
    if (typeof v === 'boolean') return (mf & ts.TypeFlags.BooleanLike) !== 0;
    if (mf & PRIMITIVE) return false;
    return Array.isArray(v) ? isArrayLike(m) || checker.getIndexInfosOfType(m).some((i) => i.keyType.flags & ts.TypeFlags.Number) : !isArrayLike(m);
  };

  const walk = (v: unknown, t: ts.Type, path: string, depth: number, origin: Origin): Raw[] => {
    const violation = (at: string, detail: string): Raw[] => [{ kind: 'violation', path: at, detail, origin }];
    if (depth > MAX_DEPTH) return [];
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return []; // unresolved imports read as any
    if (t.isUnion()) {
      let ms = t.types.filter((m) => kindFits(v, m));
      if (!ms.length) ms = t.types;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const kept = ms.filter((m) => !excludedBy(m, v as Record<string, unknown>));
        if (kept.length) ms = kept;
      }
      const results: Raw[][] = [];
      for (const m of ms) {
        const r = walk(v, m, path, depth + 1, origin);
        if (!r.length) return [];
        results.push(r);
      }
      return best(results);
    }
    // `string & {}` (an open string union kept for autocompletion) and similar: a primitive value
    // fits when one of the intersected parts is its primitive.
    if (t.isIntersection() && (v === null || typeof v !== 'object')) {
      return t.types.some((part) => part.flags & PRIMITIVE && !walk(v, part, path, depth + 1, origin).length) ? [] : violation(path, `${JSON.stringify(v)} where ${str(t)} is declared`);
    }
    if (v === null) return f & ts.TypeFlags.Null ? [] : violation(path, `null where ${str(t)} is declared`);
    if (typeof v === 'string') {
      if (f & ts.TypeFlags.String) return [];
      if (t.isStringLiteral()) return t.value === v ? [] : violation(path, `${JSON.stringify(short(v))} where ${str(t)} is declared`);
      if (f & (ts.TypeFlags.TemplateLiteral | ts.TypeFlags.StringMapping)) {
        return checker.isTypeAssignableTo(checker.getStringLiteralType(v), t) ? [] : violation(path, `${JSON.stringify(short(v))} does not fit ${str(t)}`);
      }
      return violation(path, `a string where ${str(t)} is declared`);
    }
    if (typeof v === 'number') {
      if (f & (ts.TypeFlags.Number | ts.TypeFlags.Enum)) return [];
      if (t.isNumberLiteral()) return t.value === v ? [] : violation(path, `${v} where ${str(t)} is declared`);
      return violation(path, `a number where ${str(t)} is declared`);
    }
    if (typeof v === 'boolean') {
      if (f & ts.TypeFlags.Boolean) return [];
      if (f & ts.TypeFlags.BooleanLiteral) {
        const lit = (t as unknown as { intrinsicName: string }).intrinsicName === 'true';
        return lit === v ? [] : violation(path, `${v} where ${str(t)} is declared`);
      }
      return violation(path, `a boolean where ${str(t)} is declared`);
    }
    if (Array.isArray(v)) {
      if (f & PRIMITIVE) return violation(path, `an array where ${str(t)} is declared`);
      if (checker.isTupleType(t)) {
        const els = checker.getTypeArguments(t as ts.TypeReference);
        return v.flatMap((x, i) => (els[i] ? walk(x, els[i]!, `${path}[${i}]`, depth + 1, origin) : violation(`${path}[${i}]`, 'beyond the declared tuple')));
      }
      if (checker.isArrayType(t)) {
        const el = checker.getTypeArguments(t as ts.TypeReference)[0];
        return el ? v.flatMap((x, i) => walk(x, el, `${path}[${i}]`, depth + 1, origin)) : [];
      }
      const idx = checker.getIndexInfosOfType(t).find((i) => i.keyType.flags & ts.TypeFlags.Number);
      if (idx) return v.flatMap((x, i) => walk(x, idx.type, `${path}[${i}]`, depth + 1, origin));
      return violation(path, `an array where ${str(t)} is declared`);
    }
    if (typeof v === 'object') {
      if (f & PRIMITIVE) return violation(path, `an object where ${str(t)} is declared`);
      const obj = v as Record<string, unknown>;
      const out: Raw[] = [];
      const props = checker.getPropertiesOfType(t);
      const declared = new Set<string>();
      // An object type's own origin: where its first property is declared (the API model or the protocol).
      const here = props[0] ? originOf(props[0], origin) : origin;
      for (const p of props) {
        declared.add(p.name);
        const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
        const po = originOf(p, origin);
        if (p.name in obj) out.push(...walk(obj[p.name], checker.getTypeOfSymbol(p), `${path}.${p.name}`, depth + 1, po));
        else if (!optional) out.push({ kind: 'violation', path: `${path}.${p.name}`, detail: 'required, missing', origin: po });
      }
      const stringIndex = checker.getIndexInfosOfType(t).find((i) => i.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral));
      for (const k of Object.keys(obj)) {
        if (declared.has(k)) continue;
        if (stringIndex) out.push(...walk(obj[k], stringIndex.type, `${path}.${k}`, depth + 1, here));
        else out.push({ kind: 'undeclared-field', path: `${path}.${k}`, detail: 'not declared', origin: here });
      }
      return out;
    }
    return [];
  };

  return {
    check(frame, dir) {
      const kind = frameKind(frame);
      const candidates = (dir === 'out' ? outMembers : inMembers).filter((m) => !excludedBy(m, frame));
      if (!candidates.length) return { kind, findings: [], undeclaredKind: true };
      const results: Raw[][] = [];
      for (const m of candidates) {
        const r = walk(frame, m, '$', 0, 'protocol');
        if (!r.length) return { kind, findings: [], undeclaredKind: false };
        results.push(r);
      }
      return { kind, findings: best(results), undeclaredKind: false };
    },
  };
}

/** Every finding across recordings, frames numbered by their 1-based line in the recording file. */
export function checkRecordings(checker: FrameChecker, recordings: { file: string; lines: readonly RecordLine[] }[]): Finding[] {
  const out: Finding[] = [];
  for (const { file, lines } of recordings) {
    lines.forEach((l, i) => {
      if (!('frame' in l) || l.dir === 'echo') return; // a transport's copy of stdin is nobody's frame
      const r = checker.check(l.frame, l.dir);
      if (r.undeclaredKind) {
        out.push({ dir: l.dir, file, line: i + 1, kind: 'undeclared-kind', frameKind: r.kind, path: '$', detail: 'no declared kind matches its literal fields', origin: 'protocol' });
      }
      for (const f of r.findings) out.push({ dir: l.dir, file, line: i + 1, kind: f.kind, frameKind: r.kind, path: f.path, detail: f.detail, origin: f.origin });
    });
  }
  return out;
}
