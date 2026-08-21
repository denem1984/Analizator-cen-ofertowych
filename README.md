# Analizator Cen Ofertowych — backend v0.2

Wersja 0.2 dodaje drugi etap przetwarzania:
1. Tavily wyszukuje potencjalne strony ofert.
2. Backend odrzuca typowe strony zbiorcze.
3. Backend pobiera bezpośrednią stronę kandydata.
4. Dane są szukane przede wszystkim w JSON-LD, a następnie w tekście strony.
5. Cena i powierzchnia przechodzą podstawową kontrolę spójności.
6. Dopiero poprawne rekordy trafiają do filtra powierzchni i deduplikacji.

## Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable:
  - `TAVILY_API_KEY` = klucz Tavily

## Endpoint

`GET /health`

`POST /api/search-offers`

Przykładowe body:

```json
{
  "type": "Lokal mieszkalny",
  "unit": "Miasto",
  "location": "Olsztyn",
  "radius": 10,
  "area": 62,
  "tolerance": 10
}
```

Endpoint zwraca także `diagnostics`, aby można było zobaczyć, dlaczego poszczególne wyniki zostały odrzucone.

## Uwaga

Parser jest heurystyczny i wymaga dalszych testów na konkretnych portalach. Nie należy jeszcze traktować wyników jako kompletnej bazy ofert.
