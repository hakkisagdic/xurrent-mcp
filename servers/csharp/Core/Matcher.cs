using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace XurrentMcp.Core;

/// <summary>
/// Toplantı başlığını açık işlerle eşleştiren heuristik.
/// KASITLI OLARAK BASİT VE AÇIKLANABİLİR: her karar kullanıcıya Türkçe gerekçesiyle sunulur.
/// "Akıllı ama açıklanamaz" bir skor, kullanıcının denetleyemeyeceği bir yazma demektir.
/// </summary>
public static class Matcher
{
    public sealed record Result(WorkItem? Item, string Reason, double? Confidence, bool NeedsUserDecision);

    // Xurrent numaraları en az 4 hanelidir (örn. 70248, 4412).
    private static readonly Regex TicketNumber = new(@"\b(\d{4,})\b", RegexOptions.Compiled);

    private static readonly CultureInfo Turkish = new("tr-TR");

    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "ve", "ile", "icin", "bir", "bu", "the", "and", "for",
        "toplanti", "toplantisi", "gorusme", "gorusmesi", "sync", "meeting",
    };

    public static Result Match(string title, IReadOnlyList<WorkItem> candidates)
    {
        // ── YOL 1: başlıkta ticket numarası ──────────────────────────────────
        foreach (Match m in TicketNumber.Matches(title))
        {
            var number = m.Groups[1].Value;
            var hit = candidates.FirstOrDefault(c => c.DisplayId == number);
            if (hit is not null)
            {
                var kindLabel = hit.Kind == "request" ? "Request" : "Task";
                return new Result(hit,
                    $"Başlıkta ticket numarası bulundu: {number} → {kindLabel} #{hit.DisplayId}.",
                    1.0, false);
            }
        }

        // ── YOL 2: normalize edilmiş metin benzerliği ────────────────────────
        var titleTokens = Tokenize(title);
        var scored = candidates
            .Select(c => (Item: c, Shared: SharedTokens(titleTokens, Tokenize(c.Subject ?? ""))))
            .Where(x => x.Shared.Count > 0)
            .OrderByDescending(x => x.Shared.Count)
            .ToList();

        if (scored.Count == 0)
        {
            // ── YOL 3: hiçbiri tutmadı ──────────────────────────────────────
            return new Result(null,
                "Hiçbir açık iş ile eşleşmedi — hangi kayda yazılacağına KULLANICI karar vermelidir.",
                null, true);
        }

        var best = scored[0];
        var second = scored.Count > 1 ? scored[1] : default;

        // Belirsizlik: ikinci aday birinciye YAKINSA tahmin etmek yerine SOR.
        var ambiguous = scored.Count > 1 && second.Shared.Count >= best.Shared.Count * 0.5;
        if (ambiguous)
        {
            return new Result(null,
                $"BELİRSİZ: '{best.Item.Subject}' (#{best.Item.DisplayId}) ve " +
                $"'{second.Item.Subject}' (#{second.Item.DisplayId}) benzer düzeyde eşleşiyor. " +
                "Bot tahmin etmek yerine kullanıcıya SORMALIDIR.",
                null, true);
        }

        // Tek anlamlı ortak kelime zayıf bir sinyaldir — yine de sor.
        if (best.Shared.Count < 2)
        {
            return new Result(null,
                $"Zayıf benzerlik: yalnızca '{string.Join(", ", best.Shared)}' kelimesi ortak. " +
                "Tek kelimelik örtüşme güvenilir değildir — kullanıcı onayı gerekir.",
                0.3, true);
        }

        var confidence = Math.Min(0.9, 0.35 + 0.2 * best.Shared.Count);
        return new Result(best.Item,
            $"Metin benzerliği: ortak anlamlı kelimeler ({string.Join(", ", best.Shared)}) → " +
            $"{(best.Item.Kind == "request" ? "Request" : "Task")} #{best.Item.DisplayId}.",
            Math.Round(confidence, 2), false);
    }

    /// <summary>Türkçe'ye duyarlı normalizasyon + anlamsız kelimelerin elenmesi.</summary>
    private static List<string> Tokenize(string text)
    {
        var lowered = text.ToLower(Turkish);
        var sb = new StringBuilder(lowered.Length);
        foreach (var ch in lowered)
        {
            sb.Append(ch switch
            {
                'ç' => 'c', 'ğ' => 'g', 'ı' => 'i', 'ö' => 'o', 'ş' => 's', 'ü' => 'u',
                'â' => 'a', 'î' => 'i', 'û' => 'u', 'i' => 'i',
                _ => char.IsLetterOrDigit(ch) ? ch : ' ',
            });
        }

        return sb.ToString()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Where(t => t.Length >= 3 && !StopWords.Contains(t))
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>
    /// İki token eşleşir: aynıysa VEYA biri diğerinin ön eki ise (en az 5 karakter).
    /// NEDEN 5: Türkçe eklerini kabaca tolere etmek için ("analiz" ~ "analizi"),
    /// ama "kop" gibi kısa köklerin her şeye uymasını engellemek için.
    /// </summary>
    private static List<string> SharedTokens(List<string> a, List<string> b)
    {
        var shared = new List<string>();
        foreach (var x in a)
        {
            foreach (var y in b)
            {
                if (x == y) { shared.Add(x); break; }
                var min = Math.Min(x.Length, y.Length);
                if (min >= 5 && (x.StartsWith(y, StringComparison.Ordinal) || y.StartsWith(x, StringComparison.Ordinal)))
                {
                    shared.Add(x);
                    break;
                }
            }
        }
        return shared;
    }
}
