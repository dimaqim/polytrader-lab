export function wilson(wins: number, total: number): [number, number] | null {
  if (total === 0) return null;
  const z = 1.959963984540054;
  const p = wins / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const radius = z * Math.sqrt(p * (1 - p) / total + z ** 2 / (4 * total ** 2)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}
export function maximumDrawdown(values: number[]) {
  let peak = 0;
  let loss = 0;
  for (const value of values) {
    peak = Math.max(peak, value);
    if (peak > 0) loss = Math.max(loss, (peak - value) / peak);
  }
  return loss;
}
