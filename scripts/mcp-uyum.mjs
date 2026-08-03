#!/usr/bin/env node
// -----------------------------------------------------------------------------
// mcp-uyum.mjs — MCP spec uyum doğrulayıcısı (ham JSON-RPC ile)
//
// NEDEN BU DOSYA VAR
// ------------------
// scripts/verify-contract.mjs "üç dil AYNI tool sözleşmesini sunuyor mu?" sorusunu
// yanıtlar. Bu dosya bambaşka bir soruyu yanıtlar: "sunucularımız MCP SPEC'İNE
// uyuyor mu?". Sözleşmeye uyan ama spec'i ihlal eden bir sunucu tamamen
// mümkündür — ve ihlal genelde SESSİZDİR: yanlış hata kodu, eksik `resultType`,
// imzasız `requestState`, stdout'a düşen bir log satırı. Hiçbiri "hata" gibi
// görünmez; sadece bazı client'larda çalışmaz.
//
// ★ SDK KULLANILMAZ. Kasıtlıdır. SDK'lar tam da burada test etmek istediğimiz
//   şeyleri düzeltir: `_meta`'yı otomatik ekler, hata kodlarını normalize eder,
//   bozuk çerçeveyi yutar. SDK ile ölçmek, gözlüğün üstünden gözü muayene
//   etmektir. Bu yüzden protokolü ham konuşuyoruz: satır-sonlu JSON-RPC 2.0.
//
// ★ NEGATİF TESTLER BİRİNCİ SINIF VATANDAŞTIR. Bir sunucunun doğru cevabı
//   vermesi kadar YANLIŞ İSTEĞİ REDDETMESİ de spec gereğidir. Bilinmeyen metod,
//   bozuk JSON, `_meta`'sız `server/discover`, kurcalanmış `requestState` —
//   bunların hepsi burada gönderilir ve reddedilmedikleri anda madde KALDI olur.
//
// BAĞIMLILIK YOKTUR (yalnızca node:*). Node 24 ile çalışır.
//
// KULLANIM
//   node scripts/mcp-uyum.mjs --hepsi --protokol ikisi
//   node scripts/mcp-uyum.mjs --sunucu py --protokol 2026-07-28
//   node scripts/mcp-uyum.mjs --maddeler          (checklist'i basar, sunucu başlatmaz)
//
// ÇIKIŞ KODU
//   0  hiçbir MUST maddesi KALMADI  (SHOULD kalmış olabilir — raporda görünür)
//   1  en az bir MUST maddesi KALDI
//   2  hatalı parametre
// -----------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ═════════════════════════════════════════════════════════════════════════════
// 1) MADDE KATALOĞU — insan checklist'i ile makinenin TEK ortak kaynağı
//
// docs/12-mcp-uyum.md bu tablodan türetilir. İki yerde ayrı ayrı yazılsaydı
// kaçınılmaz olarak birbirinden kayarlardı; kayan bir checklist ise en kötü
// checklist'tir çünkü doğru olduğu sanılır.
//
//   otomatik: false  →  madde çalıştırılmaz, DAİMA "ATLANDI" olur ve `neden`
//                       alanı raporda birebir basılır. "Yazmayı unuttuk" ile
//                       "otomatikleştirilemez" arasındaki farkı görünür kılar.
// ═════════════════════════════════════════════════════════════════════════════

const HER_IKISI = "her ikisi";
const V2R = "2026-07-28";
const V1R = "2025-11-25";

