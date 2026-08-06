#!/usr/bin/env python3
"""
HCL dogrulayici — `terraform fmt -check` ve `terraform validate` YERINE GECER.

  uv run --no-project --with python-hcl2 python deploy/terraform/dogrula.py deploy/terraform

★ NEDEN VAR: bu iskelet yazilirken makinede terraform (ve OpenTofu) KURULU
  DEGILDI. Resmi araclar kurulunca bu betik GEREKSIZDIR — o zaman sunlari
  calistirin ve bu dosyayi silin:

      terraform -chdir=deploy/terraform/envs/dev init -backend=false
      terraform fmt -recursive -check deploy/terraform
      terraform -chdir=deploy/terraform/envs/dev validate

NE YAKALAR
  1. AYRISTIRMA  gercek bir HCL2 ayristiricisi (python-hcl2) dosyayi okuyabiliyor mu
  2. BICIM       ardisik atama satirlarinda `=` hizasi, sekme, satir sonu bosluk,
                 girinti, dosya sonu yeni satiri
  3. ANLAM       tanimsiz var./local./kaynak atiflari, modul cagrisinda bilinmeyen
                 ya da eksik argüman, alt modulden var olmayan cikti okumak

NE YAKALAMAZ  (ve bu bilinerek boyle)
  · SAGLAYICI SEMA UYUMU. `google_cloud_run_v2_service` gercekten
    `session_affinity` alani kabul ediyor mu — bunu yalnizca saglayici indirilerek
    dogrulanabilir. Yani "TEMIZ" ciktisi "apply calisir" demek DEGILDIR.
  · Terraform'un tip sistemi, `for_each` bilinirligi, saglayici surum cozumu.

BICIM MODELI — dayanagi ne
  `terraform fmt` (hclwrite) ardisik atama satirlarini "zincir" halinde hizalar.
  Zincirin girinti degisiminde kirildigini HashiCorp'un kendi fmt'lenmis
  ornegi kanitlar:

      required_providers {
        google = {           ← tek bosluk
          source  = "..."    ← yalnizca kendi araligiyla hizali
          version = "..."
        }
      }

  `google` ic satirlarla ayni zincirde olsaydi `google    = {` olurdu; olmuyor.
"""

import re
import sys
from pathlib import Path

try:
    import hcl2
except ImportError:  # pragma: no cover
    print("python-hcl2 gerekli:  uv run --no-project --with python-hcl2 python <bu dosya> <dizin>")
    raise SystemExit(2)

ASSIGN_RE = re.compile(r"^(\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*)=(?!=)(.*)$")
HEREDOC_RE = re.compile(r"\s*<<-?([A-Za-z_][A-Za-z0-9_]*)")

# Terraform'un kendi ad alanlari — kaynak atfi sanilmasinlar.
YERLESIK = {"var", "local", "module", "each", "data", "self", "path", "terraform"}
# python-hcl2'nin ekledigi ust veri anahtarlari.
USTVERI = {"__is_block__", "__comments__", "__start_line__", "__end_line__"}
# Modul cagrisinda argüman SAYILMAYAN meta alanlar.
META = {"source", "count", "for_each", "providers", "depends_on", "version", "lifecycle"} | USTVERI

hatalar: list[str] = []
notlar: list[str] = []
sayac = {"dosya": 0, "satir": 0, "zincir": 0}


def unq(s: str) -> str:
    """python-hcl2 blok etiketlerini tirnaklariyla birlikte dondurur."""
    s = str(s)
    return s[1:-1] if len(s) >= 2 and s[0] == '"' and s[-1] == '"' else s


def etiketler(bloklar: list) -> dict:
    out: dict = {}
    for b in bloklar:
        for ad, govde in b.items():
            out[unq(ad)] = govde
    return out


# ═════════════════════════════════════════════════════════════════════════════
# 1 + 2 — AYRISTIRMA ve BICIM
# ═════════════════════════════════════════════════════════════════════════════

