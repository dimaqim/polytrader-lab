export const strategies = {
  btc15: { name: "BTC 15m", description: "Фаворит от 90¢ за 60 секунд до конца раунда", version: 1, collector: true },
  btc5: { name: "BTC 5m", description: "Фаворит выше 50¢ за 30 секунд до конца раунда", version: 1, collector: true },
  copy: { name: "Copy Trading", description: "Покупки выбранных кошельков по свежему стакану после обнаружения", version: 1, collector: false },
  combo: { name: "Combo Whale Tracker", description: "Подтверждённые комбо от $2 000 и проверка доступности цены", version: 1, collector: false },
  maker: { name: "Market Making", description: "Парные лимитные заявки с подтверждением прохода цены", version: 1, collector: true },
} as const;
export type Strategy = keyof typeof strategies;
export const seedWallet = "0x32ed2e546b187ca15e2841edc82b22c713cf8ec3";
export const walletPattern = /^0x[\da-f]{40}$/i;
export const strategyIds = Object.keys(strategies) as Strategy[];

export function btcRule(interval: number, endsAt: number) {
  return interval === 15
    ? { strategy: "btc15" as const, target: endsAt - 60_000, threshold: 0.9 }
    : { strategy: "btc5" as const, target: endsAt - 30_000, threshold: 0.5 };
}
