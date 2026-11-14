# Источники погодных данных

| Поле | Источник | Частота запроса |
|---|---|---|
| Правила, диапазоны, YES/NO, тик, минимальный объём, комиссия | [Polymarket](https://docs.polymarket.com/market-data/discover-markets) | Около пяти минут |
| Прогноз температуры | [Open-Meteo](https://open-meteo.com/en/docs) с ECMWF IFS, NOAA GFS и DWD ICON | 15 минут |
| Члены ансамбля | [ECMWF через Ensemble API](https://open-meteo.com/en/docs/ensemble-api) | Два часа |
| Станция, исходный METAR, время наблюдения и приёма источником | [NOAA Aviation Weather Center](https://aviationweather.gov/data/api/) | Минута |
| Глубина и изменения цены | [Polymarket CLOB Market](https://docs.polymarket.com/market-data/realtime-data) | Поток |
| Действия подтверждённых кошельков | [Polymarket Data API](https://docs.polymarket.com/trading/wallet-activity) | Две минуты |

Публичный Open-Meteo используется для некоммерческого исследования в рамках его условий и ограничений. Операционный прогноз архивируется при изменении содержания с моментом получения. API Forecast не возвращает жизненный цикл модельного запуска, поэтому runAt остаётся пустым. Момент приёма сообщения AWC и момент получения нашим процессом хранятся раздельно. Официальный расчёт берётся у Polymarket при наличии явного статуса.