/** @type {{id:string,alan:string,madde:string,revizyon:string,seviye:"MUST"|"SHOULD",nasil:string,otomatik:boolean,neden?:string}[]} */
const CATALOG = [
  // ── JSON-RPC 2.0 temeli ────────────────────────────────────────────────────
  { id: "J1", alan: "JSON-RPC 2.0", madde: 'Her yanıt jsonrpc:"2.0" alanını taşır', revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Oturum boyunca gelen TÜM yanıtlarda alan aranır.", otomatik: true },
  { id: "J2", alan: "JSON-RPC 2.0", madde: "Yanıt id'si istek id'siyle aynı ve AYNI TİPTE", revizyon: HER_IKISI, seviye: "MUST",
    nasil: 'id olarak string ("uyum-string-id") gönderilir; yanıtta sayıya dönüşmemeli.', otomatik: true },
  { id: "J3", alan: "JSON-RPC 2.0", madde: "Bilinmeyen metod → -32601 Method not found", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "uyum/bilinmeyen-metot gönderilir.", otomatik: true },
  { id: "J4", alan: "JSON-RPC 2.0", madde: "Geçersiz params → -32602 Invalid params", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "tools/call, zorunlu `name` alanı OLMADAN gönderilir.", otomatik: true },
  { id: "J5", alan: "JSON-RPC 2.0", madde: "Bozuk JSON → -32700 Parse error", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Yarım kalmış bir JSON satırı yazılır; id:null + -32700 beklenir.", otomatik: true },
  { id: "J6", alan: "JSON-RPC 2.0", madde: "Notification (id'siz istek) yanıt ALMAZ", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "id'siz bilinmeyen bir metod gönderilip 800 ms sessizlik ölçülür.", otomatik: true },
  { id: "J7", alan: "JSON-RPC 2.0", madde: "stdio'da stdout SADECE JSON-RPC (satır başına tek JSON)", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "stdout'un her satırı JSON.parse edilir; edilemeyen satır ihlaldir.", otomatik: true },
  { id: "J8", alan: "JSON-RPC 2.0", madde: "Loglar stderr'e yazılır", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "stderr'de log satırı var mı bakılır (J7 ile birlikte anlamlıdır).", otomatik: true },
  { id: "J9", alan: "JSON-RPC 2.0", madde: "Bilinmeyen tool adı düzgün reddedilir", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "tools/call name='yok_boyle_bir_tool'; JSON-RPC hatası VEYA isError=true kabul edilir.", otomatik: true },

  // ── 2026-07-28 ─────────────────────────────────────────────────────────────
  { id: "Y1", alan: "2026-07-28", madde: "server/discover ZORUNLU RPC olarak var", revizyon: V2R, seviye: "MUST",
    nasil: "Üç zorunlu _meta anahtarıyla çağrılır; hatasız dönmeli.", otomatik: true },
  { id: "Y2", alan: "2026-07-28", madde: "_meta'sız server/discover REDDEDİLİR", revizyon: V2R, seviye: "MUST",
    nasil: "Aynı istek _meta olmadan gönderilir; hata dönmesi ZORUNLUDUR.", otomatik: true },
  // ★ Bu maddenin tamamı contract/protocol.md'de anlatılan tuzağın testidir.
  //   Spec, server/discover'ın stdio'da "geriye dönük uyumluluk sondası" olarak
  //   kullanılmasını ÖNERİR: -32601 = "bu sunucu 2026 öncesi". Dolayısıyla v2 konuşan
  //   bir sunucunun eksik _meta'ya -32601 demesi, kendisini v1 sanmasına yol açar.
  //   Doğru cevap -32602'dir: "istek hatalı", "metot yok" değil.
  { id: "Y2b", alan: "2026-07-28", madde: "_meta hatasının kodu -32601 DEĞİL (uyumluluk sondasını yanıltır)", revizyon: V2R, seviye: "SHOULD",
    nasil: "Y2'nin hata kodu okunur; -32601 ise sonda bu v2 sunucuyu v1 sanır.", otomatik: true },
  { id: "Y3a", alan: "2026-07-28", madde: "_meta.protocolVersion eksikse REDDEDİLİR", revizyon: V2R, seviye: "MUST",
    nasil: "_meta'dan yalnızca protocolVersion çıkarılıp server/discover gönderilir.", otomatik: true },
  // ★ clientInfo spec'te SHOULD'dur: "Clients SHOULD identify themselves on each request".
  //   Bu yüzden ONU ZORUNLU TUTAN sunucu spec'ten KATI davranır ve clientInfo göndermeyen
  //   uyumlu bir client'ı kırar. Madde bu yüzden "reddedilmeli" değil, "yine de İŞLENMELİ".
  { id: "Y3b", alan: "2026-07-28", madde: "_meta.clientInfo YOKSA istek yine de işlenir (spec'te SHOULD)", revizyon: V2R, seviye: "SHOULD",
    nasil: "clientInfo çıkarılıp server/discover gönderilir; başarılı dönmesi beklenir.", otomatik: true },
  { id: "Y18", alan: "2026-07-28", madde: "Sunucu her sonucun _meta'sında serverInfo bildirir", revizyon: V2R, seviye: "SHOULD",
    nasil: 'Spec: "servers SHOULD identify themselves in each result\'s _meta (io.modelcontextprotocol/serverInfo)".', otomatik: true },
  { id: "Y4", alan: "2026-07-28", madde: 'TÜM sonuçlarda resultType ("complete" | "input_required")', revizyon: V2R, seviye: "MUST",
    nasil: "server/discover, tools/list ve tools/call sonuçlarında alan aranır.", otomatik: true },
  { id: "Y5", alan: "2026-07-28", madde: "tools/list sonucunda ttlMs (CacheableResult)", revizyon: V2R, seviye: "MUST",
    nasil: "Beklenen değer 300000 (contract/protocol.md'de sabitlendi).", otomatik: true },
  { id: "Y6", alan: "2026-07-28", madde: 'tools/list sonucunda cacheScope = "public"', revizyon: V2R, seviye: "MUST",
    nasil: "Tool listemiz statiktir, kullanıcıya özel değildir.", otomatik: true },
  // Spec'te SHOULD ("Servers SHOULD return tools ... in a deterministic order"). Bu repoda
  // ev kuralı olarak MUST gibi davranılır (sözleşme sırası), ama seviye SPEC'in dediğidir —
  // checklist'in görevi spec'i raporlamak, ev kuralımızı spec diye sunmak değil.
  { id: "Y7", alan: "2026-07-28", madde: "tools/list DETERMİNİSTİK sırada (sözleşme sırası)", revizyon: V2R, seviye: "SHOULD",
    nasil: "contract/tools.json sırasıyla birebir karşılaştırılır.", otomatik: true },
  { id: "Y8", alan: "2026-07-28", madde: "Handshake YOK — initialize olmadan çalışır", revizyon: V2R, seviye: "MUST",
    nasil: "Oturum boyunca initialize HİÇ gönderilmez; discover+list+call çalışmalı.", otomatik: true },
  { id: "Y9", alan: "2026-07-28", madde: "Mcp-Session-Id header'ı YOK", revizyon: V2R, seviye: "MUST",
    nasil: "Streamable HTTP yanıt header'larına bakmayı gerektirir.", otomatik: false,
    neden: "stdio transport'unda HTTP header'ı YOKTUR. Ölçmek için üç dilin HTTP giriş noktasını (port, hazır-olma beklemesi, kapatma) ayağa kaldırmak gerekir; bu doğrulayıcı bilinçli olarak tek transport'a (stdio) sadık kalır. Elle: `npm run http` + `curl -i -X POST localhost:PORT/mcp/v2`." },
  { id: "Y10", alan: "2026-07-28", madde: "ping RPC'si kaldırıldı → -32601", revizyon: V2R, seviye: "MUST",
    nasil: "ping gönderilir; metod bulunmamalı.", otomatik: true },
  { id: "Y11", alan: "2026-07-28", madde: "logging/setLevel kaldırıldı → -32601", revizyon: V2R, seviye: "MUST",
    nasil: "logging/setLevel gönderilir.", otomatik: true },
  { id: "Y12", alan: "2026-07-28", madde: "roots/list_changed kaldırıldı → -32601", revizyon: V2R, seviye: "MUST",
    nasil: "notifications/roots/list_changed'in istek biçimi gönderilir.", otomatik: true },
  { id: "Y13", alan: "2026-07-28", madde: "Hata kodları tanımlı aralıklarda (-32000..-32019 impl, -32020..-32099 spec)", revizyon: V2R, seviye: "MUST",
    nasil: "Oturumda görülen TÜM hata kodları toplanıp sınıflandırılır.", otomatik: true },
  { id: "Y14a", alan: "2026-07-28", madde: "Desteklenmeyen protokol sürümü REDDEDİLİR", revizyon: V2R, seviye: "MUST",
    nasil: '_meta.protocolVersion="1999-01-01" gönderilir.', otomatik: true },
  { id: "Y14b", alan: "2026-07-28", madde: "Red kodu -32022 (UnsupportedProtocolVersion)", revizyon: V2R, seviye: "SHOULD",
    nasil: "Y14a'nın hata kodu okunur. Eski numara -32004 ise geçiş tamamlanmamıştır.", otomatik: true },
  { id: "Y15a", alan: "2026-07-28", madde: "Eksik clientCapabilities REDDEDİLİR", revizyon: V2R, seviye: "MUST",
    nasil: "_meta'dan yalnızca clientCapabilities çıkarılıp server/discover gönderilir.", otomatik: true },
  // ★ Burada iki kod da savunulabilir, bu yüzden madde "kod -32021 olmalı" DEĞİLDİR:
  //   -32021 MissingRequiredClientCapability, adı gereği "sunucunun ihtiyaç duyduğu bir
  //   yeteneği client bildirmemiş" hâlidir. clientCapabilities anahtarı TAMAMEN yoksa
  //   istek biçimsel olarak bozuktur ve -32602 Invalid params da doğrudur. Ölçülebilir
  //   ve tartışmasız olan tek şey ESKİ TASLAK NUMARASININ kalmamış olmasıdır (-32003).
  { id: "Y15b", alan: "2026-07-28", madde: "Red kodu eski taslak numarası (-32003) DEĞİL", revizyon: V2R, seviye: "SHOULD",
    nasil: "Y15a'nın kodu okunur; -32021 (spec) veya -32602 (invalid params) kabul, -32003 geçiş yapılmadı demektir.", otomatik: true },
  { id: "Y16", alan: "2026-07-28", madde: "HeaderMismatch → -32020", revizyon: V2R, seviye: "MUST",
    nasil: "Mcp-Method header'ı gövdedeki metottan farklı gönderilmelidir.", otomatik: false,
    neden: "Yalnızca Streamable HTTP'de anlamlıdır — stdio'da header kavramı yoktur (bkz. Y9)." },
  { id: "Y17", alan: "2026-07-28", madde: "Streamable HTTP POST'ta Mcp-Method ve Mcp-Name header'ları", revizyon: V2R, seviye: "MUST",
    nasil: "HTTP POST isteğinin header'ları incelenir.", otomatik: false,
    neden: "Yine HTTP'ye özgü (bkz. Y9). Ayrıca bu bir İSTEMCİ yükümlülüğüdür; sunucuyu sondalayarak değil, istemcinin gönderdiği isteğe bakarak doğrulanır." },

  // ── MRTR ───────────────────────────────────────────────────────────────────
  { id: "M1", alan: "MRTR (2026-07-28)", madde: 'Onay gerektiren çağrı resultType:"input_required" döner', revizyon: V2R, seviye: "MUST",
    nasil: "xurrent_create_time_entry dryRun'sız çağrılır (XURRENT_CONFIRM_POLICY=closed).", otomatik: true },
  { id: "M2", alan: "MRTR (2026-07-28)", madde: "InputRequiredResult { inputRequests, requestState } taşır", revizyon: V2R, seviye: "MUST",
    nasil: "İki alanın da dolu olduğu doğrulanır.", otomatik: true },
  { id: "M3", alan: "MRTR (2026-07-28)", madde: "inputRequests değerleri yalnızca ElicitRequest | CreateMessageRequest | ListRootsRequest", revizyon: V2R, seviye: "MUST",
    nasil: "Her girdinin method alanı beyaz listeyle karşılaştırılır.", otomatik: true },
  { id: "M4", alan: "MRTR (2026-07-28)", madde: "Client desteklemediği inputRequest GÖNDERİLMEZ", revizyon: V2R, seviye: "MUST",
    nasil: "clientCapabilities'ten elicitation ÇIKARILIP aynı çağrı yapılır; elicit isteği gelmemeli.", otomatik: true },
  { id: "M5", alan: "MRTR (2026-07-28)", madde: "Kurcalanmış requestState REDDEDİLİR (imza/bütünlük)", revizyon: V2R, seviye: "MUST",
    nasil: "Blob'un son karakteri değiştirilip geri gönderilir; yazma OLMAMALI.", otomatik: true },
  { id: "M6", alan: "MRTR (2026-07-28)", madde: "Başka argümana iliştirilen requestState REDDEDİLİR (fingerprint)", revizyon: V2R, seviye: "MUST",
    nasil: "Geçerli blob, minutes değeri değiştirilmiş bir çağrıya iliştirilir.", otomatik: true },
  { id: "M7", alan: "MRTR (2026-07-28)", madde: "Geçerli requestState + accept → çağrı tamamlanır", revizyon: V2R, seviye: "MUST",
    nasil: 'inputResponses={"<key>":{action:"accept",content:{...}}} + requestState ile tekrar.', otomatik: true },
  { id: "M8", alan: "MRTR (2026-07-28)", madde: "requestState TEK KULLANIMLIK (nonce)", revizyon: V2R, seviye: "SHOULD",
    nasil: "Aynı blob ikinci kez gönderilir; reddedilmeli.", otomatik: true },
  { id: "M9", alan: "MRTR (2026-07-28)", madde: "Retry'de JSON-RPC id FARKLI", revizyon: V2R, seviye: "MUST",
    nasil: "İki turun id'leri karşılaştırılır (istemci yükümlülüğü — sonda kendi davranışını kanıtlar).", otomatik: true },
  { id: "M10", alan: "MRTR (2026-07-28)", madde: "requestState TTL'lidir (5 dk)", revizyon: V2R, seviye: "SHOULD",
    nasil: "TTL dolana kadar beklenip blob tekrar gönderilmelidir.", otomatik: false,
    neden: "XURRENT_STATE_TTL varsayılanı 300 sn. Doğrulamak için 5 dakika beklemek gerekir; CI'da kabul edilemez. XURRENT_STATE_TTL=1 ile elle: `XURRENT_STATE_TTL=1 node scripts/mcp-uyum.mjs --sunucu ts` sonrası ikinci turu geciktirin." },
  { id: "M11", alan: "MRTR (2026-07-28)", madde: "requestState principal'a bağlıdır (çapraz kullanıcı reddi)", revizyon: V2R, seviye: "SHOULD",
    nasil: "A kullanıcısının blob'u B kullanıcısının oturumuna taşınmalıdır.", otomatik: false,
    neden: "İki FARKLI authenticated principal gerektirir. Mock modda tek kimlik vardır ($me → TW9jay9QZXJzb24vMQ); ikinci bir kimlik ancak live modda veya fixtures'ı değiştirerek üretilir — ikisi de bu doğrulayıcının kapsamı dışında. Kod tarafı: core/confirm.* içinde principal alanı imzalanır." },

  // ── 2025-11-25 ─────────────────────────────────────────────────────────────
  { id: "G1", alan: "2025-11-25", madde: "initialize kabul edilir ve protocolVersion döner", revizyon: V1R, seviye: "MUST",
    nasil: "initialize + protocolVersion=2025-11-25 gönderilir.", otomatik: true },
  { id: "G2", alan: "2025-11-25", madde: "Capabilities pazarlığı: serverInfo + capabilities döner", revizyon: V1R, seviye: "MUST",
    nasil: "initialize sonucunda iki alan da aranır.", otomatik: true },
  { id: "G3", alan: "2025-11-25", madde: "notifications/initialized sonrası oturum kullanılabilir", revizyon: V1R, seviye: "MUST",
    nasil: "Bildirim yollanır, ardından tools/list çağrılır.", otomatik: true },
  { id: "G4", alan: "2025-11-25", madde: "Sunucu-başlatmalı elicitation/create geliyor", revizyon: V1R, seviye: "MUST",
    nasil: "elicitation yeteneği bildirilip yazma tool'u çağrılır; sunucu İSTEK göndermeli.", otomatik: true },
  { id: "G5", alan: "2025-11-25", madde: 'ElicitResult action="accept" işlenir → yazma tamamlanır', revizyon: V1R, seviye: "MUST",
    nasil: "accept + content döndürülür.", otomatik: true },
  { id: "G6", alan: "2025-11-25", madde: 'ElicitResult action="decline" işlenir → yazma YOK', revizyon: V1R, seviye: "MUST",
    nasil: "decline döndürülür; sonuç isError=true olmalı ve mutation çalışmamalı.", otomatik: true },
  { id: "G7", alan: "2025-11-25", madde: 'ElicitResult action="cancel" işlenir → yazma YOK', revizyon: V1R, seviye: "MUST",
    nasil: "cancel döndürülür.", otomatik: true },
  { id: "G8", alan: "2025-11-25", madde: "v1 sonucunda resultType YOKTUR (client complete saymalı)", revizyon: V1R, seviye: "SHOULD",
    nasil: "tools/call sonucunda alanın bulunmaması beklenir; varsa bilgi notu düşülür.", otomatik: true },

  // ── Tool katmanı ───────────────────────────────────────────────────────────
  { id: "T1", alan: "Tool katmanı", madde: "Tool adları contract/tools.json ile birebir", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "tools/list adları sözleşmeyle karşılaştırılır.", otomatik: true },
  { id: "T2", alan: "Tool katmanı", madde: 'Her tool inputSchema bildirir (type="object")', revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Her tool'un inputSchema.type alanı okunur.", otomatik: true },
  { id: "T3", alan: "Tool katmanı", madde: "Her tool outputSchema bildirir", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "8/8 beklenir; eksikse structuredContent üretilemez.", otomatik: true },
  { id: "T4", alan: "Tool katmanı", madde: "outputSchema varsa structuredContent ZORUNLU", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "xurrent_whoami çağrılır; structuredContent dolu olmalı.", otomatik: true },
  { id: "T5", alan: "Tool katmanı", madde: "structuredContent'in YANI SIRA okunabilir text block", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "content[] içinde en az bir type='text' aranır.", otomatik: true },
  { id: "T6", alan: "Tool katmanı", madde: "structuredContent sözleşmedeki required alanları taşır", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "whoami çıktısında person/account/mode aranır.", otomatik: true },
  { id: "T7", alan: "Tool katmanı", madde: "isError semantiği: iş kuralı hatası JSON-RPC hatası DEĞİLDİR", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "minutes=7 (timeIncrement=30'un katı DEĞİL) ile yazma denenir; isError=true + okunabilir metin beklenir.", otomatik: true },
  { id: "T8", alan: "Tool katmanı", madde: "annotations (readOnly/destructive/idempotent/openWorld) sözleşmeyle aynı", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Sözleşmedeki her annotation değeri tek tek karşılaştırılır.", otomatik: true },
  { id: "T9", alan: "Tool katmanı", madde: "$ref/$defs çözülüyor (dangling referans yok)", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Şemalardaki tüm $ref'ler kendi belgeleri içinde çözülmeye çalışılır.", otomatik: true },
  { id: "T10", alan: "Tool katmanı", madde: "Her tool anlamlı bir description taşır", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "Boş veya 10 karakterden kısa description LLM'i yanıltır.", otomatik: true },

  // ── Güvenlik / deprecation ────────────────────────────────────────────────
  { id: "D1", alan: "Güvenlik/deprecation", madde: "Roots KULLANILMIYOR (deprecated)", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Sunucu roots/list isteği göndermemeli + kaynakta roots kullanımı olmamalı.", otomatik: true },
  { id: "D2", alan: "Güvenlik/deprecation", madde: "Sampling KULLANILMIYOR (deprecated)", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "sampling/createMessage isteği gelmemeli + kaynakta kullanım olmamalı.", otomatik: true },
  { id: "D3", alan: "Güvenlik/deprecation", madde: "Logging KULLANILMIYOR (deprecated) — loglar stderr'e", revizyon: HER_IKISI, seviye: "MUST",
    nasil: "Spec: istekte logLevel YOKSA sunucu notifications/message emit ETMEMELİ. Sonda logLevel hiç göndermez → hiç bildirim gelmemeli. Ayrıca kaynak taranır.", otomatik: true },
  { id: "D4", alan: "Güvenlik/deprecation", madde: "HTTP+SSE transport KULLANILMIYOR (Streamable HTTP kullanılır)", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "Kaynak taraması: SSEServerTransport / sse_app / 2024-11-05 izleri aranır.", otomatik: true },
  { id: "D5", alan: "Güvenlik/deprecation", madde: "OAuth DCR KULLANILMIYOR (yerine CIMD)", revizyon: HER_IKISI, seviye: "SHOULD",
    nasil: "Kaynak taraması: registration_endpoint / RFC 7591 kayıt uçları aranır.", otomatik: true },
];

const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

// ═════════════════════════════════════════════════════════════════════════════
// 2) CLI
// ═════════════════════════════════════════════════════════════════════════════

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
function opt(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) return argv[i + 1];
  const inline = argv.find((a) => a.startsWith(name + "="));
  return inline ? inline.slice(name.length + 1) : fallback;
}

if (has("--yardim") || has("--help") || has("-h")) {
  process.stdout.write(
    [
      "",
      "mcp-uyum.mjs — MCP spec uyum doğrulayıcısı (ham JSON-RPC, SDK'sız)",
      "",
      "KULLANIM",
      "  node scripts/mcp-uyum.mjs --hepsi --protokol ikisi",
      "  node scripts/mcp-uyum.mjs --sunucu py --protokol 2026-07-28",
      "  node scripts/mcp-uyum.mjs --maddeler",
      "",
      "SEÇENEKLER",
      "  --sunucu <ts|py|cs>   Tek bir sunucuyu doğrular",
      "  --hepsi               Üç sunucuyu da doğrular",
      "  --protokol <rev>      2026-07-28 | 2025-11-25 | ikisi   (varsayılan: ikisi)",
      "  --maddeler            Madde kataloğunu basar ve çıkar (sunucu başlatmaz)",
      "  --markdown            Checklist'i markdown tablosu olarak basar (docs/12 buradan üretilir)",
      "  --json                Makine-okunur rapor stdout'a; anlatım stderr'e",
      "  --zaman-asimi <ms>    İstek zaman aşımı (varsayılan 20000; cs için 45000)",
      "  --genislik <n>        Tablo genişliği (varsayılan 118)",
      "  --no-color            ANSI renklerini kapatır",
      "  --yardim              Bu yardım",
      "",
      "ÇIKIŞ KODLARI",
      "  0  hiçbir MUST maddesi KALMADI",
      "  1  en az bir MUST maddesi KALDI",
      "  2  hatalı parametre",
      "",
      "GÜVENLİK NOTU",
      "  Bu doğrulayıcı GERÇEK bir yazma çağrısı yapar (MRTR onay turunu ölçmenin",
      "  başka yolu yoktur). Bu yüzden XURRENT_MODE=mock ve XURRENT_MOCK_PERSIST=0",
      "  ZORLA ayarlanır; ortamdaki live ayarları YOK SAYILIR.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const JSON_MODE = has("--json");
const OUT = JSON_MODE ? process.stderr : process.stdout;
const USE_COLOR = !has("--no-color") && !process.env.NO_COLOR && OUT.isTTY;
const c = (code, s) => (USE_COLOR ? `[${code}m${s}[0m` : String(s));
const bold = (s) => c("1", s);
const dim = (s) => c("2", s);
const red = (s) => c("31", s);
const green = (s) => c("32", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);
const write = (s = "") => OUT.write(s + "\n");
const WIDTH = Number(opt("--genislik", 118));

if (has("--maddeler")) {
  write("");
  write(bold(`  MCP uyum madde kataloğu — ${CATALOG.length} madde`));
  write("");
  let alan = null;
  for (const m of CATALOG) {
    if (m.alan !== alan) {
      alan = m.alan;
      write("");
      write(bold(cyan("  " + alan)));
    }
    write(
      `  ${m.id.padEnd(5)} ${(m.seviye === "MUST" ? red("MUST ") : yellow("SHOULD"))} ` +
        `${m.revizyon.padEnd(11)} ${m.otomatik ? green("otomatik") : yellow("ELLE    ")}  ${m.madde}`,
    );
    write(dim(`        nasıl: ${m.nasil}`));
    if (!m.otomatik) write(dim(`        neden otomatik değil: ${m.neden}`));
  }
  write("");
  process.exit(0);
}

// docs/12-mcp-uyum.md'deki checklist tablosu BUNUNLA üretilir. Elle kopyalansaydı
// katalog değiştikçe belge sessizce eskirdi — ve yanlış olduğu bilinmeyen bir
// checklist, hiç checklist olmamasından kötüdür.
if (has("--markdown")) {
  const esc = (s) => String(s).replaceAll("|", "\\|");
  write("| # | Madde | Revizyon | Seviye | Nasıl test edilir | Otomatik |");
  write("|---|---|---|---|---|---|");
  let alan = null;
  for (const m of CATALOG) {
    if (m.alan !== alan) {
      alan = m.alan;
      write(`| | **${esc(alan)}** | | | | |`);
    }
    write(
      `| ${m.id} | ${esc(m.madde)} | ${m.revizyon} | ${m.seviye} | ${esc(m.nasil)} | ` +
        `${m.otomatik ? "evet" : "**hayır** — " + esc(m.neden)} |`,
    );
  }
  process.exit(0);
}

const SERVERS = {
  ts: {
    label: "TypeScript",
    command: "node",
    args: [path.join(ROOT, "servers", "typescript", "dist", "mcp", "stdio.js")],
    hint: "cd servers/typescript && npm install && npm run build",
    timeout: 25000,
    sourceDir: path.join(ROOT, "servers", "typescript", "src"),
  },
  py: {
    label: "Python",
    command: "uv",
    args: ["--directory", path.join(ROOT, "servers", "python"), "run", "xurrent-mcp"],
    hint: "cd servers/python && uv sync",
    timeout: 35000,
    sourceDir: path.join(ROOT, "servers", "python", "src"),
  },
  cs: {
    label: "C#",
    command: "dotnet",
    args: ["run", "--project", path.join(ROOT, "servers", "csharp", "XurrentMcp.csproj"), "--no-build", "--", "stdio"],
    hint: "cd servers/csharp && dotnet build",
    timeout: 60000,
    sourceDir: path.join(ROOT, "servers", "csharp"),
  },
};

let targets;
if (has("--hepsi")) targets = ["ts", "py", "cs"];
else {
  const s = String(opt("--sunucu", "")).toLowerCase();
  if (!SERVERS[s]) {
    process.stderr.write("HATA: --hepsi veya --sunucu ts|py|cs verilmelidir. (--yardim)\n");
    process.exit(2);
  }
  targets = [s];
}

const protoArg = String(opt("--protokol", "ikisi")).toLowerCase();
let protocols;
if (protoArg === "ikisi") protocols = [V2R, V1R];
else if (protoArg === V2R) protocols = [V2R];
else if (protoArg === V1R) protocols = [V1R];
else {
  process.stderr.write(`HATA: --protokol ${V2R} | ${V1R} | ikisi olmalıdır.\n`);
  process.exit(2);
}

// ═════════════════════════════════════════════════════════════════════════════
// 3) Sözleşme
// ═════════════════════════════════════════════════════════════════════════════

const contractFile = path.join(ROOT, "contract", "tools.json");
if (!existsSync(contractFile)) {
  process.stderr.write(`HATA: sözleşme bulunamadı: ${contractFile}\n`);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractFile, "utf8"));
const expectedTools = contract.tools ?? [];
const expectedNames = expectedTools.map((t) => t.name);
const expectedByName = new Map(expectedTools.map((t) => [t.name, t]));

// Sonda hedefleri — fixtures/ ile uyumlu, mock modda GEÇERLİ argümanlar.
// timeIncrement mock'ta 30'dur; 30 dakika bu yüzden seçildi.
const PROBE = {
  readTool: "xurrent_whoami",
  writeTool: "xurrent_create_time_entry",
  writeArgs: {
    targetType: "time_allocation",
    targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
    minutes: 30,
    description: "MCP uyum sondasi",
  },
  // Aynı tool, FARKLI argüman — requestState parmak izi testinde kullanılır.
  writeArgsAlt: {
    targetType: "time_allocation",
    targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
    minutes: 60,
    description: "MCP uyum sondasi",
  },
  // İş kuralı hatası üreten argüman (isError semantiği testi).
  //
  // ★ Neden 7 dakika: mock'ta timeIncrement=30'dur (fixtures/timesheet-settings.json)
  //   ve 7 onun KATI DEĞİLDİR. preflight bunu şemadan SONRA, ağa çıkmadan yakalar →
  //   errors[] deterministik olarak dolar. Şema açısından geçerlidir (minutes yalnızca
  //   `integer`), yani -32602 ile karışmaz: tam olarak "geçerli istek, geçersiz İŞ" hâli.
  //
  //   Bu sondanın ilk sürümü var olmayan bir targetId + dryRun kullanıyordu ve madde
  //   üç dilde birden KALDI çıkıyordu. Sebep sunucular değildi: dryRun hiçbir mutation
  //   göndermediği için "bu allocation yok" hatası HİÇ oluşmuyordu. Yanlış negatif
  //   değil, YANLIŞ POZİTİF üreten bir testti — ve bir uyum aracında en tehlikeli hata
  //   budur, çünkü olmayan bir ihlali rapor eder.
  badWriteArgs: {
    targetType: "time_allocation",
    targetId: "TW9jay9UaW1lQWxsb2NhdGlvbi8x",
    minutes: 7,
    dryRun: true,
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// 4) Ham JSON-RPC stdio oturumu
//
// Protokolün tamamı budur: satır-sonlu JSON-RPC 2.0. Bir MCP client'ı yazmak
// için gereken kod miktarı, bu sınıfın boyu kadardır.
// ═════════════════════════════════════════════════════════════════════════════

const CLIENT_INFO = { name: "mcp-uyum", version: "1.0.0" };
const CAPS_WITH_ELICIT = { elicitation: {} };
const CAPS_WITHOUT_ELICIT = {};

const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPS = "io.modelcontextprotocol/clientCapabilities";
const META_INFO = "io.modelcontextprotocol/clientInfo";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Session {
  /**
   * @param {object} srv sunucu tanımı
   * @param {object} opts { protocol, caps, timeout, onServerRequest }
   */
  constructor(srv, opts = {}) {
    this.srv = srv;
    this.protocol = opts.protocol ?? V2R;
    this.caps = opts.caps ?? CAPS_WITH_ELICIT;
    this.timeout = opts.timeout ?? srv.timeout;
    this.onServerRequest = opts.onServerRequest ?? null;

    this.child = null;
    this.stdoutBuf = "";
    this.stderrBuf = "";
    this.lines = []; // stdout'a düşen HAM satırlar
    this.junk = []; // JSON.parse edilemeyen satırlar → J7 ihlali
    this.messages = []; // ayrıştırılan tüm mesajlar
    this.serverRequests = []; // sunucudan gelen İSTEKLER (v1 elicitation, roots, sampling)
    this.serverNotifications = []; // sunucudan gelen BİLDİRİMLER
    this.errorCodes = []; // görülen tüm JSON-RPC hata kodları (Y13)
    this.pending = new Map();
    this.nextId = 1;
    this.dead = false;
    this.startError = null;
    this.lastIds = [];
  }

  meta(overrides) {
    if (overrides === null) return null;
    const base = {
      [META_VERSION]: this.protocol,
      [META_CAPS]: this.caps,
      [META_INFO]: CLIENT_INFO,
    };
    return overrides ? { ...base, ...overrides } : base;
  }

  async start() {
    this.child = spawn(this.srv.command, this.srv.args, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        // ★ ZORLA mock. Bu doğrulayıcı GERÇEK bir yazma çağrısı yapıyor; live
        //   bir ortamda çalıştırılırsa Xurrent'a kayıt düşerdi.
        XURRENT_MODE: "mock",
        XURRENT_MOCK_PERSIST: "0",
        XURRENT_DRY_RUN: "0",
        // Onay akışı ölçülemezse MRTR/elicitation maddelerinin hepsi anlamsızlaşır.
        XURRENT_CONFIRM_POLICY: "closed",
        CALENDAR_PROVIDER: "mock",
        XURRENT_TIMEZONE: process.env.XURRENT_TIMEZONE ?? "Europe/Istanbul",
        XURRENT_FIXTURES_DIR: path.join(ROOT, "fixtures"),
        MCP_PROTOCOL: this.protocol,
        NO_COLOR: "1",
      },
    });

    this.child.on("error", (err) => {
      this.startError = `Başlatılamadı: ${err.message}`;
      this.dead = true;
      this.#flushPending({ __error: this.startError });
    });
    this.child.on("exit", (code, sig) => {
      this.dead = true;
      this.#flushPending({ __error: `Süreç kapandı (kod ${code}${sig ? ", " + sig : ""}).` });
    });
    this.child.stderr.on("data", (d) => {
      this.stderrBuf += d.toString();
    });
    this.child.stdout.on("data", (d) => this.#onStdout(d.toString()));

    // Süreç anında patlarsa (dosya yok, derlenmemiş) hemen anlaşılsın.
    await sleep(150);
    return this;
  }

  #flushPending(msg) {
    for (const [, cb] of this.pending) cb(msg);
    this.pending.clear();
  }

  #onStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      this.lines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // ★ stdio'da stdout SADECE JSON-RPC içindir. Buraya düşen her satır ihlaldir.
        this.junk.push(line.slice(0, 200));
        continue;
      }
      this.messages.push(msg);
      if (msg?.error && typeof msg.error.code === "number") this.errorCodes.push(msg.error.code);

      // Sunucudan gelen İSTEK (id VAR + method VAR) — v1'de elicitation/create.
      if (msg.method && msg.id !== undefined && msg.id !== null) {
        this.serverRequests.push(msg);
        if (this.onServerRequest) {
          const reply = this.onServerRequest(msg);
          if (reply !== undefined) this.sendObject({ jsonrpc: "2.0", id: msg.id, ...reply });
        } else {
          this.sendObject({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "desteklenmiyor" } });
        }
        continue;
      }
      // Sunucudan gelen BİLDİRİM (method VAR, id YOK) — notifications/message vb.
      if (msg.method && msg.id === undefined) {
        this.serverNotifications.push(msg);
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const cb = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        cb(msg);
      }
    }
  }

  sendObject(obj) {
    if (this.dead || !this.child?.stdin.writable) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  sendRaw(text) {
    if (this.dead || !this.child?.stdin.writable) return;
    this.child.stdin.write(text + "\n");
  }

  /**
   * İstek gönderir. v2'de `_meta` İSTİSNASIZ her isteğe eklenir; el sıkışma
   * olmadığı için sunucunun sürümü/yetenekleri öğrenebileceği başka an yoktur.
   * @param {object} o { id, metaOverrides, noMeta, timeout }
   */
  request(method, params = {}, o = {}) {
    const id = o.id ?? this.nextId++;
    this.lastIds.push(id);
    const isV2 = this.protocol >= V2R;
    let p = { ...params };
    if (isV2 && !o.noMeta) p._meta = this.meta(o.metaOverrides);
    if (o.rawParams !== undefined) p = o.rawParams;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve({ __timeout: true, __ms: o.timeout ?? this.timeout });
      }, o.timeout ?? this.timeout);
      this.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      this.sendObject({ jsonrpc: "2.0", id, method, params: p });
    });
  }

  notify(method, params = {}) {
    this.sendObject({ jsonrpc: "2.0", method, params });
  }

  async close() {
    try {
      this.child?.kill("SIGTERM");
    } catch {
      /* zaten kapandı */
    }
    await sleep(60);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 5) Kayıt defteri
// ═════════════════════════════════════════════════════════════════════════════

const GECTI = "GEÇTİ";
const KALDI = "KALDI";
const ATLANDI = "ATLANDI";

class Rec {
  constructor() {
    /** @type {Map<string,{id:string,seviye:string,madde:string,durum:string,kanit:string,not?:string}>} */
    this.map = new Map();
  }
  set(id, durum, kanit, not) {
    const meta = CATALOG_BY_ID.get(id);
    if (!meta) throw new Error(`Katalogda olmayan madde: ${id}`);
    this.map.set(id, {
      id,
      seviye: meta.seviye,
      alan: meta.alan,
      madde: meta.madde,
      durum,
      kanit: String(kanit ?? "").replace(/\s+/g, " ").slice(0, 220),
      ...(not ? { not } : {}),
    });
  }
  ok(id, kanit) {
    this.set(id, GECTI, kanit);
  }
  no(id, kanit) {
    this.set(id, KALDI, kanit);
  }
  skip(id, kanit) {
    this.set(id, ATLANDI, kanit);
  }
  /** koşul doğruysa GEÇTİ, yanlışsa KALDI — kanıt ikisinde de gerçek cevaptan. */
  assert(id, cond, kanit) {
    this.set(id, cond ? GECTI : KALDI, kanit);
  }
  list() {
    return [...this.map.values()];
  }
}

const q = (v) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? "undefined" : s.length > 200 ? s.slice(0, 199) + "…" : s;
  } catch {
    return String(v);
  }
};
const errText = (m) =>
  m?.__timeout ? `ZAMAN AŞIMI (${m.__ms} ms)` : m?.__error ? m.__error : m?.error ? `${m.error.code}: ${m.error.message}` : "";

