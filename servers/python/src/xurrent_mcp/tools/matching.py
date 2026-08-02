"""Toplanti <-> acik is eslestirme heuristigi.

KURAL: heuristik BASIT ve ACIKLANABILIR tutulur. Uc yol vardir:
  1. Baslikta ticket numarasi deseni  -> KESIN eslesme (confidence 1.0)
  2. Normalize edilmis metin benzerligi -> BULANIK eslesme
  3. Hicbiri tutmazsa                  -> needsUserDecision=true

Belirsizlik (esik ustunde BIRDEN FAZLA aday) da needsUserDecision uretir.
Bot tahmin etmek yerine SORMALIDIR — eslestirme ASLA %100 dogru olamaz.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from ..models import WorkItem

# Baslikta gecen ticket numarasi deseni: REQ-70248, #70248, TASK 4419, 70248 ...
TICKET_NUMBER_RE = re.compile(r"(?:REQ|TASK|TALEP|GOREV|#)?[\s\-_]*?(\d{3,})", re.IGNORECASE)

# Turkce dolgu kelimeleri — benzerlik hesabinda gurultu yaratirlar.
STOPWORDS = {
    "ve", "ile", "icin", "için", "bir", "bu", "su", "şu", "da", "de", "mi", "mu",
    "cok", "çok", "gibi", "olarak", "uzerinde", "üzerinde", "sonra", "once", "önce",
    "icinde", "içinde", "the", "and", "for", "with",
}

# Iki token, ilk 4 harfi ortaksa AYNI kabul edilir. Bu, Turkce ekleri
# ("analiz" / "analizi", "baglanti" / "baglantisi") sadelestiren fakir ama
# ACIKLANABILIR bir kok bulucudur.
MIN_COMMON_PREFIX = 4

# Dice katsayisi esigi. Bunun altindaki adaylar hic degerlendirilmez.
FUZZY_THRESHOLD = 0.15


def normalize_text(value: str) -> list[str]:
    """Metni kucuk harfe cevirir, noktalama atar, stopword'leri eler."""
    lowered = value.replace("I", "ı").replace("İ", "i").lower()
    folded = "".join(
        ch for ch in unicodedata.normalize("NFKC", lowered) if ch.isalnum() or ch.isspace()
    )
    return [t for t in folded.split() if len(t) >= 3 and t not in STOPWORDS]


def _tokens_match(a: str, b: str) -> bool:
    if a == b:
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) < MIN_COMMON_PREFIX:
        return False
    common = 0
    for x, y in zip(shorter, longer):
        if x != y:
            break
        common += 1
    return common >= MIN_COMMON_PREFIX


def dice_similarity(left: list[str], right: list[str]) -> float:
    """Sorensen-Dice: 2*|kesisim| / (|A| + |B|). 0..1 arasi."""
    if not left or not right:
        return 0.0
    used: set[int] = set()
    overlap = 0
    for token in left:
        for index, other in enumerate(right):
            if index in used:
                continue
            if _tokens_match(token, other):
                used.add(index)
                overlap += 1
                break
    return (2 * overlap) / (len(left) + len(right))


@dataclass
class Match:
    item: WorkItem | None
    confidence: float
    reason: str
    needs_decision: bool


def match_meeting(title: str, work_items: list[WorkItem]) -> Match:
    """Bir toplanti basligini acik is listesiyle eslestirir."""
    # --- Yol 1: baslikta ticket numarasi deseni ------------------------
    numbers = {m.group(1) for m in TICKET_NUMBER_RE.finditer(title)}
    for item in work_items:
        if item.displayId in numbers:
            kind_tr = "Talep" if item.kind == "request" else "Gorev"
            return Match(
                item=item,
                confidence=1.0,
                reason=(
                    f"Baslikta '{item.displayId}' numarasi geciyor -> "
                    f"{kind_tr} #{item.displayId} ile KESIN eslesme."
                ),
                needs_decision=False,
            )

    # --- Yol 2: metin benzerligi --------------------------------------
    meeting_tokens = normalize_text(title)
    scored: list[tuple[float, WorkItem]] = []
    for item in work_items:
        score = dice_similarity(meeting_tokens, normalize_text(item.subject or ""))
        if score >= FUZZY_THRESHOLD:
            scored.append((score, item))

    scored.sort(key=lambda pair: pair[0], reverse=True)

    if not scored:
        # --- Yol 3: hicbiri tutmadi -----------------------------------
        return Match(
            item=None,
            confidence=0.0,
            reason=(
                "Baslikta ticket numarasi yok ve acik islerle anlamli metin benzerligi "
                "kurulamadi. Kullanicinin karar vermesi gerekiyor."
            ),
            needs_decision=True,
        )

    best_score, best_item = scored[0]

    if len(scored) > 1:
        # BELIRSIZLIK: esik ustunde birden fazla aday var. Bot SORMALIDIR.
        others = ", ".join(
            f"{'Talep' if it.kind == 'request' else 'Gorev'} #{it.displayId}"
            for _, it in scored[:3]
        )
        return Match(
            item=best_item,
            confidence=round(best_score, 2),
            reason=(
                f"Birden fazla aday metin benzerligi kurdu ({others}). "
                "Belirsizlik var — dogru hedefi kullanici secmeli."
            ),
            needs_decision=True,
        )

    kind_tr = "Talep" if best_item.kind == "request" else "Gorev"
    return Match(
        item=best_item,
        confidence=round(best_score, 2),
        reason=(
            f"Metin benzerligi (Dice={best_score:.2f}) -> {kind_tr} "
            f"#{best_item.displayId} '{best_item.subject}' ile BULANIK eslesme."
        ),
        needs_decision=False,
    )
