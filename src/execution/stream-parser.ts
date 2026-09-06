/**
 * NDJSON line assembly over an arbitrarily chunked stream. AGNT-06, D-08.
 *
 * Pure: no I/O and no imports, which is what makes the chunk-boundary bug reproducible
 * in a unit test with no `claude` binary anywhere. A naive
 * `chunk.split("\n").map(JSON.parse)` loses every event whose JSON straddles two chunks,
 * and a real run hits a mid-token boundary inside its first minute.
 */

export interface LineParser {
  /** Feed one stdout chunk. Emits every complete line it now has. */
  push(chunk: string): void;
  /** Emit whatever is left when the stream ends. Safe to call twice. */
  flush(): void;
}

/**
 * A single line this large is not an event; it is a malfunction — a stream that never
 * emits a newline would otherwise grow the carry until the daemon OOMs. 8 MiB is well
 * past any real stream-json line (the largest observed events are low hundreds of KB).
 */
const CARRY_CEILING_BYTES = 8 * 1024 * 1024;

export function makeLineParser(
  onEvent: (event: unknown) => void,
  onBad: (line: string) => void
): LineParser {
  let carry = '';

  function emit(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      onBad(line);
      return;
    }
    onEvent(parsed);
  }

  return {
    push(chunk: string): void {
      carry += chunk;
      let newline = carry.indexOf('\n');
      while (newline >= 0) {
        const line = carry.slice(0, newline);
        carry = carry.slice(newline + 1);
        emit(line);
        newline = carry.indexOf('\n');
      }
      // T-04-21: no newline found and the carry has grown past the ceiling. Report and
      // reset rather than let an unterminated stream grow the buffer without bound.
      if (carry.length > CARRY_CEILING_BYTES) {
        onBad(carry);
        carry = '';
      }
    },
    flush(): void {
      // A no-op on an empty carry, which is what makes a second flush() call safe: the
      // duplicate terminal event a double flush would otherwise emit is the one that
      // makes a run look like it delivered twice.
      if (!carry) return;
      const rest = carry;
      carry = '';
      emit(rest);
    },
  };
}
