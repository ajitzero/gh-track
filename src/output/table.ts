/** Minimal aligned column renderer with optional styled cells. */

/** A cell whose width is measured from `text` and which is painted on output. */
export interface StyledCell {
  text: string;
  paint: (text: string) => string;
  /** Source segments, kept so narrow tables can cut a cell without losing color. */
  segments?: readonly CellSegment[] | undefined;
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
    segments,
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
  /**
   * Shrink the table to fit this width. Columns are narrowed to at least their
   * header width first; if that is not enough, cells end with an ellipsis.
   * Omitted means unlimited width, so piped output never loses data.
   */
  maxWidth?: number | undefined;
  /** Columns allowed to shrink, in preference order; defaults to every column. */
  flex?: readonly number[] | undefined;
}

/** Shortens text to `width` columns, ending it with an ellipsis when cut. */
export function truncateText(text: string, width: number): string {
  if (width <= 0) {
    return '';
  }
  if (text.length <= width) {
    return text;
  }
  if (width === 1) {
    return '…';
  }
  return `${text.slice(0, width - 1)}…`;
}

function truncateStyled(cell: StyledCell, width: number): StyledCell {
  const segments = cell.segments;
  if (segments === undefined) {
    // A hand-built cell cannot be re-segmented; keep the text and drop its paint.
    return { text: truncateText(cell.text, width), paint: (text) => text };
  }

  const kept: CellSegment[] = [];
  let remaining = width;
  for (const segment of segments) {
    if (remaining <= 0) {
      break;
    }
    if (segment.text.length <= remaining) {
      kept.push(segment);
      remaining -= segment.text.length;
      continue;
    }
    const take = Math.max(0, remaining - 1);
    if (take > 0) {
      kept.push({ ...segment, text: segment.text.slice(0, take) });
    }
    kept.push({ text: '…' });
    remaining = 0;
  }
  return richCell(kept);
}

function fitCell(cell: TableCell, width: number): TableCell {
  if (cellText(cell).length <= width) {
    return cell;
  }
  return typeof cell === 'string' ? truncateText(cell, width) : truncateStyled(cell, width);
}

/** Total printed width of a row, including the two-space separators. */
function rowWidth(widths: readonly number[]): number {
  return widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * 2;
}

/**
 * Narrows the widest flexible columns until the table fits `maxWidth`. The
 * header acts as the soft floor so short values do not squeeze a column below
 * its label; the second pass may go lower and the final render truncates.
 */
function fitWidths(
  widths: number[],
  floors: readonly number[],
  maxWidth: number,
  flex: readonly number[] | undefined,
): void {
  const shrinkable = widths
    .map((_, index) => index)
    .filter((index) => flex === undefined || flex.includes(index));

  for (const floor of [floors, widths.map(() => 1)]) {
    let total = rowWidth(widths);
    while (total > maxWidth) {
      let candidate = -1;
      let widest = -1;
      for (const index of shrinkable) {
        const width = widths[index] ?? 0;
        const limit = floor[index] ?? 1;
        if (width > limit && width > widest) {
          candidate = index;
          widest = width;
        }
      }
      if (candidate < 0) {
        break;
      }
      const width = widths[candidate] ?? 0;
      const limit = floor[candidate] ?? 1;
      const reduce = Math.min(width - limit, total - maxWidth);
      widths[candidate] = width - reduce;
      total -= reduce;
    }
  }
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

  const maxWidth = options.maxWidth;
  if (maxWidth !== undefined) {
    const floors = widths.map((width, index) =>
      Math.min(width, Math.max(cellText(headers[index] ?? '').length, 4)),
    );
    fitWidths(widths, floors, maxWidth, options.flex);
  }

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
      const cell = fitCell(cells[index] ?? '', widths[index] ?? 0);
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
