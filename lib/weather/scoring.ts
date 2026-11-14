type Probabilities = (number | null)[];

export function forecastScore(probabilities: Probabilities, winner: number) {
  if (probabilities.length < 2 || winner < 0 || winner >= probabilities.length
    || probabilities.some(p => p == null || !Number.isFinite(p) || p < 0 || p > 1)
    || Math.abs(probabilities.reduce<number>((sum,p)=>sum+(p ?? 0),0)-1) > .001) return null;
  return {
    brier: probabilities.reduce<number>((sum,p,index)=>sum+((p ?? 0)-Number(index===winner))**2,0),
    logLoss: -Math.log(Math.max(1e-12,probabilities[winner]!)),
  };
}

export function clusteredInterval(values: number[]) {
  if (values.length < 20) return null;
  let state = 112233;
  const means = Array.from({length:2000},()=>{
    let sum=0;
    for (const _ of values) {
      state=(Math.imul(state,1664525)+1013904223)>>>0;
      sum+=values[Math.floor(state/4294967296*values.length)];
    }
    return sum/values.length;
  }).sort((a,b)=>a-b);
  return [means[49],means[1949]] as const;
}
