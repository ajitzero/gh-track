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
    paint: (padded) =>
      segments.map((segment) => (segment.paint ?? ((text: string) => text))(segment.text)).join('') +
      padded.slice(plain.length),
  };
}

function cellText(cell: TableCell): string {
  return typeof cell === 'string' ? cell : cell.text;
}

function paintCell(cell: TableCell, text: string): string {
  return typeof cell === 'string' ? text : cell.paint(text);
}

export function renderTable(
  headers: readonly TableCell[],
  rows: readonly (readonly TableCell[])[],
): string {
  const widths = headers.map((header, index) => {
    let width = cellText(header).length;
    for (const row of rows) {
      const cell = row[index];
      width = Math.max(width, cell === undefined ? 0 : cellText(cell).length);
    }
    return width;
  });

  const renderRow = (cells: readonly TableCell[]): string => {
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
    for (let index = 0; index <= last; index += 1) {
      const cell = cells[index] ?? '';
      const text = cellText(cell);
      const padded = index === last ? text : text.padEnd(widths[index] ?? 0);
      parts.push(paintCell(cell, padded));
    }
    return parts.join('  ');
  };

  return [renderRow(headers), ...rows.map(renderRow)].join('\n');
}
