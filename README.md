# Analizator Cen Ofertowych — backend v0.3

## Cel tej wersji

v0.3 zmienia strategię wyszukiwania. W v0.2 Tavily zwracał głównie strony zbiorcze.
v0.3 wykonuje wiele bardziej precyzyjnych zapytań, w tym zapytania z `site:` i
wzorcem konkretnej oferty.

Dodatkowo:
- kandydaci są klasyfikowani jako strona zbiorcza / niebezpośrednia / oferta,
- dla ofert backend próbuje pobrać stronę bezpośrednio,
- jeśli portal blokuje pobranie (np. 403), parser może wykorzystać treść
  dostarczoną przez Tavily,
- dane są najpierw szukane w JSON-LD,
- potem w treści tekstowej,
- cena i powierzchnia są kontrolowane,
- działa filtr powierzchni,
- działa deduplikacja,
- `diagnostics` pokazuje sposób i powód odrzucenia kandydata.

## Ważne ograniczenie

Promień geograficzny nie jest jeszcze liczony matematycznie. Na tym etapie parametr
`radius` służy do budowania zapytania. Dokładniejsze filtrowanie po jednostkach
(miast/gmina/powiat) i geokodowanie zrobimy dopiero po ustabilizowaniu pozyskiwania
konkretnych ofert.

## Render

Build:
`npm install`

Start:
`npm start`

Environment:
`TAVILY_API_KEY`

Health:
`GET /health`

Search:
`POST /api/search-offers`
