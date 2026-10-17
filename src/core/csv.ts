/**
 * RFC 4180 CSV utilities (Req 12.10).
 *
 * Pure and standalone: no Node, Express, React, or domain-type imports.
 *
 * - `csvEscape` encloses a field in double quotes when it contains a comma,
 *   a double quote, CR, or LF, and doubles every embedded double quote.
 * - `csvRecord` joins escaped fields with commas (no record terminator).
 * - `parseCsv` is a state-machine parser that accepts quoted and unquoted
 *   fields, doubled-quote escapes, and CRLF or LF record terminators.
 *   It throws `CsvParseError` on malformed input.
 */

export const CSV_RECORD_SEPARATOR = '\r\n';

const NEEDS_QUOTING = /[",\r\n]/;

/** Escape a single field per RFC 4180. */
export function csvEscape(field: string): string {
  if (!NEEDS_QUOTING.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/** Build one CSV record (without the trailing CRLF) from raw field values. */
export function csvRecord(fields: readonly string[]): string {
  return fields.map(csvEscape).join(',');
}

export class CsvParseError extends Error {
  readonly position: number;
  constructor(message: string, position: number) {
    super(`${message} at position ${position}`);
    this.name = 'CsvParseError';
    this.position = position;
  }
}

type State =
  | 'FIELD_START' // at the start of a field
  | 'UNQUOTED' // inside an unquoted field
  | 'QUOTED' // inside a quoted field
  | 'QUOTE_IN_QUOTED'; // just read a '"' inside a quoted field (escape or closing quote)

/**
 * Parse CSV text into records of fields.
 *
 * Rules:
 * - Records end with CRLF or LF. A single trailing terminator at end of input
 *   does not produce an extra empty record.
 * - Empty input returns `[]`. A record consisting of one empty field must
 *   therefore be followed by a terminator (e.g. `"\r\n"` → `[[""]]`).
 * - Inside quoted fields, commas, CR, LF, and doubled quotes (`""`) are literal.
 *
 * Throws `CsvParseError` for:
 * - an unterminated quoted field,
 * - a `"` inside an unquoted field,
 * - any character other than `,`, CR, LF, or end of input after a closing quote,
 * - a bare CR not followed by LF outside a quoted field.
 */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let state: State = 'FIELD_START';
  let i = 0;
  const n = text.length;

  const endField = (): void => {
    record.push(field);
    field = '';
  };
  const endRecord = (): void => {
    endField();
    records.push(record);
    record = [];
  };
  /** Handle CR/LF at index i outside a quoted field; returns chars consumed. */
  const consumeTerminator = (pos: number): number => {
    const c = text[pos];
    if (c === '\n') return 1;
    // c === '\r'
    if (text[pos + 1] === '\n') return 2;
    throw new CsvParseError('Bare CR without LF', pos);
  };

  while (i < n) {
    const c = text[i]!;
    switch (state) {
      case 'FIELD_START':
        if (c === '"') {
          state = 'QUOTED';
          i += 1;
        } else if (c === ',') {
          endField();
          i += 1;
        } else if (c === '\r' || c === '\n') {
          i += consumeTerminator(i);
          endRecord();
        } else {
          field += c;
          state = 'UNQUOTED';
          i += 1;
        }
        break;

      case 'UNQUOTED':
        if (c === ',') {
          endField();
          state = 'FIELD_START';
          i += 1;
        } else if (c === '\r' || c === '\n') {
          i += consumeTerminator(i);
          endRecord();
          state = 'FIELD_START';
        } else if (c === '"') {
          throw new CsvParseError('Unexpected quote in unquoted field', i);
        } else {
          field += c;
          i += 1;
        }
        break;

      case 'QUOTED':
        if (c === '"') {
          state = 'QUOTE_IN_QUOTED';
        } else {
          field += c;
        }
        i += 1;
        break;

      case 'QUOTE_IN_QUOTED':
        if (c === '"') {
          field += '"';
          state = 'QUOTED';
          i += 1;
        } else if (c === ',') {
          endField();
          state = 'FIELD_START';
          i += 1;
        } else if (c === '\r' || c === '\n') {
          i += consumeTerminator(i);
          endRecord();
          state = 'FIELD_START';
        } else {
          throw new CsvParseError('Unexpected character after closing quote', i);
        }
        break;
    }
  }

  // End of input.
  if (state === 'QUOTED') {
    throw new CsvParseError('Unterminated quoted field', n);
  }
  // Emit the final record unless input was empty or ended with a terminator
  // (FIELD_START with nothing pending in the current record).
  if (state !== 'FIELD_START' || record.length > 0) {
    endRecord();
  }
  return records;
}
