/** Minimal aligned column renderer. */

export function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, index) => {
    let width = header.length;
    for (const row of rows) {
      const cell = row[index] ?? '';
      width = Math.max(width, cell.length);
    }
    return width;
  });

  const renderRow = (cells: readonly string[]): string => {
    const line = cells
      .map((cell, index) => cell.padEnd(widths[index] ?? 0))
      .join('  ')
      .replace(/\s+$/, '');
    return line;
  };

  return [renderRow(headers), ...rows.map(renderRow)].join('\n');
}
