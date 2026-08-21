# Analizator Cen Ofertowych — backend v0.2.2

Poprawka v0.2.2 usuwa ostatni błąd w odpowiedziach HTTP:
endpoint `/health` przekazywał obiekt JSON jako kod HTTP zamiast statusu `200`.

W v0.2.2 wszystkie ścieżki odpowiedzi używają:
`send(res, status, data)`.

Funkcjonalność wyszukiwania pozostaje taka jak w v0.2:
- odrzucanie typowych stron zbiorczych,
- pobieranie bezpośrednich stron kandydatów,
- odczyt JSON-LD,
- parser ceny i powierzchni,
- kontrola spójności,
- lokalizacja,
- diagnostyka,
- filtr powierzchni,
- deduplikacja.

Render:
- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable: `TAVILY_API_KEY`