// ═════════════════════════════════════════════════════════════════════════════
// 6) Ortak kontroller — tool katmanı (iki revizyonda da aynı)
// ═════════════════════════════════════════════════════════════════════════════

function jsonPointer(root, ref) {
  if (!ref?.startsWith("#/")) return null;
  let cur = root;
  for (const seg of ref.slice(2).split("/")) {
    if (cur == null) return null;
    cur = cur[seg.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return cur ?? null;
}

/** Şemadaki tüm $ref'leri toplar. */
function collectRefs(schema, out = []) {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    for (const s of schema) collectRefs(s, out);
    return out;
  }
  if (typeof schema.$ref === "string") out.push(schema.$ref);
  for (const v of Object.values(schema)) collectRefs(v, out);
  return out;
}

function checkToolLayer(rec, tools, callWhoami, callBad) {
  const names = tools.map((t) => t.name);
  const byName = new Map(tools.map((t) => [t.name, t]));

  // T1 — adlar
  const eksik = expectedNames.filter((n) => !names.includes(n));
  const fazla = names.filter((n) => !expectedNames.includes(n));
  rec.assert(
    "T1",
    eksik.length === 0 && fazla.length === 0,
    eksik.length || fazla.length
      ? `eksik=${q(eksik)} fazla=${q(fazla)}`
      : `${names.length}/${expectedNames.length} tool, adlar birebir: ${q(names.slice(0, 3))}…`,
  );

  // T2 — inputSchema
  const badInput = tools.filter((t) => t.inputSchema?.type !== "object").map((t) => t.name);
  rec.assert("T2", badInput.length === 0, badInput.length ? `type!=object: ${q(badInput)}` : `${tools.length}/${tools.length} inputSchema.type="object"`);

  // T3 — outputSchema
  const withOut = tools.filter((t) => t.outputSchema && typeof t.outputSchema === "object");
  rec.assert(
    "T3",
    withOut.length === tools.length && tools.length > 0,
    `${withOut.length}/${tools.length} tool outputSchema bildiriyor` +
      (withOut.length === tools.length ? "" : `; eksik: ${q(tools.filter((t) => !t.outputSchema).map((t) => t.name))}`),
  );

  // T8 — annotations
  const annDiff = [];
  for (const et of expectedTools) {
    const act = byName.get(et.name);
    if (!act) continue;
    for (const [k, v] of Object.entries(et.annotations ?? {})) {
      if ((act.annotations ?? {})[k] !== v) annDiff.push(`${et.name}.${k}: beklenen ${v}, gelen ${JSON.stringify((act.annotations ?? {})[k])}`);
    }
  }
  rec.assert("T8", annDiff.length === 0, annDiff.length ? q(annDiff.slice(0, 3)) : "readOnly/destructive/idempotent/openWorld dört alan da sözleşmeyle aynı");

  // T9 — $ref çözümü
  const dangling = [];
  for (const t of tools) {
    for (const key of ["inputSchema", "outputSchema"]) {
      const schema = t[key];
      if (!schema) continue;
      for (const ref of collectRefs(schema)) {
        if (jsonPointer(schema, ref) == null) dangling.push(`${t.name}.${key} → ${ref}`);
      }
    }
  }
  const refCount = tools.reduce((a, t) => a + collectRefs(t.inputSchema).length + collectRefs(t.outputSchema).length, 0);
  rec.assert("T9", dangling.length === 0, dangling.length ? `çözülemeyen: ${q(dangling.slice(0, 3))}` : `${refCount} $ref tarandı, hepsi kendi belgesi içinde çözüldü`);

  // T10 — description
  const kısa = tools.filter((t) => !t.description || String(t.description).trim().length < 10).map((t) => t.name);
  rec.assert("T10", kısa.length === 0, kısa.length ? `boş/kısa: ${q(kısa)}` : `${tools.length}/${tools.length} tool anlamlı description taşıyor`);

  // T4/T5/T6 — gerçek çağrı
  if (callWhoami?.error || callWhoami?.__timeout || callWhoami?.__error) {
    const e = errText(callWhoami);
    for (const id of ["T4", "T5", "T6"]) rec.skip(id, `${PROBE.readTool} çağrılamadı — ${e}`);
  } else {
    const r = callWhoami?.result ?? {};
    const sc = r.structuredContent;
    const dolu = sc && typeof sc === "object" && !Array.isArray(sc) && Object.keys(sc).length > 0;
    rec.assert("T4", Boolean(dolu), dolu ? `structuredContent anahtarları: ${q(Object.keys(sc))}` : `structuredContent=${q(sc)}`);

    const texts = (r.content ?? []).filter((x) => x?.type === "text");
    rec.assert("T5", texts.length > 0, texts.length ? `text block var: "${q(String(texts[0].text).slice(0, 80))}"` : `content=${q(r.content)}`);

    const req = expectedByName.get(PROBE.readTool)?.output?.required ?? [];
    const missing = dolu ? req.filter((k) => !(k in sc)) : req;
    rec.assert("T6", dolu && missing.length === 0, missing.length ? `eksik zorunlu alan: ${q(missing)}` : `sözleşmedeki ${q(req)} alanlarının hepsi structuredContent'te`);
  }

  // T7 — isError semantiği
  if (callBad?.__timeout || callBad?.__error) {
    rec.skip("T7", errText(callBad));
  } else if (callBad?.error) {
    rec.no(
      "T7",
      `İş kuralı hatası JSON-RPC hatasına dönüştü (${callBad.error.code}: ${q(callBad.error.message)}) — sözleşme isError=true + okunabilir metin istiyor`,
    );
  } else {
    const r = callBad.result ?? {};
    const txt = (r.content ?? []).find((x) => x?.type === "text")?.text ?? "";
    rec.assert("T7", r.isError === true && txt.length > 0, `isError=${q(r.isError)} metin="${q(String(txt).slice(0, 110))}"`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 7) Ortak kontroller — JSON-RPC temeli
// ═════════════════════════════════════════════════════════════════════════════

async function checkJsonRpcBasics(rec, s, { unknownMethod, badParams, stringIdResp, silence, unknownTool }) {
  // J1 — jsonrpc alanı
  const yanitlar = s.messages.filter((m) => m.id !== undefined);
  const eksikJsonrpc = yanitlar.filter((m) => m.jsonrpc !== "2.0");
  rec.assert(
    "J1",
    yanitlar.length > 0 && eksikJsonrpc.length === 0,
    eksikJsonrpc.length ? `jsonrpc alanı eksik/yanlış: ${q(eksikJsonrpc[0])}` : `${yanitlar.length} yanıtın hepsinde jsonrpc:"2.0"`,
  );

  // J2 — id eşliği (string id tip korunuyor mu?)
  rec.assert(
    "J2",
    stringIdResp?.id === "uyum-string-id",
    `gönderilen id="uyum-string-id" → dönen id=${q(stringIdResp?.id)} (tip: ${typeof stringIdResp?.id})`,
  );

  // J3 — bilinmeyen metod
  rec.assert("J3", unknownMethod?.error?.code === -32601, `uyum/bilinmeyen-metot → ${q(unknownMethod?.error ?? unknownMethod)}`);

  // J4 — geçersiz params
  rec.assert("J4", badParams?.error?.code === -32602, `tools/call (name YOK) → ${q(badParams?.error ?? badParams)}`);

  // J6 — notification sessizliği
  rec.assert("J6", silence.count === 0, silence.count === 0 ? `800 ms boyunca hiç mesaj gelmedi` : `${silence.count} mesaj geldi: ${q(silence.first)}`);

  // J7 — stdout saflığı
  rec.assert("J7", s.junk.length === 0, s.junk.length ? `${s.junk.length} JSON olmayan satır, ilki: ${q(s.junk[0])}` : `${s.lines.length} stdout satırının hepsi geçerli JSON`);

  // J8 — loglar stderr'e
  const errLines = s.stderrBuf.trim().split("\n").filter(Boolean);
  if (!errLines.length) rec.skip("J8", "stderr boş — sunucu hiç log basmadı (ihlal değil, ölçüm yok)");
  else rec.ok("J8", `${errLines.length} satır stderr'e gitti, ilki: ${q(errLines[0].slice(0, 110))}`);

  // J9 — bilinmeyen tool
  if (unknownTool?.__timeout || unknownTool?.__error) rec.skip("J9", errText(unknownTool));
  else {
    const viaError = typeof unknownTool?.error?.code === "number";
    const viaIsError = unknownTool?.result?.isError === true;
    rec.assert("J9", viaError || viaIsError, viaError ? `JSON-RPC hatası ${q(unknownTool.error)}` : `isError=${q(unknownTool?.result?.isError)} result=${q(unknownTool?.result)}`);
  }
}

/** Bozuk JSON testi kendi kısa ömürlü sürecinde çalışır: bağlantıyı öldürebilir. */
async function checkParseError(rec, srv, protocol) {
  const s = new Session(srv, { protocol });
  await s.start();
  // Önce geçerli bir açılış: v2'de serveStdio "era"yı ilk mesajdan seçer.
  if (protocol >= V2R) await s.request("server/discover", {});
  else {
    await s.request("initialize", { protocolVersion: V1R, capabilities: CAPS_WITH_ELICIT, clientInfo: CLIENT_INFO });
    s.notify("notifications/initialized", {});
  }
  const before = s.messages.length;
  s.sendRaw('{"jsonrpc":"2.0","id":991,"method":"tools/list","params":');
  await sleep(1500);
  const yeni = s.messages.slice(before);
  const parse = yeni.find((m) => m?.error?.code === -32700);
  rec.assert(
    "J5",
    Boolean(parse),
    parse
      ? `id=${q(parse.id)} error=${q(parse.error)}`
      : yeni.length
        ? `-32700 yerine: ${q(yeni[0])}`
        : `1500 ms içinde HİÇ yanıt gelmedi (sunucu bozuk satırı sessizce yuttu); stderr: ${q(s.stderrBuf.trim().split("\n").slice(-1)[0] ?? "")}`,
  );
  await s.close();
}

// ═════════════════════════════════════════════════════════════════════════════
// 8) 2026-07-28 (v2) koşusu
// ═════════════════════════════════════════════════════════════════════════════

const INPUT_REQUEST_WHITELIST = new Set(["elicitation/create", "sampling/createMessage", "roots/list"]);

/** requestedSchema'dan makul bir "kabul" içeriği üretir. */
function acceptContent(schema) {
  const content = {};
  for (const [k, spec] of Object.entries(schema?.properties ?? {})) {
    if (Array.isArray(spec?.enum)) content[k] = spec.enum[0];
    else if (spec?.type === "boolean") content[k] = true;
    else if (spec?.type === "number" || spec?.type === "integer") content[k] = spec.default ?? 0;
    else content[k] = spec?.default ?? "";
  }
  return content;
}

async function runV2(srv, rec) {
  const s = new Session(srv, { protocol: V2R, caps: CAPS_WITH_ELICIT });
  await s.start();

  // ── Y1: server/discover (zorunlu _meta ile) ───────────────────────────────
  const disc = await s.request("server/discover", {});
  if (disc.__timeout || disc.__error || (disc.error && disc.error.code === -32601)) {
    // Sunucu v2 konuşmuyor → v2'ye özgü her madde ATLANDI.
    const sebep = disc.error?.code === -32601
      ? `server/discover → -32601 (${q(disc.error.message)}) — bu sunucu 2026-07-28 konuşmuyor`
      : errText(disc) || "server/discover yanıtsız";
    for (const m of CATALOG) {
      if (m.revizyon === V2R && m.otomatik) rec.skip(m.id, sebep);
      if (m.revizyon === HER_IKISI && m.otomatik) rec.skip(m.id, sebep);
    }
    await s.close();
    return { ok: false, sebep };
  }
  rec.assert("Y1", !disc.error, disc.error ? q(disc.error) : `supportedVersions=${q(disc.result?.supportedVersions ?? disc.result?.protocolVersion ?? "(alan yok)")}`);

  // ── tools/list ────────────────────────────────────────────────────────────
  const list = await s.request("tools/list", {});
  const tools = list.result?.tools ?? [];

  // Y5 / Y6 — CacheableResult
  rec.assert("Y5", list.result?.ttlMs === 300000, `tools/list.ttlMs=${q(list.result?.ttlMs)} (beklenen 300000)`);
  rec.assert("Y6", list.result?.cacheScope === "public", `tools/list.cacheScope=${q(list.result?.cacheScope)} (beklenen "public")`);

  // Y7 — deterministik sıra
  const actOrder = tools.map((t) => t.name);
  const sameOrder = actOrder.length === expectedNames.length && actOrder.join("|") === expectedNames.join("|");
  const firstBad = actOrder.findIndex((n, i) => n !== expectedNames[i]);
  rec.assert(
    "Y7",
    sameOrder,
    sameOrder
      ? `${actOrder.length} tool, sözleşme sırasıyla birebir (1. ${actOrder[0]} … ${actOrder.length}. ${actOrder.at(-1)})`
      : `${firstBad + 1}. sırada "${expectedNames[firstBad]}" beklenirken "${actOrder[firstBad]}" geldi`,
  );

  // ── Ham JSON-RPC temeli ───────────────────────────────────────────────────
  const stringIdResp = await s.request("tools/list", {}, { id: "uyum-string-id" });
  const unknownMethod = await s.request("uyum/bilinmeyen-metot", {});
  const badParams = await s.request("tools/call", {}, { rawParams: { _meta: s.meta() } });
  const unknownTool = await s.request("tools/call", { name: "yok_boyle_bir_tool", arguments: {} });

  const before = s.messages.length;
  s.notify("uyum/bildirim-testi", {});
  await sleep(800);
  const gelen = s.messages.slice(before);
  const silence = { count: gelen.length, first: gelen[0] };

  // Y10/Y11/Y12 — v2'de kaldırılan RPC'ler
  const ping = await s.request("ping", {});
  rec.assert("Y10", ping?.error?.code === -32601, `ping → ${q(ping?.error ?? ping?.result ?? ping)}`);
  const setLevel = await s.request("logging/setLevel", { level: "debug" });
  rec.assert("Y11", setLevel?.error?.code === -32601, `logging/setLevel → ${q(setLevel?.error ?? setLevel?.result ?? setLevel)}`);
  const rootsChanged = await s.request("notifications/roots/list_changed", {});
  rec.assert("Y12", rootsChanged?.error?.code === -32601, `notifications/roots/list_changed → ${q(rootsChanged?.error ?? rootsChanged?.result ?? rootsChanged)}`);

  // ── Y8 — handshake YOK ────────────────────────────────────────────────────
  const handshakeSent = s.messages.length >= 0 && false; // initialize HİÇ gönderilmedi
  rec.assert(
    "Y8",
    !handshakeSent && !list.error && tools.length > 0,
    `initialize HİÇ gönderilmedi; server/discover + tools/list (${tools.length} tool) + tools/call çalıştı`,
  );

  // ── Tool katmanı ──────────────────────────────────────────────────────────
  const whoami = await s.request("tools/call", { name: PROBE.readTool, arguments: {} });
  const bad = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.badWriteArgs });
  checkToolLayer(rec, tools, whoami, bad);

  // ── Y4 — resultType her sonuçta ───────────────────────────────────────────
  const rtEksik = [];
  if (disc.result && disc.result.resultType === undefined) rtEksik.push("server/discover");
  if (list.result && list.result.resultType === undefined) rtEksik.push("tools/list");
  if (whoami.result && whoami.result.resultType === undefined) rtEksik.push("tools/call");
  rec.assert(
    "Y4",
    rtEksik.length === 0,
    rtEksik.length
      ? `resultType YOK: ${q(rtEksik)}`
      : `server/discover=${q(disc.result?.resultType)} tools/list=${q(list.result?.resultType)} tools/call=${q(whoami.result?.resultType)}`,
  );

  // ── Y18 — sonucun _meta'sında serverInfo ──────────────────────────────────
  // Handshake kalktığı için sunucunun kendini tanıtabileceği tek yer sonuçlardır.
  // Bu SHOULD'un pratik değeri telemetri/hata ayıklamadır: hangi sunucu sürümünün
  // bu yanıtı ürettiğini başka hiçbir yerden öğrenemezsiniz.
  const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
  const siKaynak = [
    ["server/discover", disc.result],
    ["tools/list", list.result],
    ["tools/call", whoami.result],
  ].filter(([, r]) => r);
  const siEksik = siKaynak.filter(([, r]) => !r?._meta?.[META_SERVER_INFO]).map(([n]) => n);
  rec.assert(
    "Y18",
    siKaynak.length > 0 && siEksik.length === 0,
    siEksik.length
      ? `_meta.serverInfo YOK: ${q(siEksik)} (bkz. discover.result.serverInfo alanı ayrı bir şeydir)`
      : `serverInfo=${q(disc.result?._meta?.[META_SERVER_INFO])} — ${siKaynak.length} sonuç tipinde de var`,
  );

  // ═══ MRTR ════════════════════════════════════════════════════════════════
  const idBefore = s.nextId;
  const first = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.writeArgs });
  const firstId = idBefore;

  if (first.__timeout || first.__error || first.error) {
    for (const id of ["M1", "M2", "M3", "M5", "M6", "M7", "M8", "M9"]) rec.skip(id, `ilk tur başarısız: ${errText(first)}`);
  } else if (first.result?.resultType !== "input_required") {
    const sebep = `resultType=${q(first.result?.resultType)} — onay istenmedi (XURRENT_CONFIRM_POLICY=closed olmasına rağmen)`;
    rec.no("M1", sebep);
    for (const id of ["M2", "M3", "M5", "M6", "M7", "M8", "M9"]) rec.skip(id, "M1 tutmadığı için ölçülemedi");
  } else {
    const ir = first.result;
    rec.ok("M1", `resultType=${q(ir.resultType)}`);

    const keys = Object.keys(ir.inputRequests ?? {});
    rec.assert(
      "M2",
      keys.length > 0 && typeof ir.requestState === "string" && ir.requestState.length > 0,
      `inputRequests anahtarları=${q(keys)} requestState uzunluğu=${String(ir.requestState ?? "").length}`,
    );

    const methods = keys.map((k) => ir.inputRequests[k]?.method ?? "(method alanı yok)");
    const disi = methods.filter((m) => !INPUT_REQUEST_WHITELIST.has(m));
    rec.assert("M3", methods.length > 0 && disi.length === 0, disi.length ? `beyaz liste dışı: ${q(disi)}` : `inputRequests methodları=${q(methods)}`);

    const key = keys[0];
    const schema = ir.inputRequests[key]?.params?.requestedSchema ?? ir.inputRequests[key]?.params?.requested_schema;
    const state = ir.requestState;

    // M5 — kurcalanmış blob
    const son = state.slice(-1);
    const bozuk = state.slice(0, -1) + (son === "A" ? "B" : "A");
    const tamper = await s.request("tools/call", {
      name: PROBE.writeTool,
      arguments: PROBE.writeArgs,
      inputResponses: { [key]: { action: "accept", content: acceptContent(schema) } },
      requestState: bozuk,
    });
    const tamperRed = Boolean(tamper.error) || tamper.result?.isError === true;
    rec.assert(
      "M5",
      tamperRed,
      tamperRed
        ? `reddedildi → ${q(tamper.error ?? (tamper.result?.content ?? []).find((x) => x?.type === "text")?.text ?? tamper.result)}`
        : `KABUL EDİLDİ (!) → ${q(tamper.result)}`,
    );

    // M6 — geçerli blob, FARKLI argüman (parmak izi)
    const fp = await s.request("tools/call", {
      name: PROBE.writeTool,
      arguments: PROBE.writeArgsAlt,
      inputResponses: { [key]: { action: "accept", content: acceptContent(schema) } },
      requestState: state,
    });
    const fpRed = Boolean(fp.error) || fp.result?.isError === true;
    rec.assert(
      "M6",
      fpRed,
      fpRed
        ? `reddedildi → ${q(fp.error ?? (fp.result?.content ?? []).find((x) => x?.type === "text")?.text ?? fp.result)}`
        : `KABUL EDİLDİ (!) minutes 30→60 değiştirildi ama yazma yapıldı: ${q(fp.result?.structuredContent)}`,
    );

    // M7 — doğru tur
    const secondId = s.nextId;
    const good = await s.request("tools/call", {
      name: PROBE.writeTool,
      arguments: PROBE.writeArgs,
      inputResponses: { [key]: { action: "accept", content: acceptContent(schema) } },
      requestState: state,
    });
    const goodOk = !good.error && good.result?.isError !== true && good.result?.resultType === "complete";
    rec.assert(
      "M7",
      goodOk,
      goodOk
        ? `resultType=${q(good.result?.resultType)} dryRun=${q(good.result?.structuredContent?.dryRun)} errors=${q(good.result?.structuredContent?.errors)}`
        : `${q(good.error ?? (good.result?.content ?? []).find((x) => x?.type === "text")?.text ?? good.result)}`,
    );

    // M9 — iki turun id'si FARKLI
    rec.assert("M9", firstId !== secondId, `1. tur id=${q(firstId)} · 2. tur id=${q(secondId)}`);

    // M8 — tek kullanımlık (nonce)
    const replay = await s.request("tools/call", {
      name: PROBE.writeTool,
      arguments: PROBE.writeArgs,
      inputResponses: { [key]: { action: "accept", content: acceptContent(schema) } },
      requestState: state,
    });
    const replayRed = Boolean(replay.error) || replay.result?.isError === true;
    rec.assert(
      "M8",
      replayRed,
      replayRed
        ? `ikinci kullanım reddedildi → ${q(replay.error ?? (replay.result?.content ?? []).find((x) => x?.type === "text")?.text)}`
        : `AYNI blob İKİNCİ KEZ kabul edildi — replay penceresi açık: ${q(replay.result?.structuredContent?.timeEntry ?? replay.result)}`,
    );
  }

  // ── Deprecation: sunucu bize istek göndermiş mi? ──────────────────────────
  const srvReqMethods = s.serverRequests.map((r) => r.method);
  const srvNotifMethods = s.serverNotifications.map((r) => r.method);

  // ── Y13 — hata kodu aralıkları ────────────────────────────────────────────
  const codes = [...new Set(s.errorCodes)];
  const gecerli = (k) =>
    k === -32700 || (k <= -32600 && k >= -32603) || (k <= -32000 && k >= -32019) || (k <= -32020 && k >= -32099);
  const disiKodlar = codes.filter((k) => !gecerli(k));
  rec.assert("Y13", disiKodlar.length === 0, disiKodlar.length ? `aralık dışı: ${q(disiKodlar)}` : `görülen kodlar: ${q(codes)} — hepsi standart JSON-RPC / impl (-32000..-32019) / spec (-32020..-32099) aralığında`);

  await s.close();

  const temel = { stringIdResp, unknownMethod, badParams, silence, unknownTool };
  await checkJsonRpcBasics(rec, s, temel);

  return { ok: true, tools, srvReqMethods, srvNotifMethods, junk: s.junk };
}

