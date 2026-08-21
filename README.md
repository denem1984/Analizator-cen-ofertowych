# Analizator Cen Ofertowych — backend v0.2.3

Poprawka v0.2.3 usuwa błąd w endpointcie `/api/search-offers`.
W wersji v0.2.2 wynik wyszukiwania był przekazywany do `send()` jako kod HTTP.
Prawidłowo powinien być przekazany jako trzeci argument:
`send(res, 200, data)`.

Wersja zachowuje funkcjonalność v0.2:
- odrzucanie stron zbiorczych,
- pobieranie stron kandydatów,
- JSON-LD,
- parser ceny i powierzchni,
- kontrola spójności,
- lokalizacja,
- diagnostyka,
- filtr powierzchni,
- deduplikacja.
