import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";

/**
 * Auto-chart heuristic: if the result looks like (category, number) render a
 * bar chart; if the first column parses as a date, render a line chart.
 * Anything else: no chart (the table is always shown).
 */
export function ResultChart({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  if (columns.length < 2 || rows.length < 2 || rows.length > 100) return null;

  const [xKey, yKey] = columns;
  const yIsNumeric = rows.every((r) => r[yKey] !== null && !isNaN(Number(r[yKey])));
  if (!yIsNumeric) return null;

  const data = rows.map((r) => ({ x: String(r[xKey]), y: Number(r[yKey]) }));
  const xIsDate = rows.every((r) => !isNaN(Date.parse(String(r[xKey]))) && isNaN(Number(r[xKey])));

  const Chart = xIsDate ? LineChart : BarChart;
  return (
    <div className="h-64 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <ResponsiveContainer width="100%" height="100%">
        <Chart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
          <XAxis dataKey="x" tick={{ fill: "#a1a1aa", fontSize: 11 }} />
          <YAxis tick={{ fill: "#a1a1aa", fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
            labelStyle={{ color: "#e4e4e7" }}
          />
          {xIsDate ? (
            <Line type="monotone" dataKey="y" name={yKey} stroke="#34d399" strokeWidth={2} dot={false} />
          ) : (
            <Bar dataKey="y" name={yKey} fill="#34d399" radius={[4, 4, 0, 0]} />
          )}
        </Chart>
      </ResponsiveContainer>
    </div>
  );
}
