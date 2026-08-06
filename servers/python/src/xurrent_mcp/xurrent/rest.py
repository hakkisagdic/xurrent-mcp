"""Xurrent REST v1 API'sine baglanan adapter (httpx) — IKINCI wire bicimi.

ENDPOINT: https://api.xurrent.com/v1 (bolge ekleri GraphQL'dekiyle ayni mantik).
Secim: XURRENT_MODE=live + XURRENT_API=rest (bkz. .env.example §1, docs/16).

★ TEZ: transport bir ADAPTOR detayidir. Bu sinif LiveXurrentAdapter ile AYNI
arayuzu (XurrentAdapter) sunar ve AYNI tool sozlesmesini servis eder; degisen
yalnizca wire bicimidir. GraphQL ile bilincli farklar — dersin konusu:

  · Alan adlari snake_case'tir (started_at, time_spent) — sourceID HARIC
    (Xurrent REST dokumantasyonu da sourceID yazar).
  · Validation hatasi HTTP 422 + {errors:[...]} doner — GraphQL'in
    "HTTP 200 + payload.errors" modelinin tam tersi. Istemci HTTP koduna
    BAKMAK zorundadir; 422 is kurali reddidir, exception DEGIL, retry DEGIL.
  · whoami/context tek istekte alinamaz: /me + /account, /timesheet_settings +
    /effort_classes + /time_allocations ayri ayridir (1 sorgu vs N istek).

Retry/dedup politikasi TRANSPORT-BAGIMSIZDIR (contract/reliability.md):
retry.py'deki AYNI katman kullanilir; REST operasyonlari soyle siniflanir:
  GET *                    -> query             (yan etkisiz, serbest retry)
  POST /time_entries       -> guarded_create    (belirsizde ONCE dedup okumasi)
  PATCH /time_entries/:id  -> idempotent_update (mutlak SET, tekrar zararsiz)
  PATCH /requests|tasks/:id-> no_retry          (time_spent ARTIMLI, tekrar =
                                                 cift sayim; ASLA otomatik)

DIKKAT: Bu kod gercek bir Xurrent hesabina karsi CALISTIRILMAMISTIR. Yanit
sekilleri dokumantasyondan CIKARIMDIR; alan adlari ve hata govdesi bicimi
DOGRULANMALI'dir (docs/08). Sahte sunucu (tools/fake-xurrent) ayni cikarimi
taklit eder — wire seviyesinde kanit odur, sema dogrulamasi DEGILDIR.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ..config import Config
from ..models import (
    Account,
    EffortClass,
    Person,
    RateLimit,
    TimeAllocation,
    TimeTrackingContext,
    TimeTrackingDefaults,
    WorkItem,
    WorkPage,
)
from ..timeutil import today_in
from .base import XurrentAdapter
from .mock import STATUS_LABELS_TR
from .retry import (
    OP_CLASS_BY_PATH,
    XurrentHttpError,
    XurrentRestValidationError,
    XurrentTransportError,
    execute_with_retry,
    log_dedup,
    transport_error_message,
)

log = logging.getLogger(__name__)

# Mutation path -> REST kaynak yolu. GraphQL'deki mutation adlari sozlesmenin
# IC dilidir (PlannedMutation.path); REST adaptoru bunlari HTTP'ye ceviren son
# duraktir. project_tasks/problems DOGRULANMALI'dir: sahte sunucu yalnizca
# requests/tasks destekler, ders senaryolari da yalnizca onlari kullanir.
_PARENT_RESOURCE_BY_PATH = {
    "requestUpdate": "requests",
    "taskUpdate": "tasks",
    "projectTaskUpdate": "project_tasks",
    "problemUpdate": "problems",
}


class RestXurrentAdapter(XurrentAdapter):
    """XURRENT_API=rest — ayni sozlesme, ikinci transport."""

    mode = "live"

    def __init__(self, config: Config) -> None:
        self.config = config
        self._last_request_at = 0.0
        self._me_id: str | None = None
        self._account: Account | None = None
        self._context_cache: TimeTrackingContext | None = None
        self._rate_limit: RateLimit | None = None

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.token}",
        }
        if config.account:
            # NUMERIK DEGIL — kisa slug. GraphQL ile ayni header sozlesmesi.
            headers["X-Xurrent-Account"] = config.account

        self._client = httpx.Client(
            base_url=config.rest_url,
            headers=headers,
            timeout=httpx.Timeout(30.0, connect=10.0),
        )

    # ------------------------------------------------------------ HTTP

    def _throttle(self) -> None:
        """Gaz ADAPTOR seviyesinde yasar (reliability.md §4) — GraphQL
        adaptoruyle AYNI kural: retry tekrarlari dahil HER HTTP istegi bu
        kapidan gecer; bulk dongusunde ayrica bekleme YOKTUR."""
        gap_seconds = self.config.min_request_gap_ms / 1000.0
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < gap_seconds:
            time.sleep(gap_seconds - elapsed)
        self._last_request_at = time.monotonic()

    def _request_once(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        expect: int | None = None,
    ) -> Any:
        """TEK HTTP denemesi. Retry karari burada DEGIL, execute()'ta verilir."""
        self._throttle()
        try:
            response = self._client.request(method, path, params=params, json=json_body)
        except httpx.HTTPError as exc:  # sirlar ASLA loglanmaz
            raise XurrentTransportError(
                f"Xurrent REST'e baglanilamadi: {exc.__class__.__name__}"
            ) from exc

        if response.status_code >= 400:
            self._raise_http_error(response)

        self._capture_rate_limit(response.headers)

        # "expect 201": POST /time_entries'in basari kodu 201'dir. 2xx olup
        # beklenenden farkli bir kod sema varsayimlarimizin KAYDIGINI gosterir.
        # UYARI ile yetinilir, hata FIRLATILMAZ: yazma sunucuda GERCEKLESMISTIR;
        # bunu belirsiz hataya cevirmek retry'i tetikler ve cift kayit riskini
        # bizzat biz yaratmis olurduk (DOGRULANMALI, docs/08).
        if expect is not None and response.status_code != expect:
            log.warning(
                "Beklenmeyen durum kodu: %s %s -> %s (beklenen %s). "
                "REST sema varsayimi DOGRULANMALI; yanit yine de islendi.",
                method,
                path,
                response.status_code,
                expect,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise XurrentTransportError(
                f"REST yaniti JSON degil: {method} {path}"
            ) from exc

    def _raise_http_error(self, response: httpx.Response) -> None:
        """HTTP >= 400 -> dogru exception tipi (reliability.md §1).

        422 AYRI tiptir: is kurali reddi govdesini tasir ve run_mutation onu
        exception olarak yukari SIZDIRMAZ — sozlesmedeki errors[] sekline
        cevirir. 429/5xx retry politikasinin gordugu tiplerle AYNIDIR.
        """
        body_errors: list[dict[str, Any]] = []
        try:
            parsed = response.json()
            if isinstance(parsed, dict) and isinstance(parsed.get("errors"), list):
                body_errors = [e for e in parsed["errors"] if isinstance(e, dict)]
        except ValueError:
            pass
        first_message = str((body_errors[0].get("message") if body_errors else None) or "")

        if response.status_code == 422:
            raise XurrentRestValidationError(
                f"Xurrent REST 422: {first_message or 'is kurali reddi'}",
                errors=body_errors,
            )

        retry_after: float | None = None
        raw = response.headers.get("retry-after")
        if raw is not None:
            try:
                retry_after = float(raw)
            except ValueError:
                retry_after = None  # tarih bicimi vb. — D15, saniye varsayildi
        raise XurrentHttpError(
            f"Xurrent REST HTTP {response.status_code}."
            + (f" Sunucu mesaji: {first_message}" if first_message else "")
            + " Token/hesap slug'ini kontrol edin.",
            status=response.status_code,
            retry_after=retry_after,
        )

    def execute(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        expect: int | None = None,
        op_class: str = "query",
        op_label: str = "query",
        on_uncertain: Any = None,
    ) -> Any:
        """Tek bir REST operasyonu calistirir — retry politikasiyla birlikte.

        Retry TRANSPORTUN degil OPERASYONUN ozelligidir; sinif cagirandan gelir.
        Iz etiketi (op_label) GraphQL kosusuyla AYNI mantiktadir: okumalar
        "query", yazmalar mutation path'i — senaryo koşucusu izleri transport
        bagimsiz sayar (reliability.md §6).
        """
        return execute_with_retry(
            lambda: self._request_once(
                method, path, params=params, json_body=json_body, expect=expect
            ),
            op=op_label,
            op_class=op_class,
            max_attempts=self.config.retry_max_attempts,
            base_ms=self.config.retry_base_ms,
            cap_ms=self.config.retry_cap_ms,
            on_uncertain=on_uncertain,
        )

    def _capture_rate_limit(self, headers: httpx.Headers) -> None:
        """x-ratelimit-* basliklari GraphQL yolundakiyle AYNI sekilde yakalanir."""

        def _num(name: str) -> float | None:
            raw = headers.get(name)
            try:
                return float(raw) if raw is not None else None
            except ValueError:
                return None

        limit = _num("x-ratelimit-limit")
        remaining = _num("x-ratelimit-remaining")
        if limit is None and remaining is None:
            return
        self._rate_limit = RateLimit(
            limit=limit or 0,
            cost=_num("x-ratelimit-cost") or 0,
            remaining=remaining or 0,
            resetAt=_num("x-ratelimit-reset") or 0,
        )

    # ------------------------------------------------------------ kimlik

    def whoami(self) -> tuple[Person, Account, RateLimit | None]:
        """GET /me + GET /account — IKI istek.

        ★ Ogretilen kontrast: GraphQL ayni bilgiyi TEK sorguda dondurur
        (me + account + rateLimit). REST'te kaynak basina bir uc nokta vardir;
        "1 sorgu vs N istek" farki dersin kendisidir (docs/16).
        """
        me_raw = self.execute("GET", "/me", op_label="query")
        acc_raw = self.execute("GET", "/account", op_label="query")
        me = me_raw if isinstance(me_raw, dict) else {}
        acc = acc_raw if isinstance(acc_raw, dict) else {}
        self._me_id = str(me.get("id")) if me.get("id") else None
        self._account = Account(
            id=str(acc.get("id") or self.config.account or "unknown"),
            name=acc.get("name"),
            directory=acc.get("directory"),
        )
        return self._to_person(me), self._account, self._rate_limit

    def find_person(self, email: str, view: str = "all") -> list[Person]:
        # TAM eslesme — REST'te de primary_email filtresi substring DEGILDIR.
        rows = self.execute(
            "GET", "/people", params={"primary_email": email}, op_label="query"
        )
        return [self._to_person(r) for r in (rows or []) if isinstance(r, dict)]

    def resolve_person_id(self, person_id: str | None) -> str:
        """'$me' cozumu: REST sorgu parametrelerine $me GONDERILMEZ; once /me
        ile gercek id alinir (whoami cache'ler), sorgular o id ile kurulur."""
        if person_id and person_id != "$me":
            return person_id
        if self._me_id is None:
            self.whoami()
        return str(self._me_id)

    def account_id(self) -> str:
        if self._account is None:
            self.whoami()
        return self._account.id if self._account else (self.config.account or "unknown")

    # ------------------------------------------------------------ acik isler

    def list_open_requests(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        # TUZAK GraphQL'dekiyle AYNI: Request'te atanan kisi parametresi
        # 'member'dir. REST liste yaniti duz dizidir — sayfa bilgisi yoktur.
        rows = self.execute(
            "GET", "/requests", params={"member": person_id}, op_label="query"
        )
        return self._to_page(rows or [], "request", first)

    def list_open_tasks(
        self, person_id: str, first: int, after: str | None, view: str
    ) -> WorkPage:
        # TUZAK: Task'ta parametre 'assignee'dir ('member' SESSIZ bos doner).
        rows = self.execute(
            "GET", "/tasks", params={"assignee": person_id}, op_label="query"
        )
        return self._to_page(rows or [], "task", first)

    def _to_page(self, rows: list[dict[str, Any]], kind: str, first: int) -> WorkPage:
        window = rows[: max(1, first)]
        return WorkPage(
            totalCount=len(rows),
            hasNextPage=len(rows) > len(window),
            endCursor=None,
            nodes=[self._to_work_item(r, kind) for r in window],
        )

    @staticmethod
    def _to_work_item(node: dict[str, Any], kind: str) -> WorkItem:
        status = node.get("status")
        workflow = node.get("workflow") or {}
        return WorkItem(
            kind=kind,
            id=str(node.get("id")),
            # REST'te UI numarasi ayri alandir: source_display_id.
            displayId=str(node.get("source_display_id") or node.get("id")),
            subject=node.get("subject"),
            status=status,
            statusLabel=STATUS_LABELS_TR.get(status or "", status),
            isOpen=True,
            # Request'te next_target_at, Task'ta completion_target_at.
            targetAt=node.get("next_target_at") or node.get("completion_target_at"),
            team=(node.get("team") or {}).get("name"),
            member=(node.get("member") or {}).get("name"),
            parentLabel=workflow.get("subject"),
            updatedAt=node.get("updated_at"),
        )

    # ------------------------------------------------------------ zaman baglami

    def time_tracking_context(self, person_id: str) -> TimeTrackingContext:
        """UC ayri GET: /timesheet_settings + /effort_classes + /time_allocations.

        GraphQL bunlari TEK sorguda getirir; REST'te kaynak basina istek.
        disabled effort class'lar CLIENT tarafinda elenir — GraphQL'deki
        "EffortClassFilter'da disabled filtresi yok" dersinin REST ikizi.
        """
        if self._context_cache is not None:
            return self._context_cache

        settings_rows = self.execute("GET", "/timesheet_settings", op_label="query")
        setting = (
            settings_rows[0]
            if isinstance(settings_rows, list) and settings_rows
            else {}
        )

        effort_rows = self.execute("GET", "/effort_classes", op_label="query")
        effort_classes = [
            EffortClass(
                id=str(n["id"]),
                name=n.get("name"),
                position=n.get("position"),
                costMultiplier=n.get("cost_multiplier"),
                disabled=n.get("disabled", False),
            )
            for n in (effort_rows or [])
            if not n.get("disabled", False)
        ]

        alloc_rows = self.execute("GET", "/time_allocations", op_label="query")
        allocations = [
            TimeAllocation(
                id=str(n["id"]),
                name=n.get("name"),
                group=n.get("group"),
                descriptionRequired=n.get("description_required", False),
            )
            for n in (alloc_rows or [])
        ]

        def _ref(key: str) -> str | None:
            value = setting.get(key)
            return str(value.get("id")) if isinstance(value, dict) and value.get("id") else None

        context = TimeTrackingContext(
            unit=setting.get("unit"),
            # Varsayilan 60 — bos alan sessizce reddedilen 45 dk'lari onler.
            timeIncrement=setting.get("time_increment") or 60,
            workday=setting.get("workday") or 480,
            workweek=setting.get("workweek") or 2400,
            allowWorkdayOvertime=setting.get("allow_workday_overtime"),
            allowWorkweekOvertime=setting.get("allow_workweek_overtime"),
            allocationTimeTracking=setting.get("allocation_time_tracking"),
            assignmentTimeTracking=setting.get("assignment_time_tracking"),
            requireNote=setting.get("require_note"),
            requireTimeEntryDescription=setting.get("require_time_entry_description"),
            effortClasses=effort_classes,
            timeAllocations=allocations,
            defaults=TimeTrackingDefaults(
                requestEffortClassId=_ref("request_effort_class"),
                taskEffortClassId=_ref("task_effort_class"),
                projectTaskEffortClassId=_ref("project_task_effort_class"),
                problemEffortClassId=_ref("problem_effort_class"),
                timeAllocationEffortClassId=_ref("time_allocation_effort_class"),
            ),
        )
        self._context_cache = context
        return context

    def minutes_logged_on(self, person_id: str, date_iso: str) -> int:
        # Canli modda ek sorgu maliyetinden kacinilir; sunucu kendi workday
        # dogrulamasini zaten yapar (GraphQL adaptoruyle ayni karar).
        return 0

    # ------------------------------------------------------------ mutation

    def run_mutation(self, planned: dict[str, Any]) -> dict[str, Any]:
        """Planlanmis mutation'i REST'e cevirip OPERASYON SINIFINA gore kosar.

        Sozlesmenin ic dili GraphQL mutation path'leridir (timeEntryCreate...);
        adaptor bunlari HTTP fiil+yola cevirir. Sinif haritasi AYNIDIR
        (OP_CLASS_BY_PATH) — politika transporta gore DEGISMEZ.
        """
        path = planned["path"]
        input_payload = dict(planned.get("input", {}))
        op_class = OP_CLASS_BY_PATH.get(path, "no_retry")

        on_uncertain = None
        if op_class == "guarded_create":
            source_id = str(input_payload.get("sourceID") or "")

            def _dedup_read_back() -> dict[str, Any] | None:
                """Belirsiz hata sonrasi 'yazilmis mi?' — GET /time_entries?sourceID=.

                Kayit VARSA ilk deneme islenmis demektir: mevcut kayit BASARI
                olarak doner, kor retry'in cift kaydi onlenir. YOKSA retry surer.
                """
                if not source_id:
                    return None
                try:
                    entry = self.find_time_entry_by_source_id(source_id)
                except XurrentTransportError:
                    return None  # geri-okuma da dustu -> karar yok, retry surer
                log_dedup(source_id, entry is not None)
                if entry is None:
                    return None
                return {"__deduped__": entry}

            on_uncertain = _dedup_read_back

        try:
            if path == "timeEntryCreate":
                data = self.execute(
                    "POST",
                    "/time_entries",
                    json_body=self._create_body(input_payload),
                    expect=201,  # REST'te olusturmanin basari kodu 201'dir
                    op_class=op_class,
                    op_label=path,
                    on_uncertain=on_uncertain,
                )
                if isinstance(data, dict) and "__deduped__" in data:
                    return {
                        "timeEntry": data["__deduped__"],
                        "errors": [],
                        "deduped": True,
                    }
                return {"timeEntry": self._to_time_entry_record(data), "errors": []}

            if path == "timeEntryUpdate":
                entry_id = str(input_payload.get("id") or "")
                data = self.execute(
                    "PATCH",
                    f"/time_entries/{entry_id}",
                    json_body=self._update_body(input_payload),
                    op_class=op_class,
                    op_label=path,
                )
                return {"timeEntry": self._to_time_entry_record(data), "errors": []}

            resource = _PARENT_RESOURCE_BY_PATH.get(path)
            if resource is None:
                return {
                    "timeEntry": None,
                    "errors": [
                        {"message": f"Bilinmeyen mutation: {path}", "path": ["path"]}
                    ],
                }

            # Yol B — PATCH /requests/:id | /tasks/:id. time_spent ARTIMLIDIR;
            # date sunucuda "bugun", person authenticated user. Yanit PARENT'i
            # doner, olusan TimeEntry'yi DEGIL — two_step'in 2. adimi bu yuzden
            # kaydi ayrica bulmak zorundadir (find_latest_time_entry_id).
            parent_id = str(input_payload.get("id") or "")
            data = self.execute(
                "PATCH",
                f"/{resource}/{parent_id}",
                json_body=self._parent_body(input_payload),
                op_class=op_class,
                op_label=path,
            )
            parent = (
                {"id": str(data.get("id")), "subject": data.get("subject")}
                if isinstance(data, dict)
                else None
            )
            return {"timeEntry": None, "errors": [], "parent": parent}

        except XurrentRestValidationError as exc:
            # ★ 422 = is kurali reddi. Exceptional DEGILDIR ve retry EDILMEMISTIR
            # (classify 422 -> None). GraphQL yolunun "payload.errors" cikisiyla
            # AYNI sekle normallesir: bulk akisi devam edebilmeli.
            return {"timeEntry": None, "errors": self._rest_errors(exc)}
        except XurrentTransportError as exc:
            # Diger transport hatalari da exception olarak YUKARI SIZMAZ.
            return {
                "timeEntry": None,
                "errors": [
                    {"message": transport_error_message(path, op_class, exc), "path": None}
                ],
            }

    @staticmethod
    def _rest_errors(exc: XurrentRestValidationError) -> list[dict[str, Any]]:
        """REST 422 govdesi -> sozlesme errors[] sekli.

        {message, attribute} -> {message, path:[attribute]}. attribute yoksa
        path null kalir — GraphQL payload.errors'un path alaniyla ayni anlam.
        """
        rows = exc.errors or [{"message": str(exc), "attribute": None}]
        return [
            {
                "message": str(e.get("message") or "REST 422: is kurali reddi"),
                "path": [str(e["attribute"])] if e.get("attribute") else None,
            }
            for e in rows
        ]

    @staticmethod
    def _create_body(input_payload: dict[str, Any]) -> dict[str, Any]:
        """TimeEntryCreateInput (camelCase) -> POST /time_entries govdesi.

        snake_case cevirisi ALAN ALAN ve ACIKTIR — jenerik bir camel->snake
        donusturucu sourceID'yi "source_i_d" yapar ve sessizce yanlis olurdu.
        clientMutationId GraphQL'e ozgudur; REST'e GONDERILMEZ.
        """
        mapping = (
            ("timeSpent", "time_spent"),
            ("date", "date"),
            ("startedAt", "started_at"),
            ("personId", "person_id"),
            ("description", "description"),
            ("effortClassId", "effort_class_id"),
            ("timeAllocationId", "time_allocation_id"),
            ("correction", "correction"),
            ("source", "source"),
            ("sourceID", "sourceID"),  # ★ ISTISNA: REST'te de sourceID yazilir
            ("customerId", "customer_id"),
            ("serviceId", "service_id"),
            ("organizationId", "organization_id"),
            ("teamId", "team_id"),
        )
        return {
            rest_key: input_payload[camel]
            for camel, rest_key in mapping
            if input_payload.get(camel) is not None
        }

    @staticmethod
    def _update_body(input_payload: dict[str, Any]) -> dict[str, Any]:
        """TimeEntryUpdateInput -> PATCH /time_entries/:id govdesi.

        two_step'in dayanagi REST'te de aynidir: govdede assignment YOKTUR,
        dolayisiyla bu adim ticket bagini BOZAMAZ. Fark: REST PATCH source ve
        sourceID alanlarini da kabul eder (GraphQL TimeEntryUpdateInput ETMEZ);
        planlayici gonderirse aynen gecirilir.
        """
        mapping = (
            ("timeSpent", "time_spent"),
            ("date", "date"),
            ("startedAt", "started_at"),
            ("personId", "person_id"),
            ("description", "description"),
            ("effortClassId", "effort_class_id"),
            ("correction", "correction"),
            ("source", "source"),
            ("sourceID", "sourceID"),
        )
        return {
            rest_key: input_payload[camel]
            for camel, rest_key in mapping
            if input_payload.get(camel) is not None
        }

    @staticmethod
    def _parent_body(input_payload: dict[str, Any]) -> dict[str, Any]:
        """RequestUpdateInput/TaskUpdateInput -> PATCH /requests|tasks/:id govdesi.

        ⚠️ Gercek REST'te time_spent parametresinin adi/varligi DOGRULANMAMISTIR
        (docs/08) — davranis GraphQL requestUpdate/taskUpdate ile bilinçli
        olarak AYNI tutuldu (sahte sunucu da oyle taklit eder).
        """
        mapping = (
            ("timeSpent", "time_spent"),
            ("timeSpentEffortClassId", "time_spent_effort_class_id"),
            ("timeEntryDescription", "time_entry_description"),
            ("note", "note"),
        )
        return {
            rest_key: input_payload[camel]
            for camel, rest_key in mapping
            if input_payload.get(camel) is not None
        }

    # ------------------------------------------------------------ okumalar

    def find_latest_time_entry_id(self, person_id: str) -> str | None:
        """two_step 2. adimi icin en son olusan entry — REST karsiligi.

        PATCH /requests/:id yaniti PARENT'i doner, olusan TimeEntry'yi DEGIL.
        GET /time_entries?person&date=bugun en yenisi ONCE doner; ilkini aliriz.
        """
        rows = self.execute(
            "GET",
            "/time_entries",
            params={
                "person": person_id,
                "date": today_in(self.config.timezone).isoformat(),
            },
            op_label="query",
        )
        return str(rows[0]["id"]) if rows else None

    def list_time_entries(
        self,
        person_id: str,
        date_from: str | None,
        date_to: str | None,
        source_id: str | None,
        first: int,
    ) -> list[dict[str, Any]]:
        """xurrent_list_time_entries — GET /time_entries.

        Parametre adlari sahte sunucuyla BIREBIR ayni olmak zorundadir:
        person / date_from / date_to / sourceID (snake_case; sourceID istisna).
        """
        params: dict[str, Any] = {"person": person_id}
        if date_from:
            params["date_from"] = date_from
        if date_to:
            params["date_to"] = date_to
        if source_id:
            params["sourceID"] = source_id
        rows = self.execute("GET", "/time_entries", params=params, op_label="query")
        return [
            self._to_time_entry_record(r)
            for r in (rows or [])[: max(1, first)]
            if isinstance(r, dict)
        ]

    def find_time_entry_by_source_id(self, source_id: str) -> dict[str, Any] | None:
        """Dedup geri-okumasi (reliability.md §5) — GET /time_entries?sourceID=.

        Query sinifidir; kendisi de retry politikasindan gecer. D14 notu REST
        icin de gecerlidir: gercek /time_entries'te sourceID filtresinin
        varligi DOGRULANMALI'dir.
        """
        if not source_id:
            return None
        rows = self.execute(
            "GET", "/time_entries", params={"sourceID": source_id}, op_label="query"
        )
        return self._to_time_entry_record(rows[0]) if rows else None

    @staticmethod
    def _to_time_entry_record(raw: Any) -> dict[str, Any]:
        """REST time entry (snake_case) -> contract $defs/TimeEntryRecord.

        Ic sozlesme camelCase'tir; snake_case wire'da kalir. Bu fonksiyon
        adaptorun "cevirmen" rolunun ta kendisidir.
        """
        node = raw if isinstance(raw, dict) else {}
        person = node.get("person") or None
        effort = node.get("effort_class") or None
        assignment_raw = node.get("assignment") or None
        assignment = None
        if assignment_raw and assignment_raw.get("id"):
            assignment = {
                "type": assignment_raw.get("type"),
                "id": str(assignment_raw["id"]),
                # REST assignment referansi UI numarasi tasimaz.
                "displayId": None,
            }
        return {
            "id": str(node.get("id")),
            "date": node.get("date"),
            "startedAt": node.get("started_at"),
            "timeSpent": int(node.get("time_spent") or 0),
            "description": node.get("description"),
            "correction": node.get("correction"),
            "source": node.get("source"),
            "sourceID": node.get("sourceID"),
            "person": (
                {"id": str(person.get("id")), "name": person.get("name")}
                if person
                else None
            ),
            "assignment": assignment,
            "effortClass": (
                {"id": str(effort.get("id")), "name": effort.get("name")}
                if effort
                else None
            ),
        }

    # ------------------------------------------------------------ yardimcilar

    def target_label(self, target_type: str, target_id: str) -> str | None:
        return None  # canli modda ek sorgu maliyetinden kacinilir

    def open_work_snapshot(self, person_id: str) -> list[WorkItem]:
        return [
            *self.list_open_requests(person_id, 100, None, "all").nodes,
            *self.list_open_tasks(person_id, 100, None, "all").nodes,
        ]

    def time_allocations(self) -> list[TimeAllocation]:
        return self.time_tracking_context(self.resolve_person_id(None)).timeAllocations

    @staticmethod
    def _to_person(raw: dict[str, Any]) -> Person:
        """REST person (snake_case) -> Person (camelCase ic sozlesme)."""
        return Person(
            id=str(raw.get("id", "")),
            name=raw.get("name"),
            primaryEmail=raw.get("primary_email"),
            jobTitle=raw.get("job_title"),
            timeZone=raw.get("time_zone"),
            disabled=raw.get("disabled"),
            organization=raw.get("organization"),
        )
