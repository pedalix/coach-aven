import { StringDecoder } from 'node:string_decoder';

// Incremental UTF-8 decoder for a chunked byte stream (child stdout/stderr, an HTTP request
// body). `Buffer.toString('utf8')` per chunk is WRONG for these: a multibyte character
// straddling a chunk boundary decodes to U+FFFD on BOTH sides, so the text is corrupted and
// one char becomes two. Chunk boundaries are a transport detail (pipe/TCP sized), so this
// fires at random on long output and ASCII-only traffic hides it completely. The ssh-docker
// session stream is claude's NDJSON (Cyrillic, emoji, accented identifiers), and
// `ClaudeSession.open` reattaches by comparing the snapshot's char count against the
// replayed stream — so one split character both mangles the text and shifts that `skip`
// counter, dropping or duplicating output on every reattach afterwards.
// `flush()` at end of stream surfaces a truncated trailing sequence as one U+FFFD instead
// of silently swallowing the bytes held in the decoder.
export function utf8Chunks(): { push(c: Buffer): string; flush(): string } {
  const d = new StringDecoder('utf8');
  return { push: (c) => d.write(c), flush: () => d.end() };
}