/** _meta'sız / eksik _meta'lı sondalar — her biri KENDİ sürecinde. */
async function runV2MetaProbes(srv, rec) {
  // Y2 / Y3 — _meta HİÇ yok
  {
    const s = new Session(srv, { protocol: V2R });
    await s.start();
    const r = await s.request("server/discover", {}, { noMeta: true });
    const red = Boolean(r.error);
    rec.assert("Y2", red, red ? `${q(r.error)}` : `KABUL EDİLDİ (!) → ${q(r.result)}`);
    rec.assert(
      "Y2b",
      red && r.error.code !== -32601,
      r.error?.code === -32601
        ? `-32601 döndü — spec bu kodu "2026 öncesi sunucu" sinyali olarak tanımlar; uyumluluk sondası bu v2 sunucuyu v1 sanar. Beklenen: -32602`
        : `kod=${q(r.error?.code)} — "metot yok" ile karışmıyor, sonda yanılmaz`,
    );
    await s.close();
  }

  // Y15 — clientCapabilities eksik
  let y15Kod = null;
  {
    const s = new Session(srv, { protocol: V2R });
    await s.start();
    const meta = s.meta();
    delete meta[META_CAPS];
    const r = await s.request("server/discover", {}, { rawParams: { _meta: meta } });
    y15Kod = r.error?.code ?? null;
    rec.assert("Y15a", Boolean(r.error), r.error ? q(r.error) : `KABUL EDİLDİ (!) → ${q(r.result)}`);
    const kodAdi = y15Kod === -32021 ? "-32021 MissingRequiredClientCapability (spec)" : y15Kod === -32602 ? "-32602 Invalid params (biçimsel red — savunulabilir)" : y15Kod === -32003 ? "-32003 ESKİ TASLAK NUMARASI" : String(y15Kod);
    rec.assert("Y15b", y15Kod !== null && y15Kod !== -32003, `dönen kod=${kodAdi}`);
    await s.close();
  }

  // Y3a / Y3b — protocolVersion ZORUNLU, clientInfo ise yalnızca SHOULD.
  //
  // İkisi tek maddede toplanamaz çünkü spec onları farklı seviyede tutar:
  // protocolVersion'sız istek işlenemez (sunucu hangi revizyonu konuştuğunu bilemez),
  // clientInfo'suz istek ise gayet işlenebilir — sadece client kendini tanıtmamıştır.
  {
    const s = new Session(srv, { protocol: V2R });
    await s.start();
    const m1 = s.meta();
    delete m1[META_VERSION];
    const r1 = await s.request("server/discover", {}, { rawParams: { _meta: m1 } });
    rec.assert("Y3a", Boolean(r1.error), r1.error ? q(r1.error) : `KABUL EDİLDİ (!) → ${q(r1.result)}`);

    const m2 = s.meta();
    delete m2[META_INFO];
    const r2 = await s.request("server/discover", {}, { rawParams: { _meta: m2 } });
    rec.assert(
      "Y3b",
      !r2.error,
      r2.error
        ? `clientInfo'suz istek REDDEDİLDİ (${q(r2.error)}) — spec clientInfo'yu SHOULD tutar, MUST değil; bu sunucu spec'ten katı davranıyor ve clientInfo göndermeyen uyumlu bir client'ı kırar`
        : `clientInfo olmadan da işlendi (supportedVersions=${q(r2.result?.supportedVersions ?? "(alan yok)")})`,
    );
    await s.close();
  }

  // Y14 — desteklenmeyen protokol sürümü
  {
    const s = new Session(srv, { protocol: V2R });
    await s.start();
    const r = await s.request("server/discover", {}, { metaOverrides: { [META_VERSION]: "1999-01-01" } });
    rec.assert("Y14a", Boolean(r.error), r.error ? q(r.error) : `KABUL EDİLDİ (!) → ${q(r.result)}`);
    rec.assert("Y14b", r.error?.code === -32022, `dönen kod=${q(r.error?.code)} (spec: -32022 UnsupportedProtocolVersion, eski numara -32004)`);
    await s.close();
  }

  // M4 — client elicitation DESTEKLEMİYOR → elicit inputRequest gelmemeli
  {
    const s = new Session(srv, { protocol: V2R, caps: CAPS_WITHOUT_ELICIT });
    await s.start();
    const d = await s.request("server/discover", {});
    if (d.error) {
      rec.skip("M4", `server/discover reddedildi: ${q(d.error)}`);
    } else {
      const r = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.writeArgs });
      const ir = r.result?.resultType === "input_required";
      const methods = ir ? Object.values(r.result.inputRequests ?? {}).map((x) => x?.method) : [];
      const elicitGeldi = methods.includes("elicitation/create");
      rec.assert(
        "M4",
        !elicitGeldi,
        elicitGeldi
          ? `clientCapabilities={} olmasına rağmen elicitation/create istendi: ${q(methods)}`
          : `clientCapabilities={} → resultType=${q(r.result?.resultType)}; elicit isteği gönderilmedi (politika: XURRENT_CONFIRM_POLICY=closed + mock → uyarıyla devam)`,
      );
    }
    await s.close();
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// 9) 2025-11-25 (v1) koşusu
// ═════════════════════════════════════════════════════════════════════════════

