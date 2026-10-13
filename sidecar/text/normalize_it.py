"""Turns written Italian into what a voice should say.

TTS models read "15:30", "€ 12,50", "PDF" or "https://..." badly or not at
all. Before synthesis every sentence goes through `normalize()`: numbers,
dates, times, currency, percentages, units, acronyms, URLs, e-mail
addresses, symbols and emoji become Italian words. Pure: no I/O.
"""

from __future__ import annotations

import re
import unicodedata

from num2words import num2words

MONTHS = [
    "gennaio",
    "febbraio",
    "marzo",
    "aprile",
    "maggio",
    "giugno",
    "luglio",
    "agosto",
    "settembre",
    "ottobre",
    "novembre",
    "dicembre",
]

LETTERS = {
    "A": "a",
    "B": "bi",
    "C": "ci",
    "D": "di",
    "E": "e",
    "F": "effe",
    "G": "gi",
    "H": "acca",
    "I": "i",
    "J": "i lunga",
    "K": "cappa",
    "L": "elle",
    "M": "emme",
    "N": "enne",
    "O": "o",
    "P": "pi",
    "Q": "cu",
    "R": "erre",
    "S": "esse",
    "T": "ti",
    "U": "u",
    "V": "vu",
    "W": "doppia vu",
    "X": "ics",
    "Y": "ipsilon",
    "Z": "zeta",
}

# All-caps words that are read as words, not spelled out
WORD_ACRONYMS = {
    "NATO", "ONU", "UNESCO", "FIAT", "ISTAT", "INPS", "INAIL", "IRPEF", "IVA", "RAM", "ROM", "LAN", "WAN", "WIFI",
    "LED", "LASER", "RADAR", "NASA", "ESA", "UEFA", "FIFA", "COVID", "AIDS", "CAP", "TAR", "TAC", "ANSA", "RAI", "ENI",
    "ENEL", "ATM", "OK", "SMS", "IMU", "TARI", "SPID", "PEC", "ISEE", "ASL", "DOS", "JSON", "SQL", "CRUD", "GIF", "JPEG",
}  # fmt: skip

# Some acronyms are usually spelled the English way
SPELLED = {"AI": "a i", "IT": "i ti", "CEO": "ci i o", "PR": "pi erre", "TV": "ti vu", "DJ": "di gei", "VIP": "vip", "WWW": "vu vu vu"}

ABBREVIATIONS = {
    "es.": "per esempio",
    "ecc.": "eccetera",
    "etc.": "eccetera",
    "sig.": "signor",
    "sig.ra": "signora",
    "dott.": "dottor",
    "dott.ssa": "dottoressa",
    "prof.": "professor",
    "ing.": "ingegner",
    "avv.": "avvocato",
    "pag.": "pagina",
    "pagg.": "pagine",
    "tel.": "telefono",
    "cfr.": "confronta",
    "p.es.": "per esempio",
    "c.a.": "cortese attenzione",
    "vs.": "contro",
}

# unit -> (singular, plural)
UNITS = {
    "km/h": ("chilometro orario", "chilometri orari"),
    "km": ("chilometro", "chilometri"),
    "cm": ("centimetro", "centimetri"),
    "mm": ("millimetro", "millimetri"),
    "m": ("metro", "metri"),
    "kg": ("chilo", "chili"),
    "g": ("grammo", "grammi"),
    "mg": ("milligrammo", "milligrammi"),
    "ml": ("millilitro", "millilitri"),
    "l": ("litro", "litri"),
    "°C": ("grado", "gradi"),
    "°": ("grado", "gradi"),
    "TB": ("terabyte", "terabyte"),
    "GB": ("gigabyte", "gigabyte"),
    "MB": ("megabyte", "megabyte"),
    "KB": ("kilobyte", "kilobyte"),
    "kB": ("kilobyte", "kilobyte"),
    "GHz": ("gigahertz", "gigahertz"),
    "MHz": ("megahertz", "megahertz"),
    "Hz": ("hertz", "hertz"),
    "kWh": ("chilowattora", "chilowattora"),
    "kW": ("chilowatt", "chilowatt"),
    "W": ("watt", "watt"),
    "V": ("volt", "volt"),
    "ms": ("millisecondo", "millisecondi"),
    "min": ("minuto", "minuti"),
    "h": ("ora", "ore"),
    "s": ("secondo", "secondi"),
    "px": ("pixel", "pixel"),
}

