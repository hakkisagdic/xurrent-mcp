"""Ortam degiskenlerinin okunmasi ve dogrulanmasi.

NEDEN ayri bir modul: uc dil de AYNI env sozlesmesini kullanir (.env.example).
Yapilandirmayi tek yerde toplamak, "hangi degisken neyi aciyor" sorusunun
tek bir cevabi olmasini saglar.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

XurrentMode = Literal["mock", "live"]
# XURRENT_API — live modda transport secimi (bkz. docs/16 + .env.example §1):
#   graphql -> varsayilan; tek istekte zengin sorgu, is kurali hatalari
#              HTTP 200 + payload.errors.
#   rest    -> developer.xurrent.com/v1; alan adlari snake_case (sourceID
#              HARIC), validation hatalari HTTP 422, whoami/context N istek.
# Ikisi de AYNI tool sozlesmesini servis eder — transport bir adaptor detayidir.
XurrentApi = Literal["graphql", "rest"]
BackdateStrategy = Literal["two_step", "link_first", "date_first"]
CalendarProvider = Literal["mock", "ics", "google", "graph", "auto"]
RoundingMode = Literal["nearest", "up", "down"]
# XURRENT_CONFIRM_POLICY — UC deger; uc dilde de AYNI anlam
# (referans: servers/csharp/Config.cs + Core/ToolImpl.cs).
#
#   "open"   -> Onay HIC sorulmaz, yazma serbesttir. YALNIZCA CI/otomasyon.
#   "closed" -> VARSAYILAN. Onay kanali varsa sorulur. Kanal YOKSA:
#               live modda yazma REDDEDILIR, mock modda uyari uretilip devam edilir.
#   "strict" -> Onay ZORUNLUDUR — mock modda da. Onay kanali yoksa yazma
#               REDDEDILIR. Varlik sebebi PEDAGOJIKTIR: MRTR mutlu yolunun
#               (InputRequiredResult -> kullaniciya sor -> istegi YENI id ile
#               tekrarla -> yaz) mock modda da CANLI gosterilebilmesi icin.
ConfirmPolicy = Literal["open", "closed", "strict"]
CONFIRM_POLICIES: tuple[str, ...] = ("open", "closed", "strict")
# MCP_PROTOCOL: hangi revizyonun ADVERTISE edildigini ve onayin hangi yolla
# kurulacagini secer. Resmi SDK (mcp 2.0.0) ikisini de konusur; bu degisken
# sunucunun hangi yuzunu gosterecegini belirler.
McpProtocol = Literal["2026-07-28", "2025-11-25", "both"]
MCP_PROTOCOL_V2 = "2026-07-28"
MCP_PROTOCOL_V1 = "2025-11-25"

# Xurrent bolgeleri. DIKKAT: "eu" diye bir bolge YOKTUR — graphql.eu.xurrent.com
# wildcard DNS ile cozulur ama TLS hatasi verir. Global zaten Avrupa'dadir.
KNOWN_GRAPHQL_HOSTS = (
    "https://graphql.xurrent.com",
    "https://graphql.au.xurrent.com",
    "https://graphql.uk.xurrent.com",
    "https://graphql.ch.xurrent.com",
    "https://graphql.us.xurrent.com",
    "https://graphql.xurrent.qa",
    "https://graphql.xurrent-demo.com",
)


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    return default if value is None or value == "" else value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = _env(name, "1" if default else "0").strip().lower()
    return raw in {"1", "true", "yes", "on", "evet"}


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _repo_root() -> Path:
    # servers/python/src/xurrent_mcp/config.py -> repo koku 4 seviye yukarida
    return Path(__file__).resolve().parents[4]


@dataclass(frozen=True)
class Config:
    """Calisma zamani yapilandirmasi. Sirlar ASLA loglanmaz."""

    mode: XurrentMode = "mock"
    token: str = ""
    account: str = ""
    graphql_url: str = "https://graphql.xurrent.com"
    # --- API transport secimi (XURRENT_API + XURRENT_REST_URL) ---
    # Yalnizca live modda anlamlidir; mock mod her zaman fixtures okur.
    api: XurrentApi = "graphql"
    rest_url: str = "https://api.xurrent.com/v1"

    dry_run: bool = False
    confirm_policy: ConfirmPolicy = "closed"
    source: str = "xurrent-mcp"

    # --- protokol ve onay state'i ---
    mcp_protocol: McpProtocol = MCP_PROTOCOL_V2
    # requestState imza anahtari. BOSSA surec basinda rastgele uretilir —
    # yeniden baslatinca eski onaylar gecersiz olur, bu ISTENEN davranistir.
    state_secret: str = ""
    state_ttl_seconds: int = 300
    # timesheet_wizard sessionState TTL'i (contract/wizard.md §4). requestState'in
    # 300'unden BILEREK uzun: cok adimli bir sohbet 5 dakikada bitmeyebilir.
    wizard_ttl_seconds: int = 1800

    backdate_strategy: BackdateStrategy = "two_step"
    max_backdate_days: int = 1

    # --- guvenilirlik (contract/reliability.md §3, §4, §7) ---
    # Toplam deneme sayisi, ILK istek dahil. 1 = retry tamamen kapali.
    retry_max_attempts: int = 5
    # Tam jitter'li ustel geri cekilme: bekleme_k = rastgele(0, min(CAP, BASE·2^(k-1))).
    retry_base_ms: int = 500
    retry_cap_ms: int = 8000
    # Adaptor gazi: iki HTTP istegi arasindaki minimum bosluk (retry dahil).
    # Xurrent siniri 20 istek / 2 sn -> varsayilan 110 ms.
    min_request_gap_ms: int = 110

    calendar_provider: CalendarProvider = "mock"
    ics_path: str = ""
    ics_url: str = ""

    google_client_id: str = ""
    google_client_secret: str = ""
    google_token_path: str = "~/.xurrent-mcp/google-token.json"
    google_calendar_id: str = "primary"
    google_sa_client_email: str = ""
    google_sa_private_key: str = ""
    google_impersonate_user: str = ""

    ms_tenant_id: str = ""
    ms_client_id: str = ""
    ms_client_secret: str = ""
    ms_impersonate_user: str = ""

    timezone: str = "Europe/Istanbul"
    default_time_allocation_id: str = ""
    rounding_mode: RoundingMode = "nearest"

    # --- LLM saglayicisi: TEK saglayici, Gemini ---
    # GEMINI_MODEL varsayilani `gemini-3.6-flash`: ai.google.dev/gemini-api/docs/models
    # icinde "Stable" isaretli EN GUNCEL flash modeli ve "agentic" gorevler icin
    # onerilen dengeli secenek. Preview modeller (ornegin gemini-3-flash-preview)
    # 2 hafta ihbarla kaldirilabildigi icin ders materyalinde KULLANILMAZ.
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.6-flash"
    # ★ Sahte sunucuya yonlendirmek icin degistirilebilir olmasi ZORUNLU:
    #   GEMINI_BASE_URL=http://127.0.0.1:5102 ile API anahtarsiz uctan uca test.
    gemini_base_url: str = "https://generativelanguage.googleapis.com"

    web_port: int = 8787
    mcp_http_port: int = 8788
    # MCP_API_KEY (.env.example §8) — HTTP yuzeyinin kapisi:
    #   BOS  -> sunucu YALNIZCA loopback'ten (127.0.0.1) dinler; mevcut durus.
    #   DOLU -> 0.0.0.0'a baglanir ve her /mcp* isteginde X-MCP-Api-Key
    #           basliginin bu degere esit olmasi ZORUNLUDUR (sabit-zamanli
    #           karsilastirma; aksi halde 401). Xurrent PAT'i ile KARISTIRMAYIN:
    #           bu anahtar MCP sunucusunun kendisini korur.
    mcp_api_key: str = ""
    # MCP_ALLOWED_HOSTS (virgülle ayrık, opsiyonel) — YALNIZCA anahtar DOLUYKEN
    # anlamlıdır:
    #   BOŞ  -> açık modda TÜM Host başlıkları geçer; kapı API anahtarının
    #           KENDİSİDİR. NEDEN: konteynerler arası çağrıda Host asla
    #           "localhost" olmaz; Host süzgeci burada koruma değil 421
    #           üreten bir engel olurdu.
    #   DOLU -> açık modda bile yalnızca listedeki Host'lar kabul edilir
    #           (derinlemesine savunma: anahtar sızarsa saldırgan yine de
    #           doğru Host'u bilmek zorundadır). Girdi "host" ise "host:port"
    #           varyantları da kabul edilir; ":port" içeren girdi birebir aranır.
    # Anahtar BOŞKEN bu liste YOK SAYILIR — loopback modunun katı localhost
    # duruşu değişmez (warnings() bunu açıkça söyler).
    mcp_allowed_hosts: tuple[str, ...] = ()

    fixtures_dir: Path = field(default_factory=lambda: _repo_root() / "fixtures")
    wizard_steps_path: Path = field(
        default_factory=lambda: _repo_root() / "docs" / "wizard" / "steps.json"
    )
    web_client_dir: Path = field(default_factory=lambda: _repo_root() / "clients" / "web")

    # --- turetilmis yardimcilar ---

    @property
    def is_live(self) -> bool:
        return self.mode == "live"

    def warnings(self) -> list[str]:
        """Yapilandirma uyarilari (Turkce). stderr'e yazilir, stdout'a ASLA."""
        out: list[str] = []
        if self.mode == "live":
            if not self.token:
                out.append("XURRENT_MODE=live ama XURRENT_TOKEN bos — istekler 401 alir.")
            if not self.account:
                out.append(
                    "XURRENT_ACCOUNT bos. Bu deger NUMERIK DEGIL, kisa slug'dir (orn. 'widget'). "
                    "Ic personelin time entry'leri DIRECTORY ACCOUNT'ta yasar."
                )
        if ".eu." in self.graphql_url:
            out.append(
                "XURRENT_GRAPHQL_URL icinde 'eu' bolgesi var. 'eu' DIYE BIR BOLGE YOKTUR — "
                "TLS hatasi alirsiniz. Global (varsayilan) zaten Avrupa'dadir."
            )
        # Bolge kurali REST tabaninda da aynidir (.env.example §1).
        if ".eu." in self.rest_url:
            out.append(
                "XURRENT_REST_URL icinde 'eu' bolgesi var. 'eu' DIYE BIR BOLGE YOKTUR — "
                "Global (varsayilan) zaten Avrupa'dadir."
            )
        if self.api == "rest" and not self.is_live:
            out.append(
                "XURRENT_API=rest ama XURRENT_MODE=mock — transport secimi yalnizca "
                "live modda anlamlidir; mock adapter fixtures'tan okumaya devam ediyor."
            )
        if self.max_backdate_days < 0:
            out.append("XURRENT_MAX_BACKDATE_DAYS negatif olamaz; 0 kabul edildi.")
        if self.confirm_policy == "open":
            out.append(
                "XURRENT_CONFIRM_POLICY=open — yazma oncesi onay HIC sorulmuyor. "
                "Bu ayar YALNIZCA CI/otomasyon icindir."
            )
        elif self.confirm_policy == "strict":
            out.append(
                "XURRENT_CONFIRM_POLICY=strict — mock modda bile onay ZORUNLU. "
                "Onay soramayan bir client ile yapilan yazma REDDEDILIR."
            )
        if self.mcp_allowed_hosts and not self.mcp_api_key:
            out.append(
                "MCP_ALLOWED_HOSTS verildi ama MCP_API_KEY bos — liste YOK SAYILIYOR. "
                "Anahtarsiz mod her zaman yalnizca loopback'tir; Host allowlist'i "
                "yalnizca acik modda (anahtar doluyken) uygulanir."
            )
        if not self.state_secret:
            out.append(
                "XURRENT_STATE_SECRET bos — requestState imza anahtari surec basinda "
                "RASTGELE uretildi. Sunucu yeniden baslayinca bekleyen onaylar gecersiz olur. "
                "Coklu surec/HTTP dagitiminda bu degeri ACIKCA verin."
            )
        # Anahtarin URL'e sizmasi en sik yapilan Gemini hatasidir: query string
        # ters vekil ve CDN erisim loglarina duser. Sessizce calisir, sonra sizar.
        if "key=" in self.gemini_base_url.lower():
            out.append(
                "GEMINI_BASE_URL icinde 'key=' var. API anahtari URL'e KOYULMAZ — "
                "erisim loglarina duser. Anahtar x-goog-api-key HEADER'inda gider."
            )
        if self.gemini_base_url != "https://generativelanguage.googleapis.com":
            out.append(
                f"GEMINI_BASE_URL degistirildi: {self.gemini_base_url} — gercek Gemini'ye "
                "DEGIL, bu adrese istek gidiyor (ornegin tools/fake-gemini)."
            )
        return out


def load_config() -> Config:
    """Ortamdan yapilandirmayi okur. .env dosyasi varsa once onu yukler."""
    _load_dotenv_if_present()

    fixtures = _env("XURRENT_FIXTURES_DIR")
    fixtures_dir = Path(fixtures).expanduser() if fixtures else _repo_root() / "fixtures"

    mode_raw = _env("XURRENT_MODE", "mock").strip().lower()
    mode: XurrentMode = "live" if mode_raw == "live" else "mock"

    strategy_raw = _env("XURRENT_BACKDATE_STRATEGY", "two_step").strip().lower()
    strategy: BackdateStrategy = (
        strategy_raw if strategy_raw in ("two_step", "link_first", "date_first") else "two_step"
    )  # type: ignore[assignment]

    provider_raw = _env("CALENDAR_PROVIDER", "mock").strip().lower()
    provider: CalendarProvider = (
        provider_raw if provider_raw in ("mock", "ics", "google", "graph", "auto") else "mock"
    )  # type: ignore[assignment]

    rounding_raw = _env("ROUNDING_MODE", "nearest").strip().lower()
    rounding: RoundingMode = (
        rounding_raw if rounding_raw in ("nearest", "up", "down") else "nearest"
    )  # type: ignore[assignment]

    # Bilinmeyen bir deger ASLA en gevsek degere ("open") dusmez; guvenli taraf
    # varsayilanin kendisidir. Yanlis yazilmis bir politika sessizce onay
    # kapatmamalidir.
    policy_raw = _env("XURRENT_CONFIRM_POLICY", "closed").strip().lower()
    policy: ConfirmPolicy = (
        policy_raw if policy_raw in CONFIRM_POLICIES else "closed"
    )  # type: ignore[assignment]

    # Bilinmeyen bir deger SESSIZCE varsayilana dusmez; net Turkce hata verir.
    # Sebep: "MCP_PROTOCOL=2026-07-29" yazan biri v2 konustugunu SANIR ve
    # sessiz varsayilan bunu saatlerce gizler.
    protocol_raw = _env("MCP_PROTOCOL", MCP_PROTOCOL_V2).strip()
    if protocol_raw not in (MCP_PROTOCOL_V2, MCP_PROTOCOL_V1, "both"):
        raise ValueError(
            f"MCP_PROTOCOL degeri gecersiz: {protocol_raw!r}. "
            f"Izinli degerler: '{MCP_PROTOCOL_V2}' (varsayilan), '{MCP_PROTOCOL_V1}', 'both'."
        )
    protocol: McpProtocol = protocol_raw  # type: ignore[assignment]

    # XURRENT_API de sessizce varsayilana DUSMEZ (MCP_PROTOCOL ile ayni gerekce):
    # "XURRENT_API=rets" yazan biri REST konustugunu SANIR ve sessiz graphql
    # varsayilani bunu saatlerce gizler.
    api_raw = _env("XURRENT_API", "graphql").strip().lower()
    if api_raw not in ("graphql", "rest"):
        raise ValueError(
            f"XURRENT_API degeri gecersiz: {api_raw!r}. "
            "Izinli degerler: 'graphql' (varsayilan), 'rest'."
        )
    api: XurrentApi = api_raw  # type: ignore[assignment]

    return Config(
        mode=mode,
        token=_env("XURRENT_TOKEN"),
        account=_env("XURRENT_ACCOUNT"),
        graphql_url=_env("XURRENT_GRAPHQL_URL", "https://graphql.xurrent.com").rstrip("/"),
        api=api,
        rest_url=_env("XURRENT_REST_URL", "https://api.xurrent.com/v1").rstrip("/"),
        dry_run=_env_bool("XURRENT_DRY_RUN", False),
        confirm_policy=policy,
        source=_env("XURRENT_SOURCE", "xurrent-mcp"),
        mcp_protocol=protocol,
        state_secret=_env("XURRENT_STATE_SECRET"),
        state_ttl_seconds=max(1, _env_int("XURRENT_STATE_TTL", 300)),
        wizard_ttl_seconds=max(1, _env_int("XURRENT_WIZARD_TTL", 1800)),
        backdate_strategy=strategy,
        max_backdate_days=max(0, _env_int("XURRENT_MAX_BACKDATE_DAYS", 1)),
        # 1'in altina dusurmek "hic istek atma" demek olurdu — en az 1 deneme.
        retry_max_attempts=max(1, _env_int("XURRENT_RETRY_MAX_ATTEMPTS", 5)),
        retry_base_ms=max(0, _env_int("XURRENT_RETRY_BASE_MS", 500)),
        retry_cap_ms=max(0, _env_int("XURRENT_RETRY_CAP_MS", 8000)),
        min_request_gap_ms=max(0, _env_int("XURRENT_MIN_REQUEST_GAP_MS", 110)),
        calendar_provider=provider,
        ics_path=_env("CALENDAR_ICS_PATH", str(fixtures_dir / "calendar.ics")),
        ics_url=_env("CALENDAR_ICS_URL"),
        google_client_id=_env("GOOGLE_CLIENT_ID"),
        google_client_secret=_env("GOOGLE_CLIENT_SECRET"),
        google_token_path=_env("GOOGLE_TOKEN_PATH", "~/.xurrent-mcp/google-token.json"),
        google_calendar_id=_env("GOOGLE_CALENDAR_ID", "primary"),
        google_sa_client_email=_env("GOOGLE_SA_CLIENT_EMAIL"),
        google_sa_private_key=_env("GOOGLE_SA_PRIVATE_KEY"),
        google_impersonate_user=_env("GOOGLE_IMPERSONATE_USER"),
        ms_tenant_id=_env("MS_TENANT_ID"),
        ms_client_id=_env("MS_CLIENT_ID"),
        ms_client_secret=_env("MS_CLIENT_SECRET"),
        ms_impersonate_user=_env("MS_IMPERSONATE_USER"),
        timezone=_env("XURRENT_TIMEZONE", "Europe/Istanbul"),
        default_time_allocation_id=_env("DEFAULT_TIME_ALLOCATION_ID"),
        rounding_mode=rounding,
        gemini_api_key=_env("GEMINI_API_KEY"),
        gemini_model=_env("GEMINI_MODEL", "gemini-3.6-flash"),
        gemini_base_url=_env(
            "GEMINI_BASE_URL", "https://generativelanguage.googleapis.com"
        ).rstrip("/"),
        web_port=_env_int("WEB_PORT", 8787),
        mcp_http_port=_env_int("MCP_HTTP_PORT", 8788),
        mcp_api_key=_env("MCP_API_KEY"),
        # Virgülle ayrık liste; bos parcalar ve kenar bosluklari elenir.
        mcp_allowed_hosts=tuple(
            h.strip() for h in _env("MCP_ALLOWED_HOSTS").split(",") if h.strip()
        ),
        fixtures_dir=fixtures_dir,
        wizard_steps_path=_repo_root() / "docs" / "wizard" / "steps.json",
        web_client_dir=_repo_root() / "clients" / "web",
    )


def _load_dotenv_if_present() -> None:
    """Repo kokundeki .env dosyasini cok basit sekilde yukler.

    NEDEN elle: python-dotenv bagimliligi eklemek yerine 20 satirlik bir parser
    yeterli. Var olan ortam degiskenlerinin UZERINE YAZMAZ — surec ortami her
    zaman dosyadan onceliklidir (.mcp.json env blogu boyle calisir).
    """
    for candidate in (_repo_root() / ".env", Path.cwd() / ".env"):
        if not candidate.is_file():
            continue
        try:
            text = candidate.read_text(encoding="utf-8")
        except OSError:
            continue
        for raw_line in text.splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
        break
