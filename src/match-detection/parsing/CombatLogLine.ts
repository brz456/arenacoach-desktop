/**
 * Combat log line parser for WoW TWW format.
 *
 * Parses combat log entries with format: "M/D/YYYY HH:MM:SS.mmmm  EVENT,field1,field2,..."
 * Fields are comma-separated with support for quoted strings and nested structures.
 */
export default class CombatLogLine {
  /**
   * Raw timestamp portion before the double-space separator.
   */
  public readonly rawTimestamp: string;

  /**
   * Original log line for debugging/pass-through.
   */
  public readonly sourceLine: string;

  /**
   * Comma-separated payload after the timestamp.
   */
  private readonly payload: string;

  /**
   * Parsed fields from the payload.
   */
  private readonly fields: any[] = [];

  constructor(line: string) {
    this.sourceLine = line;

    // Split on double-space separator
    const sepIdx = line.indexOf('  ');
    if (sepIdx === -1) {
      this.rawTimestamp = '';
      this.payload = line;
    } else {
      this.rawTimestamp = line.slice(0, sepIdx);
      this.payload = line.slice(sepIdx + 2);
    }

    // Always parse first field (event type)
    this.parseAllFields();
  }

  /**
   * Get field at index. Returns undefined if index out of bounds.
   */
  getField(index: number): any {
    return this.fields[index];
  }

  /**
   * Get the event type (first field).
   */
  getEventType(): string {
    return this.fields[0] ?? '';
  }

  /**
   * Parse timestamp to Date. TWW format: M/D/YYYY HH:MM:SS.mmmm
   */
  getTimestamp(): Date {
    const parts = this.rawTimestamp.match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\.(\d+)/);
    if (!parts) {
      throw new Error(`Invalid timestamp: "${this.rawTimestamp}"`);
    }

    const month = parseInt(parts[1]!, 10);
    const day = parseInt(parts[2]!, 10);
    const year = parseInt(parts[3]!, 10);
    const hour = parseInt(parts[4]!, 10);
    const min = parseInt(parts[5]!, 10);
    const sec = parseInt(parts[6]!, 10);

    // Validate all components are finite numbers and year indicates TWW format
    if (
      !Number.isFinite(month) ||
      !Number.isFinite(day) ||
      !Number.isFinite(year) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(min) ||
      !Number.isFinite(sec) ||
      year < 2000
    ) {
      throw new Error(`Invalid TWW timestamp: "${this.rawTimestamp}"`);
    }

    const date = new Date();
    date.setFullYear(year);
    date.setMonth(month - 1);
    date.setDate(day);
    date.setHours(hour);
    date.setMinutes(min);
    date.setSeconds(sec);
    date.setMilliseconds(0);

    return date;
  }

  /**
   * Parse all fields from payload.
   */
  private parseAllFields(): void {
    let pos = 0;
    const len = this.payload.length;

    while (pos < len) {
      const result = this.parseValue(pos);
      this.fields.push(result.value);
      pos = result.nextPos;

      // Skip comma
      if (pos < len && this.payload[pos] === ',') {
        pos++;
      }
    }
  }

  /**
   * Parse a single value starting at pos.
   * Returns the parsed value and the next position.
   */
  private parseValue(pos: number): { value: any; nextPos: number } {
    const len = this.payload.length;

    // Skip leading whitespace
    while (pos < len && this.payload[pos] === ' ') pos++;

    if (pos >= len) {
      return { value: '', nextPos: pos };
    }

    const ch = this.payload[pos];

    if (ch === '"') {
      return this.parseQuoted(pos);
    }
    if (ch === '[' || ch === '(') {
      return this.parseArray(pos);
    }
    return this.parsePlain(pos);
  }

  /**
   * Parse quoted string: "value" with "" as escaped quote.
   */
  private parseQuoted(pos: number): { value: string; nextPos: number } {
    pos++; // skip opening quote
    let result = '';
    const len = this.payload.length;

    while (pos < len) {
      const ch = this.payload[pos];
      if (ch === '"') {
        pos++;
        if (pos < len && this.payload[pos] === '"') {
          // Escaped quote
          result += '"';
          pos++;
        } else {
          // End of string
          break;
        }
      } else {
        result += ch;
        pos++;
      }
    }

    return { value: result, nextPos: pos };
  }

  /**
   * Parse array/tuple: [...] or (...)
   */
  private parseArray(pos: number): { value: any[]; nextPos: number } {
    const open = this.payload[pos];
    const close = open === '[' ? ']' : ')';
    pos++; // skip opening bracket

    const items: any[] = [];
    const len = this.payload.length;

    while (pos < len) {
      // Skip whitespace
      while (pos < len && this.payload[pos] === ' ') pos++;

      if (pos >= len) {
        throw new Error(`Unclosed ${open}`);
      }

      const ch = this.payload[pos];

      if (ch === close) {
        pos++;
        break;
      }

      if (ch === ',') {
        pos++;
        continue;
      }

      const result = this.parseValue(pos);
      items.push(result.value);
      pos = result.nextPos;

      // Skip comma after value
      while (pos < len && this.payload[pos] === ' ') pos++;
      if (pos < len && this.payload[pos] === ',') {
        pos++;
      }
    }

    return { value: items, nextPos: pos };
  }

  /**
   * Parse plain value (unquoted, not nested).
   */
  private parsePlain(pos: number): { value: string; nextPos: number } {
    let result = '';
    const len = this.payload.length;

    while (pos < len) {
      const ch = this.payload[pos];
      if (ch === ',' || ch === ']' || ch === ')' || ch === '\n') {
        break;
      }
      result += ch;
      pos++;
    }

    return { value: result, nextPos: pos };
  }
}