def ayristir(yol: Path) -> None:
    try:
        with yol.open("r", encoding="utf-8") as fh:
            hcl2.load(fh)
    except Exception as exc:  # noqa: BLE001
        hatalar.append(f"{yol}: AYRISTIRILAMADI: {type(exc).__name__}: {exc}")


def bicim(yol: Path) -> None:
    metin = yol.read_text(encoding="utf-8")
    satirlar = metin.split("\n")
    sayac["satir"] += len(satirlar)

    if not metin.endswith("\n"):
        hatalar.append(f"{yol}: dosya yeni satirla bitmiyor")

    heredoc_icinde = False
    heredoc_etiketi = ""
    zincir: list[tuple[int, int, int, str]] = []  # (satir, girinti, ad uzunlugu, ad)
    onceki_bosluk: dict[int, int] = {}

    def zinciri_kapat() -> None:
        if not zincir:
            return
        sayac["zincir"] += 1
        genislik = max(g + u for _, g, u, _ in zincir)
        for satir_no, girinti, ad_uz, ad in zincir:
            beklenen = genislik - (girinti + ad_uz) + 1
            gercek = onceki_bosluk[satir_no]
            if gercek != beklenen:
                hatalar.append(
                    f"{yol}:{satir_no}: `{ad}` icin `=` oncesi {gercek} bosluk var, "
                    f"{beklenen} olmali (zincir genisligi {genislik})"
                )
        zincir.clear()

    for i, ham in enumerate(satirlar, start=1):
        if ham != ham.rstrip():
            hatalar.append(f"{yol}:{i}: satir sonunda bosluk var")
        if "\t" in ham:
            hatalar.append(f"{yol}:{i}: sekme karakteri var")

        if heredoc_icinde:
            if ham.strip() == heredoc_etiketi:
                heredoc_icinde = False
            zinciri_kapat()
            continue

        kirpik = ham.strip()
        if not kirpik or kirpik.startswith("#") or kirpik.startswith("//"):
            zinciri_kapat()
            continue

        m = ASSIGN_RE.match(ham)
        if not m:
            zinciri_kapat()
            continue

        girinti, ad, aralik, kalan = m.group(1), m.group(2), m.group(3), m.group(4)
        if len(girinti) % 2 != 0:
            hatalar.append(f"{yol}:{i}: girinti 2'nin kati degil ({len(girinti)})")

        # Girinti degisimi zinciri kirar (bkz. dosya basindaki kanit).
        if zincir and zincir[-1][1] != len(girinti):
            zinciri_kapat()

        hd = HEREDOC_RE.match(kalan)
        if hd:
            heredoc_icinde = True
            heredoc_etiketi = hd.group(1)

        onceki_bosluk[i] = len(aralik)
        zincir.append((i, len(girinti), len(ad), ad))

    zinciri_kapat()


# ═════════════════════════════════════════════════════════════════════════════
# 3 — ANLAM
# ═════════════════════════════════════════════════════════════════════════════

def dizini_yukle(d: Path) -> dict:
    birlesik: dict = {}
    for f in sorted(d.glob("*.tf")):
        with f.open("r", encoding="utf-8") as fh:
            veri = hcl2.load(fh)
        for k, v in veri.items():
            birlesik.setdefault(k, []).extend(v)
    return birlesik


def govde_metni(d: Path) -> str:
    ham = "\n".join(f.read_text(encoding="utf-8") for f in sorted(d.glob("*.tf")))
    # Yorum satirlari atif SAYILMAZ: belgede bilerek "var.x" gecebilir.
    return "\n".join(s for s in ham.split("\n") if not s.strip().startswith("#"))