CURRENCIES = {"€": ("euro", "euro"), "$": ("dollaro", "dollari"), "£": ("sterlina", "sterline"), "EUR": ("euro", "euro"), "USD": ("dollaro", "dollari")}

SYMBOLS = {
    "&": " e ",
    "=": " uguale ",
    "+": " più ",
    "§": " paragrafo ",
    "→": ", ",
    "->": ", ",
    "=>": ", ",
    "…": "...",
    "×": " per ",
    "÷": " diviso ",
    "≈": " circa ",
    "~": " circa ",
    "<": " minore di ",
    ">": " maggiore di ",
}


def cardinal(n: int) -> str:
    return num2words(n, lang="it")


def _number(integer: str, decimals: str | None = None) -> str:
    """Words for a number written with an integer part and optional decimals."""
    value = int(integer) if integer else 0
    words = cardinal(value)
    if decimals:
        # "3,05" is "tre virgola zero cinque"
        zeros = len(decimals) - len(decimals.lstrip("0"))
        rest = decimals.lstrip("0")
        tail = " ".join(["zero"] * zeros + ([cardinal(int(rest))] if rest else []))
        words = f"{words} virgola {tail}"
    return words


def _amount(integer: str, decimals: str | None, unit: tuple[str, str], cents: bool) -> str:
    value = int(integer) if integer else 0
    name = unit[0] if value == 1 and not decimals else unit[1]
    words = "un" if value == 1 else cardinal(value)
    if cents and decimals:
        c = int((decimals + "0")[:2])
        return f"{words} {name} e {cardinal(c)}" if c else f"{words} {name}"
    if decimals:
        return f"{_number(integer, decimals)} {unit[1]}"
    return f"{words} {name}"


def _clean_int(text: str) -> str:
    """Integer digits without Italian thousands separators ("1.200.000")."""
    return text.replace(".", "").replace(" ", "").replace(" ", "").replace("'", "")


def _ordinal(n: int, feminine: bool) -> str:
    word = num2words(n, lang="it", to="ordinal")
    return word[:-1] + "a" if feminine and word.endswith("o") else word


def _spell(word: str) -> str:
    return " ".join(LETTERS.get(ch, ch) for ch in word)


def _strip_emoji(text: str) -> str:
    out = []
    for ch in text:
        cp = ord(ch)
        if ch in "‍️︎⃣":
            continue
        if 0x1F000 <= cp <= 0x1FAFF or 0x2600 <= cp <= 0x27BF or 0x1F1E6 <= cp <= 0x1F1FF or 0x2B00 <= cp <= 0x2BFF:
            continue
        if unicodedata.category(ch) == "So" and cp > 0x2000:
            continue
        out.append(ch)
    return "".join(out)


