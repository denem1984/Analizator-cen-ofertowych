# Analizator Cen Ofertowych

## Cel projektu

Aplikacja służy do wyszukiwania i porównywania ofert nieruchomości z wielu polskich portali ogłoszeniowych. Użytkownik podaje lokalizację, rodzaj nieruchomości, oczekiwaną powierzchnię i tolerancję powierzchni, a backend zbiera oferty i zwraca ujednolicony zestaw danych.

## Aktualny stan projektu

### Obsługiwane portale

- Nieruchomości-online
- Morizon
- Domiporta
- Gratka
- Adresowo

Parsery działają niezależnie. Problem lub brak wyników z jednego portalu nie powinien blokować wyników z pozostałych.

### Lokalizacja

Lokalizacja podawana przez użytkownika jest rozpoznawana przez GUS TERYT/SIMC.

Przykład:

`Szczecin` → `3262011` → województwo zachodniopomorskie → powiat Szczecin → gmina Szczecin.

### Filtr powierzchni

Działa filtr powierzchni z tolerancją. Przykład dla 62 m² i tolerancji 10%: zakres 55,8–68,2 m².

### Typy nieruchomości

Docelowa lista typów:

1. Mieszkanie
2. Dom
3. Działka
4. Nieruchomość komercyjna

Dla nieruchomości komercyjnej portale będą mapowane do wspólnej kategorii:

| Nasz typ | Nieruchomości-online | Morizon | Gratka | Domiporta | Adresowo |
|---|---|---|---|---|---|
| Nieruchomość komercyjna | lokal użytkowy + budynek użytkowy | nieruchomość komercyjna | nieruchomość komercyjna | lokal użytkowy + magazyn | nieruchomość komercyjna |

Mapowanie tego typu jest kolejnym etapem rozwoju projektu.

## Deduplikacja

Mechanizm deduplikacji pozostaje celowo prosty i nie jest rozszerzany o lokalizację.

Zasady:

- identyczny URL → duplikat,
- ta sama cena + ta sama powierzchnia → duplikat.

**Lokalizacja, ulica ani dzielnica nie są wykorzystywane jako warunek deduplikacji.** Jest to świadoma decyzja projektowa.

## Dane zwracane przez parser

Wyniki zawierają m.in.:

- portal źródłowy,
- typ nieruchomości,
- lokalizację,
- ulicę, jeśli została rozpoznana,
- URL oferty,
- cenę,
- powierzchnię,
- cenę za m²,
- tytuł oferty.

Backend prowadzi również diagnostykę liczby rozpoznanych, kompletnych i przefiltrowanych ofert dla każdego portalu.

## Domiporta

Domiporta wymagała osobnego podejścia do ekstrakcji danych. Aktualnie parser prawidłowo zwraca kompletne oferty. W ostatnim teście Szczecina dla 62 m² ±10% uzyskano 7 ofert Domiporta.

## Test referencyjny

Test Szczecina:

- lokalizacja: Szczecin,
- powierzchnia: 62 m²,
- tolerancja: 10%,
- zakres: 55,8–68,2 m².

Ostatni test wykazał:

- Nieruchomości-online: 7 ofert w zakresie,
- Morizon: 8,
- Domiporta: 7,
- Gratka: 8,
- Adresowo: 9,
- łącznie przed deduplikacją: 39,
- po deduplikacji: 30 unikalnych ofert.

## Render

Backend działa jako usługa Node.js na Render.

Build:

`npm install`

Start:

`npm start`

Wymagana zmienna środowiskowa:

`TAVILY_API_KEY`

Health:

`GET /health`

Główny endpoint backendowy:

`POST /api/search-offers`

## Ważne ograniczenia

Promień geograficzny nie jest obecnie liczony matematycznie. Lokalizacja jest rozpoznawana administracyjnie przez TERYT/SIMC. Dokładne filtrowanie po odległości/geokodowaniu może zostać dodane w późniejszym etapie, jeśli będzie potrzebne.

## Zasada dalszego rozwoju

Najpierw stabilizujemy pozyskiwanie i ujednolicanie ofert ze wszystkich portali. Dopiero potem rozbudowujemy funkcje analityczne i interfejs użytkownika.
