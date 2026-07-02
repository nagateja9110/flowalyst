export function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const shown = rows.slice(0, 50);
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900 text-left text-zinc-400">
          <tr>
            {columns.map((c) => (
              <th key={c} className="px-3 py-2 font-medium whitespace-nowrap">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} className="border-t border-zinc-800/60 hover:bg-zinc-900/50">
              {columns.map((c) => (
                <td key={c} className="px-3 py-1.5 whitespace-nowrap text-zinc-200">{String(row[c] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && (
        <div className="px-3 py-1.5 text-xs text-zinc-500 bg-zinc-900/50">
          Showing {shown.length} of {rows.length} rows
        </div>
      )}
    </div>
  );
}