async function runV1(srv, rec) {
  // Elicitation cevabını dinamik seçebilmek için tek bir "sonraki cevap" kutusu.
  let nextElicit = { action: "decline" };
  const elicitLog = [];

  const s = new Session(srv, {
    protocol: V1R,
    caps: CAPS_WITH_ELICIT,
    onServerRequest: (msg) => {
      if (msg.method !== "elicitation/create") return { error: { code: -32601, message: "desteklenmiyor" } };
      const schema = msg.params?.requestedSchema ?? msg.params?.requested_schema;
      elicitLog.push({ message: msg.params?.message, action: nextElicit.action });
      if (nextElicit.action === "accept") return { result: { action: "accept", content: acceptContent(schema) } };
      return { result: { action: nextElicit.action } };
    },
  });
  await s.start();

  const init = await s.request("initialize", {
    protocolVersion: V1R,
    capabilities: CAPS_WITH_ELICIT,
    clientInfo: CLIENT_INFO,
  });
  if (init.__timeout || init.__error || init.error) {
    const sebep = errText(init) || "initialize yanıtsız";
    for (const m of CATALOG) {
      if ((m.revizyon === V1R || m.revizyon === HER_IKISI) && m.otomatik) rec.skip(m.id, sebep);
    }
    await s.close();
    return { ok: false, sebep };
  }

  rec.assert("G1", init.result?.protocolVersion === V1R, `initialize.protocolVersion=${q(init.result?.protocolVersion)}`);
  rec.assert(
    "G2",
    Boolean(init.result?.serverInfo) && Boolean(init.result?.capabilities),
    `serverInfo=${q(init.result?.serverInfo)} capabilities=${q(Object.keys(init.result?.capabilities ?? {}))}`,
  );

  s.notify("notifications/initialized", {});
  const list = await s.request("tools/list", {});
  const tools = list.result?.tools ?? [];
  rec.assert("G3", !list.error && tools.length > 0, list.error ? q(list.error) : `notifications/initialized sonrası tools/list ${tools.length} tool döndü`);

  // Ham JSON-RPC temeli
  const stringIdResp = await s.request("tools/list", {}, { id: "uyum-string-id" });
  const unknownMethod = await s.request("uyum/bilinmeyen-metot", {});
  const badParams = await s.request("tools/call", {}, { rawParams: {} });
  const unknownTool = await s.request("tools/call", { name: "yok_boyle_bir_tool", arguments: {} });

  const before = s.messages.length;
  s.notify("uyum/bildirim-testi", {});
  await sleep(800);
  const gelen = s.messages.slice(before);
  const silence = { count: gelen.length, first: gelen[0] };

  // Tool katmanı
  const whoami = await s.request("tools/call", { name: PROBE.readTool, arguments: {} });
  const bad = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.badWriteArgs });
  checkToolLayer(rec, tools, whoami, bad);

  // G8 — v1'de resultType YOK
  const rt = whoami.result?.resultType;
  rec.assert("G8", rt === undefined, rt === undefined ? "tools/call sonucunda resultType alanı yok (client 'complete' saymalı)" : `beklenmedik alan: resultType=${q(rt)}`);

  // ═══ Elicitation: accept / decline / cancel ══════════════════════════════
  const srvReqBefore = s.serverRequests.length;
  nextElicit = { action: "accept" };
  const accept = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.writeArgs });
  const geldi = s.serverRequests.length > srvReqBefore;
  rec.assert(
    "G4",
    geldi && s.serverRequests.at(-1)?.method === "elicitation/create",
    geldi
      ? `sunucu → client İSTEK: ${q(s.serverRequests.at(-1)?.method)} · mesaj: "${q(String(s.serverRequests.at(-1)?.params?.message ?? "").slice(0, 90))}"`
      : `yazma çağrısında sunucu HİÇ istek göndermedi (resultType=${q(accept.result?.resultType)}, isError=${q(accept.result?.isError)})`,
  );

  const acceptOk = !accept.error && accept.result?.isError !== true;
  rec.assert(
    "G5",
    geldi && acceptOk,
    acceptOk
      ? `accept → dryRun=${q(accept.result?.structuredContent?.dryRun)} errors=${q(accept.result?.structuredContent?.errors)}`
      : q(accept.error ?? (accept.result?.content ?? []).find((x) => x?.type === "text")?.text ?? accept.result),
  );

  nextElicit = { action: "decline" };
  const decline = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.writeArgs });
  const declineRed = decline.result?.isError === true || Boolean(decline.error);
  rec.assert(
    "G6",
    declineRed,
    declineRed
      ? `decline → isError=${q(decline.result?.isError)} metin="${q(String((decline.result?.content ?? []).find((x) => x?.type === "text")?.text ?? "").slice(0, 110))}"`
      : `decline'a rağmen YAZILDI: ${q(decline.result?.structuredContent?.timeEntry ?? decline.result)}`,
  );

  nextElicit = { action: "cancel" };
  const cancel = await s.request("tools/call", { name: PROBE.writeTool, arguments: PROBE.writeArgs });
  const cancelRed = cancel.result?.isError === true || Boolean(cancel.error);
  rec.assert(
    "G7",
    cancelRed,
    cancelRed
      ? `cancel → isError=${q(cancel.result?.isError)} metin="${q(String((cancel.result?.content ?? []).find((x) => x?.type === "text")?.text ?? "").slice(0, 110))}"`
      : `cancel'a rağmen YAZILDI: ${q(cancel.result?.structuredContent?.timeEntry ?? cancel.result)}`,
  );

  const srvReqMethods = s.serverRequests.map((r) => r.method);
  const srvNotifMethods = s.serverNotifications.map((r) => r.method);

  await s.close();
  await checkJsonRpcBasics(rec, s, { stringIdResp, unknownMethod, badParams, silence, unknownTool });

  return { ok: true, tools, srvReqMethods, srvNotifMethods, elicitLog };
}

