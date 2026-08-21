# Analizator Cen Ofertowych — backend v0.2.1

Poprawka v0.2.1 usuwa błąd uruchomieniowy z v0.2:
funkcja `send()` wymagała argumentów `(res, status, data)`, a obsługa błędów i nieistniejącego endpointu przekazywała status w nieprawidłowym miejscu. Render zgłaszał `ERR_HTTP_INVALID_STATUS_CODE`.

Poza tym v0.2.1 zachowuje funkcje v0.2:
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
