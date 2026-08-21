# Analizator Cen Ofertowych — backend v0.1

Mały backend Node.js dla aplikacji HTML.

## Render

- Runtime: Node
- Build Command: `npm install`
- Start Command: `npm start`
- Plan: Free
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

Wersja 0.1 używa heurystycznego odczytu ceny i powierzchni z wyników Tavily.
Przed użyciem produkcyjnym należy dopracować parser dla konkretnych źródeł oraz sposób ustalania lokalizacji.