// ═════════════════════════════════════════════════════════════════════════════
// 10) Deprecation — tel üzerinde + kaynak taraması
//
// Tel üzerinde "sunucu bize roots/list göndermedi" demek yeterli DEĞİLDİR:
// göndermediği bir senaryoya hiç girmemiş olabilir. Bu yüzden kaynak da taranır.
// Yorum satırları elenir — bu belgelerde deprecated özelliklerin ADI geçiyor,
// KULLANIMI geçmiyor; ikisini ayırmayan bir tarama yanlış alarm üretir.
// ═════════════════════════════════════════════════════════════════════════════

const CODE_EXT = new Set([".ts", ".py", ".cs"]);
const SKIP_DIR = new Set(["node_modules", "dist", "obj", "bin", ".venv", "__pycache__", ".mypy_cache", ".pytest_cache"]);

function walkSource(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIR.has(e)) continue;
      walkSource(full, out);
    } else if (CODE_EXT.has(path.extname(e))) out.push(full);
  }
  return out;
}

const COMMENT = /^\s*(\/\/|\/\*|\*|#|"""|''')/;

function scanSource(dir, patterns) {
  const hits = [];
  for (const file of walkSource(dir)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (COMMENT.test(line)) continue; // ders notu ≠ kullanım
      for (const p of patterns) {
        if (line.includes(p)) {
          hits.push(`${path.relative(ROOT, file)}:${i + 1} → ${line.trim().slice(0, 90)}`);
          break;
        }
      }
    }
  }
  return hits;
}

