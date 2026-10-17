// Shared bits of the scenarios: frame readers and the scripted prompts. Prompts are synthetic and give
// the model one obvious move; they never ask for anything machine-specific (no date, host or user name),
// so a recording carries nothing the normalizer would have to guess at.
import type { Frame } from '../types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export const blocks = (f: Frame): Any[] => {
  const c = (f as Any).message?.content;
  return Array.isArray(c) ? c : [];
};
/** The tool_use blocks of an assistant frame. */
export const toolUses = (f: Frame): Any[] => (f.type === 'assistant' ? blocks(f).filter((b) => b?.type === 'tool_use') : []);
/** The text of a tool_result block (string or blocks). */
export const resultText = (b: Any): string =>
  typeof b?.content === 'string' ? b.content : Array.isArray(b?.content) ? b.content.map((x: Any) => (typeof x?.text === 'string' ? x.text : '')).join('') : '';
/** Every tool_result the CLI wrote back to the model, with its tool_use id. */
export const toolResults = (frames: readonly Frame[]): { id: string; text: string }[] =>
  frames.flatMap((f) => (f.type === 'user' && !(f as Any).isReplay ? blocks(f).filter((b) => b?.type === 'tool_result').map((b) => ({ id: String(b.tool_use_id), text: resultText(b) })) : []));
/** A frame's top-level kind, for the observations. */
export const kindOf = (f: Frame): string => `${String(f.type)}${typeof f.subtype === 'string' ? `/${f.subtype}` : ''}`;
export const resultTextOf = (f: Frame | undefined): string => (typeof (f as Any)?.result === 'string' ? (f as Any).result : '');

/** A sequential chain of three slow Bash calls, so a message can be written while a tool runs. */
export const CHAIN =
  'Use the Bash tool three times, strictly one call after another (never in parallel): `sleep 5; echo A1`, then `sleep 5; echo A2`, then `sleep 5; echo A3`. Then reply with the three outputs.';
/** A side question with a checkable answer. */
export const SIDE = (country = 'France'): string => `Side question: what is the capital of ${country}? Answer it in your reply.`;
export const CAPITAL: Record<string, string> = { France: 'Paris', Italy: 'Rome', Spain: 'Madrid', Japan: 'Tokyo' };

/** Where a side answer landed: in which result (1-based), and how many results the run had. */
export function answeredIn(results: readonly Frame[], country: string): { results: number; answeredIn: number; emptyResults: number } {
  const i = results.findIndex((r) => resultTextOf(r).includes(CAPITAL[country]!));
  return { results: results.length, answeredIn: i + 1, emptyResults: results.filter((r) => !resultTextOf(r).trim()).length };
}