def anlam(d: Path) -> None:
    ayrisik = dizini_yukle(d)
    govde = govde_metni(d)

    degiskenler = set(etiketler(ayrisik.get("variable", [])))
    ciktilar = set(etiketler(ayrisik.get("output", [])))
    moduller = etiketler(ayrisik.get("module", []))

    yereller: set[str] = set()
    for blok in ayrisik.get("locals", []):
        yereller |= {k for k in blok if k not in USTVERI}

    kaynaklar: set[str] = set()
    for b in ayrisik.get("resource", []):
        for tur, ic in b.items():
            for ad in ic:
                kaynaklar.add(f"{unq(tur)}.{unq(ad)}")

    for m in re.finditer(r"\bvar\.([A-Za-z_][A-Za-z0-9_]*)", govde):
        if m.group(1) not in degiskenler:
            hatalar.append(f"{d}: tanimsiz degisken: var.{m.group(1)}")

    for m in re.finditer(r"\blocal\.([A-Za-z_][A-Za-z0-9_]*)", govde):
        if m.group(1) not in yereller:
            hatalar.append(f"{d}: tanimsiz local: local.{m.group(1)}")

    for m in re.finditer(r"\bmodule\.([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\.([A-Za-z_][A-Za-z0-9_]*)", govde):
        mod, cikti = m.group(1), m.group(2)
        if mod not in moduller:
            hatalar.append(f"{d}: tanimsiz modul atfi: module.{mod}")
            continue
        cocuk = (d / unq(moduller[mod].get("source", ""))).resolve()
        if cikti not in set(etiketler(dizini_yukle(cocuk).get("output", []))):
            hatalar.append(f"{d}: module.{mod} '{cikti}' ciktisini vermiyor ({cocuk.name})")

    for m in re.finditer(r"\b([a-z][a-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?:\[[^\]]*\])?\.[A-Za-z_]", govde):
        tur, ad = m.group(1), m.group(2)
        if tur in YERLESIK or ("_" not in tur and tur != "random"):
            continue
        if f"{tur}.{ad}" not in kaynaklar:
            hatalar.append(f"{d}: tanimsiz kaynak atfi: {tur}.{ad}")

    for mod, cfg in moduller.items():
        cocuk = (d / unq(cfg.get("source", ""))).resolve()
        if not cocuk.is_dir():
            hatalar.append(f"{d}: module.{mod} kaynagi yok: {cfg.get('source')}")
            continue
        cocuk_degiskenleri = etiketler(dizini_yukle(cocuk).get("variable", []))
        zorunlu = {n for n, b in cocuk_degiskenleri.items() if "default" not in b}
        gecirilen = {k for k in cfg if k not in META}

        for fazla in sorted(gecirilen - set(cocuk_degiskenleri)):
            hatalar.append(f"{d}: module.{mod} bilinmeyen argüman: {fazla}")
        for eksik in sorted(zorunlu - gecirilen):
            hatalar.append(f"{d}: module.{mod} EKSIK zorunlu argüman: {eksik}")

        notlar.append(f"module.{mod}: {len(gecirilen)} argüman geciyor, {len(cocuk_degiskenleri)} degisken tanimli")

    notlar.append(
        f"{d.name}: {len(degiskenler)} degisken · {len(yereller)} local · "
        f"{len(kaynaklar)} kaynak · {len(ciktilar)} cikti"
    )


def main() -> int:
    kok = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).parent)

    dosyalar: list[Path] = []
    for desen in ("*.tf", "*.tf.example", "*.tfvars.example"):
        dosyalar.extend(sorted(kok.rglob(desen)))
    for f in dosyalar:
        sayac["dosya"] += 1
        ayristir(f)
        bicim(f)

    for d in [p for p in sorted(kok.rglob("*")) if p.is_dir() and list(p.glob("*.tf"))]:
        anlam(d)

    for n in notlar:
        print("  " + n)
    print(f"\ndosya: {sayac['dosya']}  satir: {sayac['satir']}  hizalama zinciri: {sayac['zincir']}")

    if hatalar:
        print(f"\n{len(hatalar)} SORUN:\n")
        for h in hatalar:
            print("  " + h)
        return 1
    print("\nTEMIZ — soz dizimi, bicim ve capraz atiflar tutarli.")
    print("★ Bu 'apply calisir' demek DEGILDIR: saglayici sema uyumu dogrulanmadi.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
