/**
 * MCP inputSchema (JSON Schema 2020-12)  →  Gemini functionDeclarations şeması
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ★ BU DOSYA DERSİN KANITIDIR: "aynı sözleşme, iki farklı tool-calling lehçesi".
 *
 * MCP'nin 2026-07-28 revizyonu inputSchema'yı bilerek GEVŞETTİ: tam JSON Schema
 * 2020-12 kabul edilir. Gemini ise `functionDeclarations.parameters` alanında
 * OpenAPI şemasının yalnızca bir ALT KÜMESİNİ kabul eder:
 *
 *   Desteklenen : type · properties · required · description · enum · items
 *   Özel kural  : $ref / $defs DOLAR İŞARETİ OLMADAN yazılır → ref / defs
 *                 ref yalnızca defs'in DOĞRUDAN çocuğunu gösterebilir; DIŞ REFERANS YOK
 *                 azami iç içe derinlik 32
 *   Reddedebilir: çok büyük / çok derin şemalar
 *
 * Yani sözleşme ile sağlayıcı arasında bir ÇEVİRİCİ gerekir. Çevirici SAF bir
 * fonksiyondur (I/O yok, global yok) ve NE ATTIĞINI RAPORLAR — çünkü sessizce
 * düşen bir `pattern` veya `maxLength`, modelin artık bilmediği bir kısıttır.
 * Kaybı görünmez kılmak, kaybın kendisinden daha tehlikelidir.
 *
 * KORUMA KURALI: `default` değerleri atılır AMA açıklamaya metin olarak eklenir.
 * Sebep: `default`, modelin argüman üretirken gerçekten kullandığı bir bilgidir;
 * diğer kısıtlar (pattern/min/max) doğrulama içindir ve sunucu tarafında ZATEN
 * zod ile yeniden doğrulanır — orada kaybolmazlar.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tipler
// ─────────────────────────────────────────────────────────────────────────────

/** Gemini'nin kabul ettiği şema düğümü. */
export interface GeminiSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  items?: GeminiSchema;
  /** DOLARSIZ. Gemini `$ref` değil `ref` bekler ve yalnızca `#/defs/<Ad>` biçimini kabul eder. */
  ref?: string;
  /** DOLARSIZ. `$defs` karşılığı. */
  defs?: Record<string, GeminiSchema>;
}

/** Çeviride düşürülen bir anahtar kelime. Ders artifaktının ham verisi. */
export interface DroppedKeyword {
  /** Şema içindeki yol, ör. `#/properties/date`. */
  path: string;
  /** Düşürülen anahtar kelime, ör. `pattern`. */
  keyword: string;
  /** Düşürülen değer (raporda gösterilir; büyükse kısaltılır). */
  value: unknown;
  /** Türkçe gerekçe. */
  reason: string;
  /** Bilgi başka bir alana (genelde description) taşındı mı? */
  preserved: boolean;
}

/** Çeviri sırasında yapılan bir yeniden adlandırma ($ref → ref gibi). */
export interface RenamedKeyword {
  path: string;
  from: string;
  to: string;
}

export interface SchemaTranslation {
  /** Gemini'ye gönderilecek şema. */
  schema: GeminiSchema;
  dropped: DroppedKeyword[];
  renamed: RenamedKeyword[];
  /** Ulaşılan azami iç içe derinlik (Gemini sınırı 32). */
  maxDepth: number;
  /** `externalDefs`'ten şemaya kopyalanan tanım adları. */
  inlinedDefs: string[];
}