_URL = re.compile(r"\b(?:https?://|www\.)[^\s<>\"']+", re.IGNORECASE)
_EMAIL = re.compile(r"\b([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)\b")
_TIME = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
# "15.30" is a time only after words like "alle"; elsewhere it is a decimal
_TIME_DOT = re.compile(r"\b(alle|ore|dalle|verso le|entro le|le)\s([01]?\d|2[0-3])\.([0-5]\d)\b", re.IGNORECASE)
_DATE = re.compile(r"\b([0-3]?\d)/([01]?\d)(?:/(\d{4}|\d{2}))?\b|\b([0-3]?\d)[.-]([01]?\d)[.-](\d{4})\b")
_ISO_DATE = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
# Common words that may be written in capitals for emphasis: never spelled out
EMPHASIS = {
    "NO", "SI", "SÌ", "OK", "MAI", "NON", "ORA", "PIÙ", "CHE", "PER", "CON", "TUTTO", "TUTTI", "MOLTO", "BENE", "MALE",
    "STOP", "FINE", "CIAO", "VIA", "SUBITO", "SEMPRE", "PRIMA", "DOPO", "DEVI", "PUOI", "ANCHE", "NIENTE", "ZERO",
}  # fmt: skip
_CURRENCY_BEFORE = re.compile(r"(€|\$|£)\s?(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?(?!\d)")
_CURRENCY_AFTER = re.compile(r"\b(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:,(\d{1,2}))?\s?(€|\$|£|EUR\b|USD\b)")
_PERCENT = re.compile(r"\b(\d+)(?:,(\d+))?\s?%")
_ORDINAL = re.compile(r"\b(\d{1,3})([°ºª])(?!C)")
_UNIT = re.compile(
    r"\b(\d+)(?:,(\d+))?\s?(" + "|".join(re.escape(u) for u in sorted(UNITS, key=len, reverse=True)) + r")(?![\w/])"
)
_VERSION = re.compile(r"\b[vV]?(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?\b")
_DECIMAL_DOT = re.compile(r"\b(\d+)\.(\d{1,2}|\d{4,})\b(?!\.\d)")
# "1.200.000", but not the start of an IP address or a version
_THOUSANDS = re.compile(r"\b\d{1,3}(?:\.\d{3})+\b(?!\.\d)")
_DECIMAL = re.compile(r"(?<![\d,])(-?)(\d+),(\d+)\b")
_INTEGER = re.compile(r"(?<![\w,])(-?)(\d+)\b")
_ACRONYM = re.compile(r"\b[A-Z]{2,6}\b")


def _url(match: re.Match[str]) -> str:
    url = re.sub(r"^(?:https?://)?(?:www\.)?", "", match.group(0), flags=re.IGNORECASE)
    host = re.split(r"[/?#:]", url, maxsplit=1)[0].rstrip(".,;")
    return " " + " punto ".join(part for part in host.split(".") if part) + " "


def _email(match: re.Match[str]) -> str:
    user = match.group(1).replace(".", " punto ").replace("_", " ").replace("-", " ")
    domain = " punto ".join(match.group(2).split("."))
    return f"{user} chiocciola {domain}"


def _clock(h: int, m: int) -> str:
    hours = "l'una" if h == 1 else ("mezzanotte" if h == 0 else ("mezzogiorno" if h == 12 and m == 0 else cardinal(h)))
    return hours if m == 0 else f"{hours} e {cardinal(m)}"


def _time(match: re.Match[str]) -> str:
    return _clock(int(match.group(1)), int(match.group(2)))


def _time_dot(match: re.Match[str]) -> str:
    return f"{match.group(1)} {_clock(int(match.group(2)), int(match.group(3)))}"


def _day_month_year(day: int, month: int, year: str | None, original: str) -> str:
    if not (1 <= day <= 31 and 1 <= month <= 12):
        return original
    words = f"{'primo' if day == 1 else cardinal(day)} {MONTHS[month - 1]}"
    if year:
        y = int(year)
        if len(year) == 2:
            y += 2000 if y < 70 else 1900
        words += f" {cardinal(y)}"
    return words


def _date(match: re.Match[str]) -> str:
    if match.group(1):
        return _day_month_year(int(match.group(1)), int(match.group(2)), match.group(3), match.group(0))
    return _day_month_year(int(match.group(4)), int(match.group(5)), match.group(6), match.group(0))


def _iso_date(match: re.Match[str]) -> str:
    return _day_month_year(int(match.group(3)), int(match.group(2)), match.group(1), match.group(0))


def _currency_before(match: re.Match[str]) -> str:
    return " " + _amount(_clean_int(match.group(2)), match.group(3), CURRENCIES[match.group(1)], cents=True) + " "


def _currency_after(match: re.Match[str]) -> str:
    return " " + _amount(_clean_int(match.group(1)), match.group(2), CURRENCIES[match.group(3)], cents=True) + " "


def _percent(match: re.Match[str]) -> str:
    return f"{_number(match.group(1), match.group(2))} per cento"


def _ordinal_match(match: re.Match[str]) -> str:
    return _ordinal(int(match.group(1)), feminine=match.group(2) == "ª")


def _unit(match: re.Match[str]) -> str:
    unit = UNITS[match.group(3)]
    return _amount(match.group(1), match.group(2), unit, cents=False)


