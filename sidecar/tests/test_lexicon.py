from text.lexicon_it import ESPEAK_LOANWORDS, apply_lexicon, lexicon_for, parse_entries
from text.normalize_it import normalize
from tts.base import TTSConfig


def test_entries_from_settings_lines():
    assert parse_entries(["VS Code = vi es code", "  Sme.UP=  smi ap ", "senza uguale", "= vuoto", "vuoto ="]) == [
        ("VS Code", "vi es code"),
        ("Sme.UP", "smi ap"),
    ]


def test_whole_words_any_case_longest_first():
    entries = (("VS Code", "vi es code"), ("code", "cod"), ("Lumi", "lùmi"))
    assert apply_lexicon("apri VS   Code e il code", entries) == "apri vi es code e il cod"
    assert apply_lexicon("Code review", entries) == "Cod review", "a capital at the start stays"
    assert apply_lexicon("Lumière e lumino", entries) == "Lumière e lumino", "never inside a word"
    assert apply_lexicon("niente da fare", ()) == "niente da fare"


def test_normalize_applies_the_lexicon_before_acronyms():
    entries = (("VS Code", "vi es code"),)
    assert normalize("Apri VS Code", entries) == "Apri vi es code"
    assert normalize("Apri VS Code") == "Apri vu esse Code", "without the entry VS is spelled"


def test_kokoro_gets_the_loanwords_and_the_user_wins():
    assert lexicon_for(None) == ()
    qwen = TTSConfig(engine="qwen3", lexicon=[["Sme.UP", "smi ap"]])
    assert lexicon_for(qwen) == (("Sme.UP", "smi ap"),), "Qwen3 knows English words"
    kokoro = TTSConfig(engine="kokoro", lexicon=[["mouse", "mausse"]])
    entries = lexicon_for(kokoro)
    assert len(entries) == 1 + len(ESPEAK_LOANWORDS)
    assert normalize("Muovi il mouse e apri il file", entries) == "Muovi il mausse e apri il fail"
    assert normalize("le file alla posta", entries) == "le file alla posta", "the rows stay rows"