export interface TranslateOptions {
  /**
   * Şemanın DIŞINDA duran `$defs` havuzu (ör. contract/tools.json kökündeki `$defs`).
   * Gemini dış referans kabul etmediği için, gerçekten kullanılan tanımlar şemanın
   * KENDİ `defs` alanına kopyalanır (geçişli olarak).
   */
  externalDefs?: Record<string, unknown>;
  /** Gemini'nin belgelenmiş iç içe geçme sınırı. */
  maxDepth?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sabitler
// ─────────────────────────────────────────────────────────────────────────────

/** Gemini'nin kabul ettiği `type` değerleri. `null` BİR TİP DEĞİLDİR. */
const ALLOWED_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

/** Doğrudan taşınan anahtar kelimeler. Bu kümenin dışındaki HER ŞEY düşer. */
const PASSTHROUGH = new Set(["type", "properties", "required", "description", "enum", "items"]);

/** Gemini belgesindeki azami iç içe derinlik. */
const DEFAULT_MAX_DEPTH = 32;

/** Rapor okunabilir kalsın diye değerler kısaltılır. */
function brief(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined) return "undefined";
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ─────────────────────────────────────────────────────────────────────────────
// Çevirici
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MCP şemasını Gemini şemasına çevirir. SAF fonksiyondur: girdi mutasyona
 * uğramaz, hiçbir yere yazmaz, aynı girdiye her zaman aynı çıktıyı verir.
 *
 * (Türkçe konuşurken adı "MCP şemasını Gemini'ye çevir"; tanımlayıcı İngilizce.)
 */
export function mcpSchemaToGemini(input: unknown, options: TranslateOptions = {}): SchemaTranslation {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const dropped: DroppedKeyword[] = [];
  const renamed: RenamedKeyword[] = [];
  const inlinedDefs: string[] = [];
  let maxSeenDepth = 0;

  /** Şemanın kendi `defs` havuzu. Hem yereldeki `$defs` hem dışarıdan çekilenler buraya düşer. */
  const defs: Record<string, GeminiSchema> = {};
  /** Sonsuz döngüyü ve tekrar işlemeyi önler. */
  const defsInProgress = new Set<string>();

  const localDefs: Record<string, unknown> = {};
  if (isPlainObject(input)) {
    const raw = (input["$defs"] ?? input["defs"]) as unknown;
    if (isPlainObject(raw)) Object.assign(localDefs, raw);
  }
  const defsPool: Record<string, unknown> = { ...(options.externalDefs ?? {}), ...localDefs };

  const drop = (path: string, keyword: string, value: unknown, reason: string, preserved = false): void => {
    dropped.push({ path, keyword, value, reason, preserved });
  };

  /**
   * `$ref` çözümü.
   *
   * ★ NEDEN: Gemini yalnızca `#/defs/<Ad>` biçimini ve YALNIZCA defs'in doğrudan
   * çocuğunu kabul eder. Derin yollar (`#/$defs/A/properties/b`) ve dosya-dışı
   * referanslar geçersizdir. Ayrıca hedef tanım, şemanın KENDİ defs'ine
   * kopyalanmak zorundadır: sözleşmedeki `$defs` dosya kökünde durur, tool
   * şemasının içinde değil — dışarıda bıraksak "dış referans" olurdu.
   */
  function resolveRef(refValue: unknown, path: string, out: GeminiSchema, depth: number): boolean {
    if (typeof refValue !== "string") {
      drop(path, "$ref", refValue, "ref değeri string değil");
      return false;
    }
    const m = /^#\/(?:\$defs|defs|definitions)\/([^/]+)$/.exec(refValue);
    if (!m) {
      drop(path, "$ref", refValue, "Gemini yalnızca '#/defs/<Ad>' biçimini kabul eder; derin veya dış referans DESTEKLENMEZ");
      return false;
    }
    const name = m[1] as string;
    const target = defsPool[name];
    if (target === undefined) {
      drop(path, "$ref", refValue, `'${name}' tanımı defs havuzunda yok (externalDefs verilmemiş olabilir)`);
      return false;
    }
    // Tanımı bir kez çevir ve defs'e koy. defsInProgress öz-referansta sonsuz döngüyü keser.
    if (defs[name] === undefined && !defsInProgress.has(name)) {
      defsInProgress.add(name);
      defs[name] = walk(target, `#/defs/${name}`, 1);
      defsInProgress.delete(name);
      inlinedDefs.push(name);
    }
    out.ref = `#/defs/${name}`;
    renamed.push({ path, from: "$ref", to: "ref" });
    if (depth > maxSeenDepth) maxSeenDepth = depth;
    return true;
  }

  function walk(node: unknown, path: string, depth: number): GeminiSchema {
    if (depth > maxSeenDepth) maxSeenDepth = depth;

    // JSON Schema'da `true`/`false` de geçerli bir şemadır; Gemini'de karşılığı yok.
    if (typeof node === "boolean") {
      drop(path, "(boolean şema)", node, "JSON Schema boolean şeması Gemini'de karşılıksız; boş nesneye indirgendi");
      return { type: "object" };
    }
    if (!isPlainObject(node)) {
      drop(path, "(şema değil)", node, "şema bir nesne değil; boş nesneye indirgendi");
      return { type: "object" };
    }
    if (depth > maxDepth) {
      drop(path, "(derinlik)", `${depth}`, `Gemini azami ${maxDepth} seviye iç içe geçmeye izin verir; bu dal budandı`);
      return { type: "object" };
    }

    const out: GeminiSchema = {};
    /** description'ın sonuna eklenecek, kaybolmasın diye taşınan bilgiler. */
    const descriptionSuffix: string[] = [];

    // ── $ref: varsa diğer her şeyi gölgeler (JSON Schema 2020-12'de artık
    //    kardeş anahtarlar geçerlidir, ama Gemini'de ref tek başına durur).
    if (node["$ref"] !== undefined || node["ref"] !== undefined) {
      const key = node["$ref"] !== undefined ? "$ref" : "ref";
      if (resolveRef(node[key], path, out, depth)) {
        for (const k of Object.keys(node)) {
          if (k === key || k === "description") continue;
          drop(`${path}`, k, node[k], "ref ile aynı düğümde duran kardeş anahtarlar Gemini'de yok sayılır");
        }
        if (typeof node["description"] === "string") out.description = node["description"];
        return out;
      }
      // ref çözülemedi: düğümü normal şema gibi çevirmeye devam et.
    }

    for (const [key, value] of Object.entries(node)) {
      switch (key) {
        case "$ref":
        case "ref":
          break; // yukarıda ele alındı

        case "$defs":
        case "defs": {
          // Kök `$defs` havuza zaten alındı; ayrıca ÇIKTIYA da yazılması gerekmez —
          // yalnızca gerçekten referans verilenler `defs`'e kopyalanır (aşağıda).
          if (depth > 1) {
            drop(path, key, Object.keys(isPlainObject(value) ? value : {}), "iç içe defs Gemini'de desteklenmez; yalnızca kök defs kullanılır");
          }
          break;
        }

        case "type": {
          if (typeof value === "string") {
            if (ALLOWED_TYPES.has(value)) out.type = value as GeminiSchema["type"];
            else if (value === "null") drop(path, "type", value, "'null' Gemini'de bir tip DEĞİLDİR");
            else drop(path, "type", value, `bilinmeyen tip '${value}'`);
            break;
          }
          if (Array.isArray(value)) {
            // ★ ["string","null"] gibi birleşimler sözleşmede BOL. Gemini birleşim
            //   kabul etmez; null seçeneği düşer ve bilgisi açıklamaya taşınır.
            const usable = value.filter((t) => typeof t === "string" && ALLOWED_TYPES.has(t)) as string[];
            const nullable = value.includes("null");
            if (usable.length > 0) out.type = usable[0] as GeminiSchema["type"];
            if (nullable) {
              descriptionSuffix.push("null olabilir");
              drop(path, "type[null]", value, "Gemini tip birleşimi kabul etmez; 'null' düşürüldü", true);
            }
            if (usable.length > 1) {
              drop(path, "type[]", value, `tip birleşimi desteklenmez; ilki ('${usable[0]}') seçildi`);
            }
            if (usable.length === 0) {
              drop(path, "type", value, "kullanılabilir tip kalmadı");
            }
            break;
          }
          drop(path, "type", value, "type ne string ne dizi");
          break;
        }

        case "enum": {
          if (!Array.isArray(value)) {
            drop(path, "enum", value, "enum bir dizi değil");
            break;
          }
          const hasNull = value.includes(null);
          const values = value.filter((v) => v !== null);
          const strings = values.map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
          const nonString = values.some((v) => typeof v !== "string");
          if (hasNull) {
            descriptionSuffix.push("null olabilir");
            drop(path, "enum[null]", value, "Gemini enum'ında null bulunamaz; düşürüldü", true);
          }
          if (nonString) {
            drop(path, "enum(tip)", value, "Gemini enum yalnızca string kabul eder; değerler string'e çevrildi", true);
          }
          out.enum = strings;
          break;
        }

        case "properties": {
          if (!isPlainObject(value)) {
            drop(path, "properties", value, "properties bir nesne değil");
            break;
          }
          const props: Record<string, GeminiSchema> = {};
          for (const [pname, pschema] of Object.entries(value)) {
            props[pname] = walk(pschema, `${path}/properties/${pname}`, depth + 1);
          }
          out.properties = props;
          break;
        }

        case "items": {
          if (Array.isArray(value)) {
            // Tuple biçimi (prefixItems'ın eski hâli). Gemini tek bir items bekler.
            drop(path, "items[]", value, "tuple biçimi desteklenmez; yalnızca ilk eleman şeması alındı");
            out.items = walk(value[0], `${path}/items`, depth + 1);
            break;
          }
          out.items = walk(value, `${path}/items`, depth + 1);
          break;
        }

        case "required": {
          if (Array.isArray(value) && value.every((v) => typeof v === "string")) out.required = [...(value as string[])];
          else drop(path, "required", value, "required string dizisi değil");
          break;
        }

        case "description": {
          if (typeof value === "string") out.description = value;
          else drop(path, "description", value, "description string değil");
          break;
        }

        case "default": {
          // ★ KORUNUR: modelin argüman üretirken gerçekten kullandığı bilgi budur.
          descriptionSuffix.push(`varsayılan: ${brief(value)}`);
          drop(path, "default", value, "Gemini şemasında default yoktur; açıklamaya metin olarak taşındı", true);
          break;
        }

        default: {
          if (PASSTHROUGH.has(key)) break; // teorik olarak ulaşılmaz; savunma amaçlı
          drop(path, key, value, "Gemini functionDeclarations şemasında karşılığı yok");
          break;
        }
      }
    }

    // enum var ama type yoksa: Gemini enum'ı yalnızca STRING tipiyle kabul eder.
    // Sözleşmede `{"enum":["all","current_account"]}` gibi tipsiz enum'lar var.
    if (out.enum && !out.type) out.type = "string";

    if (descriptionSuffix.length > 0) {
      const extra = `(${descriptionSuffix.join("; ")})`;
      out.description = out.description ? `${out.description} ${extra}` : extra;
    }

    return out;
  }

  const schema = walk(input, "#", 1);
  if (inlinedDefs.length > 0) schema.defs = defs;

  return { schema, dropped, renamed, maxDepth: maxSeenDepth, inlinedDefs };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rapor — "ne attık?" sorusunun cevabı
// ─────────────────────────────────────────────────────────────────────────────

export interface TranslationReportEntry {
  name: string;
  translation: SchemaTranslation;
}

/** Anahtar kelime bazında kaç kez düşürüldüğünü sayar. */
export function countDroppedKeywords(entries: TranslationReportEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of entries) {
    for (const d of e.translation.dropped) counts.set(d.keyword, (counts.get(d.keyword) ?? 0) + 1);
  }
  return counts;
}

/**
 * stderr'e basılacak Türkçe özet. stdout'a ASLA yazılmaz: stdio modunda stdout
 * yalnızca JSON-RPC taşır.
 */
export function formatTranslationReport(entries: TranslationReportEntry[]): string {
  const lines: string[] = [];
  lines.push("┌─ ŞEMA ÇEVİRİSİ — MCP (JSON Schema 2020-12) → Gemini (OpenAPI alt kümesi)");

  const counts = [...countDroppedKeywords(entries)].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = counts.reduce((s, [, n]) => s + n, 0);

  for (const entry of entries) {
    const { dropped, renamed, maxDepth, inlinedDefs } = entry.translation;
    const uniq = [...new Set(dropped.map((d) => d.keyword))].sort();
    const extras: string[] = [];
    if (renamed.length) extras.push(`${renamed.length} ref yeniden adlandırıldı`);
    if (inlinedDefs.length) extras.push(`defs içe alındı: ${inlinedDefs.join(", ")}`);
    lines.push(
      `│ ${entry.name.padEnd(34)} derinlik ${String(maxDepth).padStart(2)} · ${String(dropped.length).padStart(2)} anahtar düştü` +
        (uniq.length ? ` → ${uniq.join(", ")}` : "") +
        (extras.length ? ` · ${extras.join(" · ")}` : ""),
    );
  }

  lines.push(`├─ TOPLAM ${total} düşürme, ${entries.length} tool`);
  for (const [kw, n] of counts) lines.push(`│    ${String(n).padStart(3)} × ${kw}`);
  lines.push("└─ Sözleşme aynı; lehçe farklı. Düşen kısıtlar sunucu tarafında zod ile YENİDEN doğrulanır.");
  return lines.join("\n");
}
