from text.normalize_it import normalize


def test_plain_text_is_untouched():
    assert normalize("Ciao, come stai?") == "Ciao, come stai?"
    assert normalize("") == ""


def test_numbers():
    assert normalize("Ho 3 gatti") == "Ho tre gatti"
    assert normalize("sono 1.200 persone") == "sono milleduecento persone"
    assert normalize("pi greco vale 3,14") == "pi greco vale tre virgola quattordici"
    assert normalize("vale 3.14 circa") == "vale tre virgola quattordici circa"
    assert normalize("fa -5 gradi fuori") == "fa meno cinque gradi fuori"
    assert normalize("nel 2026") == "nel duemilaventisei"
    assert normalize("0,05") == "zero virgola zero cinque"
    assert normalize("chiama il 3331234567") == "chiama il tre tre tre uno due tre quattro cinque sei sette"


def test_times_and_dates():
    assert normalize("alle 15:30") == "alle quindici e trenta"
    assert normalize("alle 9:05") == "alle nove e cinque"
    assert normalize("alle 1:15") == "all'una e quindici"
    assert normalize("alle 15.30 ho una call") == "alle quindici e trenta ho una call"
    assert normalize("dalle 12:00") == "dalle mezzogiorno"
    assert normalize("il 13/10/2026") == "il tredici ottobre duemilaventisei"
    assert normalize("il 1/5") == "il primo maggio"
    assert normalize("scadenza 2026-10-14") == "scadenza quattordici ottobre duemilaventisei"
    assert normalize("versione 1.5") == "versione uno virgola cinque"


def test_currency_and_percent():
    assert normalize("costa € 12,50") == "costa dodici euro e cinquanta"
    assert normalize("costa 12,50 €") == "costa dodici euro e cinquanta"
    assert normalize("1 €") == "un euro"
    assert normalize("€1.200") == "milleduecento euro"
    assert normalize("$5") == "cinque dollari"
    assert normalize("il 15% in più") == "il quindici per cento in più"
    assert normalize("3,5%") == "tre virgola cinque per cento"


def test_ordinals_units_versions():
    assert normalize("il 1° posto") == "il primo posto"
    assert normalize("la 2ª volta") == "la seconda volta"
    assert normalize("5 km") == "cinque chilometri"
    assert normalize("1 km") == "un chilometro"
    assert normalize("20°C") == "venti gradi"
    assert normalize("16 GB di RAM") == "sedici gigabyte di ram"
    assert normalize("Python 3.11.9") == "Python tre punto undici punto nove"
    assert normalize("IP 192.168.1.1") == "i pi centonovantadue punto centosessantotto punto uno punto uno"


def test_acronyms_and_emphasis():
    assert normalize("apri il PDF") == "apri il pi di effe"
    assert normalize("la GPU è libera") == "la gi pi u è libera"
    assert normalize("la NASA") == "la nasa"
    assert normalize("NON farlo") == "non farlo"
    assert normalize("con l'AI") == "con l'a i"


def test_urls_emails_symbols_emoji_markdown():
    assert normalize("vai su https://www.github.com/x/y") == "vai su github punto com"
    assert normalize("scrivi a mario.rossi@example.it") == "scrivi a mario punto rossi chiocciola example punto it"
    assert normalize("Tom & Jerry") == "Tom e Jerry"
    assert normalize("Ottimo! 🎉👍") == "Ottimo!"
    assert normalize("**Attenzione**: usa `npm install`") == "Attenzione: usa npm install"
    assert normalize("e/o") == "e o"
    assert normalize("es. questo, ecc.") == "per esempio questo, eccetera"


def test_codes_and_long_numbers_are_read_digit_by_digit():
    assert normalize("UID 710351080") == "u i di sette uno zero tre cinque uno zero otto zero"
    assert normalize("il PIN è 4821") == "il pi i enne è quattro otto due uno"
    assert normalize("il codice 573") == "il codice cinque sette tre"
    assert normalize("nel 2026") == "nel duemilaventisei"
    assert normalize("costa 4821 euro") == "costa quattromilaottocentoventuno euro"
    assert normalize("sono 1.200.000 abitanti") == "sono un milione e duecentomila abitanti"
