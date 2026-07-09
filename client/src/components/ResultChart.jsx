import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer,
} from "recharts";

const isIdLike = (name) => /(^|_)id$|^id$/i.test(name);
const isNumericCol = (rows, key) =>
  rows.every((r) => r[key] !== null && r[key] !== "" && !isNaN(Number(r[key])));
const isDateCol = (rows, key) =>
  rows.every((r) => !isNaN(Date.parse(String(r[key]))) && isNaN(Number(r[key])));

/**
 * Auto-chart heuristic. Works on results with more than two columns: pick the
 * x-axis as the first categorical/date column and the y-axis as the first
 * numeric column, skipping id-like columns (an id makes a meaningless axis).
 * Date x → line chart, categorical x → bar chart. No suitable pair → no chart
 * (the table is always shown regardless).
 */
export function ResultChart({ columns, rows }) {
  if (columns.length < 2 || rows.length < 2 || rows.length > 100) return null;

  const usable = columns.filter((c) => !isIdLike(c));
  // y: first numeric non-id column. x: first non-numeric (categorical/date) non-id column.
  const yKey = usable.find((c) => isNumericCol(rows, c));
  const xKey = usable.find((c) => c !== yKey && !isNumericCol(rows, c));
  if (!xKey || !yKey) return null;

  const data = rows.map((r) => ({ x: String(r[xKey]), y: Number(r[yKey]) }));
  const xIsDate = isDateCol(rows, xKey);

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