function checkDeprecations(rec, srv, wire) {
  const dir = srv.sourceDir;
  const srvReq = wire?.srvReqMethods ?? [];
  const srvNotif = wire?.srvNotifMethods ?? [];

  // D1 — Roots
  const rootsWire = srvReq.filter((m) => String(m).startsWith("roots/"));
  const rootsSrc = scanSource(dir, ['"roots/list"', "'roots/list'", "ListRootsRequest", "listRoots(", "RootsCapability", ".ListRootsAsync"]);
  rec.assert(
    "D1",
    rootsWire.length === 0 && rootsSrc.length === 0,
    rootsWire.length || rootsSrc.length
      ? `tel=${q(rootsWire)} kaynak=${q(rootsSrc.slice(0, 2))}`
      : `sunucu hiç roots/* isteği göndermedi; ${path.relative(ROOT, dir)} altında roots kullanımı yok`,
  );

  // D2 — Sampling
  const sampWire = srvReq.filter((m) => String(m).startsWith("sampling/"));
  const sampSrc = scanSource(dir, ['"sampling/createMessage"', "'sampling/createMessage'", "CreateMessageRequest", "create_message(", "SamplingCapability", "RequestSamplingAsync"]);
  rec.assert(
    "D2",
    sampWire.length === 0 && sampSrc.length === 0,
    sampWire.length || sampSrc.length
      ? `tel=${q(sampWire)} kaynak=${q(sampSrc.slice(0, 2))}`
      : `sunucu hiç sampling/* isteği göndermedi; kaynakta sampling kullanımı yok`,
  );

  // D3 — Logging
  const logWire = srvNotif.filter((m) => String(m) === "notifications/message");
  const logSrc = scanSource(dir, ['"logging/setLevel"', "'logging/setLevel'", '"notifications/message"', "send_log_message(", "SetLoggingLevel", "LoggingCapability"]);
  rec.assert(
    "D3",
    logWire.length === 0 && logSrc.length === 0,
    logWire.length || logSrc.length
      ? `tel=${q(logWire)} kaynak=${q(logSrc.slice(0, 2))}`
      : `notifications/message hiç gelmedi; kaynakta MCP logging kullanımı yok (loglar stderr'e)`,
  );

  // D4 — HTTP+SSE transport
  const sseSrc = scanSource(dir, ["SSEServerTransport", "SseServerTransport", "sse_app(", "SseApp", '"2024-11-05"', "text/event-stream\", \"transport"]);
  rec.assert(
    "D4",
    sseSrc.length === 0,
    sseSrc.length ? q(sseSrc.slice(0, 2)) : "yalnızca Streamable HTTP kullanılıyor; deprecated HTTP+SSE transport'una ait iz yok",
  );

  // D5 — OAuth DCR
  const dcrSrc = scanSource(dir, ["registration_endpoint", "DynamicClientRegistration", '"/register"', "'/register'", "register_client("]);
  rec.assert(
    "D5",
    dcrSrc.length === 0,
    dcrSrc.length ? q(dcrSrc.slice(0, 2)) : "OAuth Dynamic Client Registration ucu yok (bu sunucular kimlik doğrulamayı token ile yapar, DCR akışı hiç kurulmadı)",
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 11) Tablo
// ═════════════════════════════════════════════════════════════════════════════

function table(headers, rows, maxWidth = WIDTH) {
  if (!rows.length) return;
  const cols = headers.length;
  const vis = (s) => String(s ?? "").replace(/\[[0-9;]*m/g, "").length;
  const natural = new Array(cols).fill(0);
  for (const r of [headers, ...rows]) for (let i = 0; i < cols; i++) natural[i] = Math.max(natural[i], vis(r[i]));
  const w = natural.slice();
  let guard = 0;
  while (w.reduce((a, b) => a + b, 0) + cols * 3 + 1 > maxWidth && guard++ < 20000) {
    let idx = 0;
    for (let i = 1; i < cols; i++) if (w[i] > w[idx]) idx = i;
    if (w[idx] <= 6) break;
    w[idx]--;
  }
  const clip = (s, n) => {
    const t = String(s ?? "");
    return vis(t) <= n ? t + " ".repeat(n - vis(t)) : t.slice(0, Math.max(0, n - 1)) + "…";
  };
  const line = (l, m, r) => dim(l + w.map((x) => "─".repeat(x + 2)).join(m) + r);
  write(line("┌", "┬", "┐"));
  write(dim("│") + headers.map((h, i) => " " + bold(clip(h, w[i])) + " ").join(dim("│")) + dim("│"));
  write(line("├", "┼", "┤"));
  for (const r of rows) write(dim("│") + r.map((cell, i) => " " + clip(cell, w[i]) + " ").join(dim("│")) + dim("│"));
  write(line("└", "┴", "┘"));
}

const durumRenk = (d) => (d === GECTI ? green(d) : d === KALDI ? red(d) : yellow(d));
const durumIsaret = (d) => (d === GECTI ? green("✔") : d === KALDI ? red("✘") : d === ATLANDI ? yellow("○") : dim("·"));

// ═════════════════════════════════════════════════════════════════════════════
// 12) Ana akış
// ═════════════════════════════════════════════════════════════════════════════

const rapor = {
  olcumZamani: new Date().toISOString(),
  contractVersion: contract.contractVersion ?? null,
  maddeSayisi: CATALOG.length,
  kosular: [],
  ok: true,
};

write("");
write(bold("  MCP SPEC UYUM DOĞRULAYICISI") + dim("  —  ham JSON-RPC, SDK kullanılmadı"));
write(dim(`  Sözleşme v${contract.contractVersion ?? "?"} · ${CATALOG.length} madde · ${CATALOG.filter((m) => m.otomatik).length} otomatik, ${CATALOG.filter((m) => !m.otomatik).length} elle`));
write(dim(`  XURRENT_MODE=mock ZORLANDI (bu doğrulayıcı gerçek bir yazma turu çalıştırır) · XURRENT_CONFIRM_POLICY=closed`));

for (const key of targets) {
  const srv = SERVERS[key];
  for (const proto of protocols) {
    const rec = new Rec();
    // Otomatikleştirilemeyen maddeler DAİMA ATLANDI — ve gerekçesi raporda görünür.
    for (const m of CATALOG) if (!m.otomatik) rec.skip(m.id, m.neden);
    // Bu revizyona ait olmayan maddeler ölçülmez.
    for (const m of CATALOG) {
      if (m.otomatik && m.revizyon !== HER_IKISI && m.revizyon !== proto) rec.skip(m.id, `bu madde ${m.revizyon} revizyonuna aittir`);
    }

    write("");
    write(dim("─".repeat(WIDTH)));
    write(bold(`  ${srv.label}  ·  ${proto}`) + dim(`   (${srv.command} ${srv.args.map((a) => a.replace(ROOT + path.sep, "")).join(" ")})`));
    write("");

    let wire = null;
    let hata = null;
    try {
      wire = proto === V2R ? await runV2(srv, rec) : await runV1(srv, rec);
      if (wire.ok) {
        if (proto === V2R) await runV2MetaProbes(srv, rec);
        await checkParseError(rec, srv, proto);
      } else {
        hata = wire.sebep;
      }
    } catch (err) {
      hata = String(err?.stack ?? err);
    }
    checkDeprecations(rec, srv, wire);

    if (hata) write(red(`  ✘ ${hata}`));

    const items = CATALOG.map((m) => rec.map.get(m.id)).filter(Boolean);
    const gecti = items.filter((i) => i.durum === GECTI).length;
    const kaldi = items.filter((i) => i.durum === KALDI);
    const atlandi = items.filter((i) => i.durum === ATLANDI).length;
    const mustKaldi = kaldi.filter((i) => i.seviye === "MUST");

    table(
      ["Madde", "Sev.", "Durum", "Açıklama", "Kanıt"],
      items.map((i) => [i.id, i.seviye, durumRenk(i.durum), i.madde, i.kanit]),
    );

    write("");
    write(
      `  ${green(`${gecti} GEÇTİ`)} · ${kaldi.length ? red(`${kaldi.length} KALDI`) : dim("0 KALDI")} · ${yellow(`${atlandi} ATLANDI`)}` +
        (mustKaldi.length ? red(bold(`   ★ ${mustKaldi.length} MUST maddesi KALDI: ${mustKaldi.map((i) => i.id).join(", ")}`)) : green("   ★ MUST ihlali yok")),
    );

    if (mustKaldi.length) rapor.ok = false;
    rapor.kosular.push({
      sunucu: key,
      dil: srv.label,
      protokol: proto,
      hata,
      ozet: { gecti, kaldi: kaldi.length, atlandi, mustKaldi: mustKaldi.length },
      maddeler: items,
    });
  }
}

// ── Dil × madde matrisi ─────────────────────────────────────────────────────
if (rapor.kosular.length > 1) {
  write("");
  write(dim("═".repeat(WIDTH)));
  write(bold("  DİL × MADDE MATRİSİ") + dim("   ✔ geçti · ✘ KALDI · ○ atlandı"));
  write("");
  const cols = rapor.kosular.map((k) => `${k.sunucu} ${k.protokol === V2R ? "v2" : "v1"}`);
  let alan = null;
  const rows = [];
  for (const m of CATALOG) {
    if (m.alan !== alan) {
      alan = m.alan;
      rows.push([dim("── " + alan), ...cols.map(() => dim("─"))]);
    }
    rows.push([
      `${m.id} ${m.seviye === "MUST" ? "!" : "·"} ${m.madde}`,
      ...rapor.kosular.map((k) => durumIsaret(k.maddeler.find((i) => i.id === m.id)?.durum)),
    ]);
  }
  table(["Madde  (! = MUST)", ...cols], rows);
}

// ── Kalan maddelerin dökümü ─────────────────────────────────────────────────
const tumKalanlar = [];
for (const k of rapor.kosular) for (const i of k.maddeler) if (i.durum === KALDI) tumKalanlar.push({ ...i, dil: k.dil, protokol: k.protokol });

write("");
write(dim("═".repeat(WIDTH)));
if (tumKalanlar.length) {
  write(bold(red(`  ${tumKalanlar.length} MADDE KALDI`)));
  write("");
  table(
    ["Dil", "Revizyon", "Madde", "Sev.", "Açıklama", "Kanıt"],
    tumKalanlar.map((i) => [i.dil, i.protokol, i.id, i.seviye === "MUST" ? red("MUST") : yellow("SHOULD"), i.madde, i.kanit]),
  );
  write("");
}
if (rapor.ok) {
  write(green(bold("  ✔ HİÇBİR MUST MADDESİ KALMADI.")));
  if (tumKalanlar.length) write(yellow(`  ○ ${tumKalanlar.length} SHOULD maddesi kaldı — yukarıda listelendi. Çıkış kodu 0.`));
} else {
  write(red(bold("  ✘ MUST İHLALİ VAR — yukarıdaki maddeler spec ihlalidir.")));
}
write("");
write(dim(`  Elle doğrulanacak ${CATALOG.filter((m) => !m.otomatik).length} madde için: node scripts/mcp-uyum.mjs --maddeler`));
write("");

if (JSON_MODE) process.stdout.write(JSON.stringify(rapor, null, 2) + "\n");
process.exit(rapor.ok ? 0 : 1);
