import pytest

from lora.data import Segment, Word, clean_text, phrases, plan_clips, silences, total_hours, usable


def seg(start, end, text="una frase letta con calma", logprob=-0.2, before=0.4, after=0.4):
    return Segment(start, end, text, logprob, 0.01, before, after)


def words(spec):
    """'parola@start-end' items."""
    out = []
    for item in spec.split():
        text, times = item.split("@")
        a, b = times.split("-")
        out.append(Word(float(a), float(b), " " + text, 0.95))
    return out


def test_librivox_preamble_and_bad_segments_are_skipped():
    assert not usable(seg(0, 3, "Questa è una registrazione LibriVox."))
    assert not usable(seg(0, 3, "Registrato da Riccardo Fasol"))
    assert not usable(seg(0, 2, "Capitolo I"))
    assert not usable(seg(0, 3, "parola incerta", logprob=-1.2))
    assert not usable(seg(0, 5, "sì sì sì sì sì sì sì sì sì"))
    assert usable(seg(0, 3, "Un tempo i Malavoglia erano stati numerosi."))


def test_pauses_come_from_the_audio_and_words_fall_in_their_stretch():
    import numpy as np

    rate = 1000
    rng = np.random.default_rng(0)
    loud = lambda s: rng.normal(0, 0.3, int(s * rate))  # noqa: E731
    quiet = lambda s: rng.normal(0, 0.001, int(s * rate))  # noqa: E731
    audio = np.concatenate([loud(1.0), quiet(0.1), loud(0.5), quiet(0.4), loud(1.0)])
    pauses = silences(audio, rate)
    assert len(pauses) == 1 and abs(pauses[0][0] - 1.6) < 0.02 and abs(pauses[0][1] - 2.0) < 0.02
    # Whisper's words touch each other: the pause decides, by where each word ends
    found = phrases(words("fra@0-0.5 un@0.5-1.0 anno@1.0-1.9 o@1.9-2.4 due@2.4-3.0"), pauses, 3.0)
    assert [p.text for p in found] == ["fra un anno", "o due"]
    assert found[0].after == pytest.approx(pauses[0][1] - pauses[0][0])
    assert found[0].end == pytest.approx(pauses[0][0]) and found[1].start == pytest.approx(pauses[0][1])


def test_a_clip_never_reaches_into_the_next_words():
    # Phrases with short pauses: the margin is half the pause at most
    segments = [seg(0, 2, before=1.0, after=0.3), seg(2.3, 4, before=0.3, after=0.26), seg(4.26, 6, before=0.26)]
    clips = plan_clips(segments, min_s=3, max_s=4)
    assert len(clips) == 1
    assert clips[0].start == pytest.approx(-0.05)
    assert clips[0].end == pytest.approx(4.12)
    assert clips[0].text == "una frase letta con calma una frase letta con calma"


def test_phrases_merge_into_clips_of_3_to_15_seconds():
    segments = [seg(i * 2.4, i * 2.4 + 2.0) for i in range(20)]
    clips = plan_clips(segments)
    assert clips
    assert all(3 <= c.duration <= 15.5 for c in clips)
    # Consecutive clips never overlap and keep the reading order
    assert all(a.end <= b.start for a, b in zip(clips, clips[1:]))


def test_a_skipped_phrase_breaks_the_clip():
    segments = [seg(0, 2), seg(2.4, 4), seg(4.4, 6, "Fine del capitolo"), seg(6.4, 8), seg(8.4, 9.5)]
    clips = plan_clips(segments)
    assert [(round(c.start, 2), round(c.end, 2)) for c in clips] == [(-0.05, 4.12), (6.35, 9.62)]


def test_too_long_or_too_short_stretches_are_dropped():
    assert plan_clips([seg(0, 20)]) == []
    assert plan_clips([seg(0, 1.5)]) == []
    assert total_hours(plan_clips([seg(0, 10)])) == pytest.approx(10.17 / 3600)


def test_text_is_tidied():
    assert clean_text("  «Ciao»,   disse  l’uomo ") == '"Ciao", disse l\'uomo'


def test_training_sequence_layout():
    """Text first, then the frames; labels on the frames' own positions (the loss shifts them)."""
    from types import SimpleNamespace

    import pytest

    torch = pytest.importorskip("torch")
    from lora.train import collate

    talker = SimpleNamespace(codec_nothink_id=1, codec_think_bos_id=2, codec_think_eos_id=3, codec_pad_id=4, codec_bos_id=5, codec_eos_token_id=6)
    config = SimpleNamespace(tts_pad_token_id=90, tts_bos_token_id=91, tts_eos_token_id=92, talker_config=talker)
    text = torch.tensor([[10, 11, 12, 20, 21]])  # role (3 tokens) + two text tokens
    codes = torch.arange(3 * 16).reshape(3, 16) + 100  # three frames
    b = collate([{"text_ids": text, "codes": codes}], config)
    ids, labels = b["input_ids"][0], b["labels"][0]
    assert ids[:3, 0].tolist() == [10, 11, 12]
    assert ids[3:8, 1].tolist() == [1, 2, 3, 0, 4] and not b["codec_embed_mask"][0, 6, 0]
    assert ids[7, 0] == 91 and ids[8:10, 0].tolist() == [20, 21] and ids[10, 0] == 92
    # codec bos one step before the first frame, then the frames and the end
    assert ids[11, 1] == 5
    assert ids[12:15, 1].tolist() == codes[:, 0].tolist() and ids[15, 1] == 6
    assert labels[12:15].tolist() == codes[:, 0].tolist() and labels[15] == 6
    assert (labels[:12] == -100).all()
    assert b["codec_mask"][0].nonzero().flatten().tolist() == [12, 13, 14]


def test_training_sequence_with_the_language_tag():
    """With a language the tags are think, bos, language, eos (as generation builds them): one step longer."""
    from types import SimpleNamespace

    import pytest

    torch = pytest.importorskip("torch")
    from lora.train import collate

    talker = SimpleNamespace(
        codec_nothink_id=1, codec_think_id=7, codec_think_bos_id=2, codec_think_eos_id=3, codec_pad_id=4, codec_bos_id=5,
        codec_eos_token_id=6, codec_language_id={"italian": 9},
    )
    config = SimpleNamespace(tts_pad_token_id=90, tts_bos_token_id=91, tts_eos_token_id=92, talker_config=talker)
    codes = torch.arange(2 * 16).reshape(2, 16) + 100
    b = collate([{"text_ids": torch.tensor([[10, 11, 12, 20]]), "codes": codes}], config, "italian")
    ids = b["input_ids"][0]
    assert ids[3:9, 1].tolist() == [7, 2, 9, 3, 0, 4] and b["slot"] == 7
    assert ids[3:8, 0].tolist() == [90] * 5 and ids[8, 0] == 91 and ids[9, 0] == 20 and ids[10, 0] == 92
    assert ids[11, 1] == 5 and ids[12:14, 1].tolist() == codes[:, 0].tolist()
    assert b["labels"][0][12:15].tolist() == [*codes[:, 0].tolist(), 6]
