using System.Text.Json;
using System.Text.Json.Nodes;

namespace XurrentMcp.Core;

/// <summary>
/// 10 tool'un adı TEK yerde. Hem MCP kayıt katmanı hem chatbot bu sabitleri kullanır;
/// bir tool adı elle iki yerde yazılırsa sessizce ayrışır.
/// </summary>
public static class ToolNames
{
    public const string WhoAmI = "xurrent_whoami";
    public const string FindPerson = "xurrent_find_person";
    public const string ListOpenWork = "xurrent_list_open_work";
    public const string TimeTrackingContext = "xurrent_get_time_tracking_context";
    public const string CreateTimeEntry = "xurrent_create_time_entry";
    public const string CreateTimeEntriesBulk = "xurrent_create_time_entries_bulk";
    public const string CalendarListToday = "calendar_list_today";
    public const string PlanFromCalendar = "plan_time_entries_from_calendar";
    public const string ListTimeEntries = "xurrent_list_time_entries";
    public const string TimesheetWizard = "timesheet_wizard";

    /// <summary>
    /// ★ LLM FİLTRESİ: bu tool Gemini functionDeclarations listesine ÇEVRİLİR Mİ?
    ///
    /// timesheet_wizard çevrilmez (contract/wizard.md §1): wizard'ın kendisi bir
    /// chatbot'tur; LLM'e verilirse chatbot kendi kendini çağırır döngüsü doğar.
    /// Wire-denetimi bu listeyi tam olarak bunun için ölçer.
    /// </summary>
    public static bool ExposedToLlm(string toolName) => toolName != TimesheetWizard;
}

/// <summary>
/// ★ outputSchema'nın TEK KAYNAĞI: contract/tools.json.
///
/// NEDEN elle veriyoruz: ModelContextProtocol 2.0.0'da [McpServerTool] attribute'u
/// yalnızca UseStructuredContent=true bayrağını taşır; ŞEMAYI dönüş tipinden ÜRETİR.
/// Bizim tool'larımız CallToolResult döndürüyor (çünkü hem structuredContent hem
/// okunabilir Türkçe metin yayınlıyoruz) — yani türetilecek anlamlı bir dönüş tipi YOK.
/// SDK bu durum için açık bir kapı bırakmış: McpServerToolCreateOptions.OutputSchema.
/// Ama bu alan attribute üzerinden verilemez; bu yüzden düşük seviye tool kaydına
/// (McpServerTool.Create + delegate) geçtik.
///
/// Sözleşmeden türetmenin bedava faydası: şema ile gerçek çıktı ayrışırsa
/// scripts/verify-contract.mjs değil, ÇALIŞMA ANI yakalar.
/// </summary>
public static class ToolContracts
{
    private static readonly Lock Gate = new();
    private static Dictionary<string, JsonElement>? _outputSchemas;
    private static List<string>? _order;

    /// <summary>contract/tools.json'daki tool sırası. tools/list bu sırayı KORUR.</summary>
    public static IReadOnlyList<string> Order => _order ?? throw NotLoaded();

    /// <summary>Tool'un outputSchema'sı — $ref'ler çözülmüş, $defs gömülmüş hâlde.</summary>
    public static JsonElement OutputSchema(string toolName)
        => (_outputSchemas ?? throw NotLoaded()).TryGetValue(toolName, out var s)
            ? s
            : throw new InvalidOperationException(
                $"contract/tools.json içinde '{toolName}' tool'unun output şeması yok.");

    private static InvalidOperationException NotLoaded()
        => new("ToolContracts.Load(repoRoot) çağrılmadan şema istendi.");

    /// <summary>
    /// Sözleşmeyi bir kez okur. Süreç boyunca değişmez (tool listesi statiktir —
    /// tools/list'in ttlMs=300000 + cacheScope=public ile yayınlanmasının gerekçesi de budur).
    /// </summary>
    public static void Load(string repoRoot)
    {
        lock (Gate)
        {
            if (_outputSchemas is not null) return;

            var path = Path.Combine(repoRoot, "contract", "tools.json");
            if (!File.Exists(path))
                throw new FileNotFoundException(
                    $"Tool sözleşmesi bulunamadı: {path}. outputSchema bu dosyadan türetilir.", path);

            var doc = JsonNode.Parse(File.ReadAllText(path))!.AsObject();
            var defs = doc["$defs"]?.AsObject()
                       ?? throw new InvalidOperationException("contract/tools.json içinde $defs yok.");

            var schemas = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            var order = new List<string>();

            foreach (var node in doc["tools"]!.AsArray())
            {
                var tool = node!.AsObject();
                var name = tool["name"]!.GetValue<string>();
                order.Add(name);

                var output = tool["output"]?.DeepClone()
                             ?? throw new InvalidOperationException($"'{name}' tool'unda output şeması yok.");

                schemas[name] = BuildSchema(output, defs);
            }

            _outputSchemas = schemas;
            _order = order;
        }
    }

    /// <summary>
    /// Sözleşmedeki "output" düğümünü tek başına ayakta durabilen bir JSON Schema'ya çevirir:
    ///
    ///   1) Tepe seviyede { "$ref": "#/$defs/WriteResult" } varsa AÇILIR.
    ///      NEDEN: 2026-07-28 ÖNCESİ revizyonlar outputSchema.type == "object" ŞARTI koyar.
    ///      Tepe $ref bırakılırsa SDK şemayı {"type":"object","properties":{"result":...}}
    ///      diye SARMALAR ve structuredContent'imiz artık şemaya uymaz.
    ///   2) $defs bloğu şemanın İÇİNE kopyalanır ki "#/$defs/Person" gibi iç referanslar
    ///      sözleşme dosyasından bağımsız olarak çözülebilsin.
    /// </summary>
    private static JsonElement BuildSchema(JsonNode output, JsonObject defs)
    {
        var schema = output.AsObject();

        if (schema.Count == 1 && schema["$ref"]?.GetValue<string>() is { } topRef)
        {
            var key = topRef["#/$defs/".Length..];
            schema = (defs[key] ?? throw new InvalidOperationException($"$defs/{key} yok."))
                .DeepClone().AsObject();
        }

        schema["$defs"] = defs.DeepClone();
        return JsonSerializer.Deserialize<JsonElement>(schema.ToJsonString(Json.Options));
    }
}
