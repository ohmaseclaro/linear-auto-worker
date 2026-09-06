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
    },
    flush(): void {
      const rest = carry;
      carry = '';
      emit(rest);
    },
  };
}
