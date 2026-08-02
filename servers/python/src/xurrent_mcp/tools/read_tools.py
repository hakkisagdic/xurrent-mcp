"""Okuma tool'lari: whoami, find_person, list_open_work, get_time_tracking_context."""

from __future__ import annotations

from typing import Any

from ..models import to_dict
from .runtime import Runtime


def xurrent_whoami(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """Her entegrasyonun ilk sorusu: 'ben kimim ve nereye bagliyim?'

    Xurrent'ta bu tek bir GraphQL sorgusuyla cevaplanir ve maliyeti 1 puandir.
    Ayni sorgu rate limit durumunu da doner — baglantiyi dogrulamanin en ucuz yolu.
    """
    person, account, rate = rt.adapter.whoami()
    return {
        "person": to_dict(person),
        "account": to_dict(account),
        "mode": rt.adapter.mode,
        "rateLimit": to_dict(rate) if rate else None,
    }


def xurrent_find_person(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """Kisiyi birincil e-posta ile bulur.

    TAM eslesme yapar (substring DEGIL) — PersonFilter.primaryEmail bir
    TextFilter'dir; buyuk-kucuk harf ve format duyarlidir.
    """
    email = str(args.get("email", "")).strip()
    view = args.get("view") or "all"
    people = rt.adapter.find_person(email, view)
    return {
        "totalCount": len(people),
        "people": [to_dict(p) for p in people],
        # Tam eslesme bulunamadi -> chatbot serbest metin aramayi onerebilir.
        "suggestFuzzy": len(people) == 0,
    }


def xurrent_list_open_work(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """ISTER #1: bir kisinin uzerindeki acik Request ve Task'lari listeler.

    Burada UC tuzak vardir ve ucu de SESSIZ hata uretir — yani yanlis yaparsan
    hata almazsin, sadece eksik veri alirsin. En kotu hata turu.
    """
    person_id = rt.adapter.resolve_person_id(args.get("personId"))
    include = args.get("include") or ["requests", "tasks"]
    first = int(args.get("first") or 25)
    # TUZAK: view varsayilani 'current_account'tur. 'all' gecilmezse kisinin
    # diger hesaplardaki isleri GORUNMEZ.
    view = args.get("view") or "all"

    empty = {"totalCount": 0, "nodes": [], "hasNextPage": False, "endCursor": None}

    requests_page = empty
    if "requests" in include:
        # TUZAK: RequestFilter'da atanan kisi alani 'member'dir.
        page = rt.adapter.list_open_requests(person_id, first, args.get("afterRequests"), view)
        requests_page = to_dict(page)

    tasks_page = empty
    if "tasks" in include:
        # TUZAK: TaskFilter'da atanan kisi alani 'assignee'dir ('member' YOKTUR).
        # Ayrica Task'ta BES terminal durum vardir: completed, approved, failed,
        # rejected, canceled. Sadece 'completed'i elemek yetmez.
        page = rt.adapter.list_open_tasks(person_id, first, args.get("afterTasks"), view)
        tasks_page = to_dict(page)

    return {
        # Cache anahtari (accountId, nodeId) olmalidir — status/member/team
        # alanlari account-specific'tir.
        "accountId": rt.adapter.account_id(),
        "requests": requests_page,
        "tasks": tasks_page,
    }


def xurrent_get_time_tracking_context(rt: Runtime, args: dict[str, Any]) -> dict[str, Any]:
    """Zaman yazmadan ONCE calistirilmasi ZORUNLU olan baglam sorgusu.

    timeIncrement bilinmeden timeSpent SECILEMEZ. Varsayilani 60'tir; yani
    varsayilan yapilandirmali bir hesapta 45 dakikalik bir giris REDDEDILIR.
    Xurrent entegrasyonlarindaki en yaygin sessiz hata budur.
    """
    person_id = rt.adapter.resolve_person_id(args.get("personId"))
    ctx = rt.time_tracking_context(person_id)
    return to_dict(ctx)
