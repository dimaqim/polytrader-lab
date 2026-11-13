const excludedAsset = /(?:^|[^\p{L}\p{N}])(?:btc|bitcoin|xbt|eth|ether|ethereum|биткоин[а-яё]*|биткойн[а-яё]*|эфир[а-яё]*|этериум[а-яё]*|эфириум[а-яё]*)(?=$|[^\p{L}\p{N}])/iu;

export function hiddenMarket(title?: string, slug?: string) {
  return excludedAsset.test(`${title ?? ""} ${slug ?? ""}`);
}

export const activeStrategies = ["copy", "combo"] as const;
