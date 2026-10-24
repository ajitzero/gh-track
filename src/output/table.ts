/** Minimal aligned column renderer with optional styled cells. */

/** A cell whose width is measured from `text` and which is painted on output. */
export interface StyledCell {
  text: string;
  paint: (text: string) => string;
}

export type TableCell = string | StyledCell;

/** A segment of a cell, optionally painted independently. */
export interface CellSegment {
  text: string;
  paint?: ((text: string) => string) | undefined;
}

/**
 * Builds a cell from independently styled segments. The table measures the
 * plain text and preserves any padding when painting.
 */
export function richCell(segments: readonly CellSegment[]): StyledCell {
  const plain = segments.map((segment) => segment.text).join('');
  return {
    text: plain,
    paint: (padded) => {
      const painted = segments
        .map((segment) => (segment.paint ?? ((text: string) => text))(segment.text))
        .join('');
      if (plain.length === 0) {
        return padded;
      }
      const start = padded.indexOf(plain);
      if (start < 0) {
        return painted;
      }
      return `${padded.slice(0, start)}${painted}${padded.slice(start + plain.length)}`;
    },
  };
}

function cellText(cell: TableCell): string {
  return typeof cell === 'string' ? cell : cell.text;
}

function paintCell(cell: TableCell, text: string): string {
  return typeof cell === 'string' ? text : cell.paint(text);
}

export type TableAlignment = 'left' | 'right';

export interface TableOptions {
  /** Per-column alignment; defaults to left. */
  align?: readonly TableAlignment[] | undefined;
  /** Per-column header alignment; falls back to `align`. */
  headerAlign?: readonly TableAlignment[] | undefined;
}

export function renderTable(
  headers: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
  options: TableOptions = {},
): string {
  const widths = headers.map((header, index) => {
    let width = cellText(header).length;
    for (const row of rows) {
      const cell = row[index];
      width = Math.max(width, cell === undefined ? 0 : cellText(cell).length);
    }
    return width;
  });

  const renderRow = (cells: readonly TableCell[], header = false): string => {
    let last = cells.length - 1;
    while (last >= 0) {
      const cell = cells[last];
      if (cell !== undefined && cellText(cell).length > 0) {
        break;
      }
      last -= 1;
    }
    if (last < 0) {
      return '';
    }

    const parts: string[] = [];
    const columnAlign = header ? (options.headerAlign ?? options.align) : options.align;
    for (let index = 0; index <= last; index += 1) {
      const cell = cells[index] ?? '';
      const text = cellText(cell);
      const width = widths[index] ?? 0;
      const alignment = columnAlign?.[index] ?? 'left';
      let padded: string;
      if (alignment === 'right') {
        padded = text.padStart(width);
      } else {
        padded = index === last ? text : text.padEnd(width);
      }
      parts.push(paintCell(cell, padded));
    }
    return parts.join('  ');
  };

  return [renderRow(headers, true), ...rows.map((row) => renderRow(row))]
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');
}
