"""Mock ve live adapter'larin ortak arayuzu.

NEDEN Protocol degil ABC: ders materyalinde "hangi metodu implemente etmem
gerekiyor" sorusunun cevabi acikca gorunsun istiyoruz.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..models import (
    Account,
    Person,
    RateLimit,
    TimeTrackingContext,
    WorkPage,
)


class XurrentAdapter(ABC):
    """8 tool'un ihtiyac duydugu Xurrent islemleri."""

    mode: str

    @abstractmethod
    def whoami(self) -> tuple[Person, Account, RateLimit | None]: ...

    @abstractmethod
    def find_person(self, email: str, view: str = "all") -> list[Person]: ...

    @abstractmethod
    def resolve_person_id(self, person_id: str | None) -> str:
        """'$me' ozel degerini authenticated user'a cozer."""

    @abstractmethod
    def list_open_requests(self, person_id: str, first: int, after: str | None, view: str) -> WorkPage: ...

    @abstractmethod
    def list_open_tasks(self, person_id: str, first: int, after: str | None, view: str) -> WorkPage: ...

    @abstractmethod
    def account_id(self) -> str: ...

    @abstractmethod
    def time_tracking_context(self, person_id: str) -> TimeTrackingContext: ...

    @abstractmethod
    def minutes_logged_on(self, person_id: str, date_iso: str) -> int:
        """O gun ilgili kisi adina yazilmis toplam dakika (workday kontrolu icin)."""

    @abstractmethod
    def run_mutation(self, planned: dict[str, Any]) -> dict[str, Any]:
        """Tek bir planlanmis mutation'i calistirir.

        Donus: {"timeEntry": {...} | None, "errors": [{"message":..,"path":..}]}
        DIKKAT: Validation hatalari HTTP 200 + errors dolu + timeEntry null
        olarak doner (top-level GraphQL errors DEGIL).
        """

    @abstractmethod
    def list_time_entries(
        self,
        person_id: str,
        date_from: str | None,
        date_to: str | None,
        source_id: str | None,
        first: int,
    ) -> list[dict[str, Any]]:
        """Yazilmis zaman girislerini okur (xurrent_list_time_entries).

        Donus: contract $defs/TimeEntryRecord seklinde dict listesi.
        sourceID filtresi dedup geri-okumasinin GENEL halidir; tarih araligi
        (dateFrom/dateTo, ikisi de DAHIL) timesheet gunune gore suzer.
        """

    @abstractmethod
    def find_time_entry_by_source_id(self, source_id: str) -> dict[str, Any] | None:
        """Dedup geri-okumasi: bu sourceID ile YAZILMIS kayit var mi?

        contract/reliability.md §5 — Yol A yazmalarinin idempotency temelidir:
        deterministik sourceID var ama Xurrent tarafinda unique kisit YOK.
        "Zaten yazilmis mi?" sorusunu bu geri-okuma cevaplar. Kayit varsa
        timeEntry dict'i, yoksa None doner.
        """

    @abstractmethod
    def target_label(self, target_type: str, target_id: str) -> str | None:
        """Hedef kaydin insan-okunur etiketi (uyari metinlerinde kullanilir)."""