def _version(match: re.Match[str]) -> str:
    parts = [p for p in match.groups() if p is not None]
    return " punto ".join(cardinal(int(p)) for p in parts)


def _decimal_dot(match: re.Match[str]) -> str:
    # "3.14" in English style; "1.200" (three digits) is a thousands separator, handled elsewhere
    return _number(match.group(1), match.group(2))


def _thousands(match: re.Match[str]) -> str:
    return cardinal(int(_clean_int(match.group(0))))


def _decimal(match: re.Match[str]) -> str:
    sign = "meno " if match.group(1) else ""
    return sign + _number(match.group(2), match.group(3))


def _integer(match: re.Match[str]) -> str:
    sign = "meno " if match.group(1) else ""
    digits = match.group(2)
    # Long digit strings (phone numbers, codes) are read one digit at a time
    if len(digits) > 9 or (len(digits) > 1 and digits.startswith("0")):
        return sign + " ".join(cardinal(int(d)) for d in digits)
    return sign + cardinal(int(digits))


def _acronym(match: re.Match[str]) -> str:
    word = match.group(0)
    if word in SPELLED:
        return SPELLED[word]
    if word in WORD_ACRONYMS or word in EMPHASIS:
        return word.lower()
    # Pronounceable capitals ("NASA", "FIAT") are read as words, the rest spelled ("PDF", "USB")
    vowels = sum(ch in "AEIOU" for ch in word)
    if len(word) >= 4 and vowels >= 2 and not re.search(r"[^AEIOU]{3}", word):
        return word.lower()
    return _spell(word)


def _abbreviations(text: str) -> str:
    for short, long in sorted(ABBREVIATIONS.items(), key=lambda kv: len(kv[0]), reverse=True):
        text = re.sub(r"(?<![\w.])" + re.escape(short) + r"(?=\s|$)", long, text, flags=re.IGNORECASE)
    # "n. 5" -> "numero 5"
    return re.sub(r"\b[nN]\.\s?(?=\d)", "numero ", text)


def _markdown(text: str) -> str:
    text = re.sub(r"```.*?```", " ", text, flags=re.DOTALL)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"\*\*([^*]+)\*\*|__([^_]+)__", lambda m: m.group(1) or m.group(2), text)
    text = re.sub(r"(?m)^\s{0,3}(?:#{1,6}|[-*•]|\d+[.)])\s+", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    return text.replace("*", "").replace("_", " ")


def normalize(text: str) -> str:
    """Spoken-Italian version of `text`, ready for a TTS engine."""
    if not text:
        return ""
    text = unicodedata.normalize("NFC", text)
    text = _markdown(text)
    text = _strip_emoji(text)
    text = _URL.sub(_url, text)
    text = _EMAIL.sub(_email, text)
    text = _abbreviations(text)
    text = _CURRENCY_BEFORE.sub(_currency_before, text)
    text = _CURRENCY_AFTER.sub(_currency_after, text)
    text = _PERCENT.sub(_percent, text)
    text = _TIME.sub(_time, text)
    text = _TIME_DOT.sub(_time_dot, text)
    text = re.sub(r"\b(d?a)lle l'una\b", r"\1ll'una", text)
    text = re.sub(r"\ble l'una\b", "l'una", text)
    text = _ISO_DATE.sub(_iso_date, text)
    text = _DATE.sub(_date, text)
    text = _ORDINAL.sub(_ordinal_match, text)
    text = _UNIT.sub(_unit, text)
    text = _THOUSANDS.sub(_thousands, text)
    text = _VERSION.sub(_version, text)
    text = _DECIMAL_DOT.sub(_decimal_dot, text)
    text = _DECIMAL.sub(_decimal, text)
    text = _INTEGER.sub(_integer, text)
    text = _ACRONYM.sub(_acronym, text)
    for symbol, words in sorted(SYMBOLS.items(), key=lambda kv: len(kv[0]), reverse=True):
        text = text.replace(symbol, words)
    text = re.sub(r"(?<=\w)/(?=\w)", " ", text)
    text = re.sub(r"[#@|\\^{}\[\]]", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\s{2,}", " ", text)
    return text.strip()
