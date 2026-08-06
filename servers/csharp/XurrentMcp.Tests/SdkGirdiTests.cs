using System.Text.Json.Nodes;
using Xunit;
using XurrentMcp.Xurrent;
using Sdk = global::Xurrent.GraphQL;   // çevreleyen XurrentMcp.Xurrent ad alanı "Xurrent" adını gölgeler

namespace XurrentMcp.Tests;

/// <summary>
/// ★ WP4 — resmî Xurrent.GraphQL SDK'sının girdi-kurma katmanı (Xurrent/SdkLiveAdapter.cs).
///
/// SONDA SONUCU gereği (SdkLiveAdapter başlığı): SDK'nın endpoint'i keyfi bir URL'ye
/// yönlendirilemediği için sahte sunucuya karşı canlı senaryo KOŞULAMAZ. Bu yüzden
/// birim testlerin doğruladığı yüzey TAM OLARAK girdi-kurma katmanıdır (SdkGirdi):
/// PlannedMutation'ın JSON input'u → SDK'nın tipli Input nesneleri.
/// </summary>
public class SdkGirdiTests
{
    [Fact]
    public void time_entry_create_tum_alanlari_tasir()
    {
        var input = JsonNode.Parse("""
            {"timeSpent":120,"date":"2026-08-02","startedAt":"2026-08-02T14:00:00+03:00",
             "personId":"P1","timeAllocationId":"TA1","effortClassId":"EC1",
             "description":"VPN bakımı","correction":false,
             "source":"xurrent-mcp","sourceID":"xmcp-abc","clientMutationId":"xmcp-abc"}
            """)!.AsObject();

        var x = SdkGirdi.TimeEntryCreate(input);

        Assert.Equal(120, x.TimeSpent);
        Assert.Equal(new DateOnly(2026, 8, 2), x.Date);
        Assert.NotNull(x.StartedAt);
        Assert.Equal("P1", x.PersonId);
        Assert.Equal("TA1", x.TimeAllocationId);
        Assert.Equal("EC1", x.EffortClassId);
        Assert.Equal("VPN bakımı", x.Description);
        Assert.Equal("xurrent-mcp", x.Source);
        Assert.Equal("xmcp-abc", x.SourceID);
        Assert.Equal("xmcp-abc", x.ClientMutationId);
    }

    [Fact]
    public void time_entry_update_id_ve_duzeltme_alanlarini_tasir()
    {
        var input = JsonNode.Parse("""
            {"id":"TE1","date":"2026-08-02","personId":"P2",
             "startedAt":"2026-08-02T09:30:00+03:00","clientMutationId":"xmcp-abc-fix"}
            """)!.AsObject();

        var x = SdkGirdi.TimeEntryUpdate(input);

        Assert.Equal("TE1", x.ID);
        Assert.Equal(new DateOnly(2026, 8, 2), x.Date);
        Assert.Equal("P2", x.PersonId);
        Assert.NotNull(x.StartedAt);
        Assert.Null(x.TimeSpent);                    // gönderilmedi → dokunulmaz (mutlak SET yarım olmaz)
    }

    /// <summary>
    /// ★ Dürüst bulgu: SDK'nın RequestUpdateInput'unda timeEntryDescription ALANI YOKTUR
    /// (TimeSpent + TimeSpentEffortClassId + Note vardır). Elle yazılmış GraphQL yolu bu
    /// alanı gönderir — hangisi gerçek şemayla örtüşüyor, DOĞRULANMALI (docs/08 adayı).
    /// Test, alanın taşınAMAdığını sözleşme olarak sabitler: sessiz kayıp sürpriz olmasın.
    /// </summary>
    [Fact]
    public void request_update_artimli_ucluyu_tasir_timeEntryDescription_sdkda_yoktur()
    {
        var input = JsonNode.Parse("""
            {"id":"R1","timeSpent":45,"timeSpentEffortClassId":"EC2",
             "timeEntryDescription":"tasinamaz","note":"iç not","clientMutationId":"x"}
            """)!.AsObject();

        var x = SdkGirdi.RequestUpdate(input);

        Assert.Equal("R1", x.ID);
        Assert.Equal(45, x.TimeSpent);
        Assert.Equal("EC2", x.TimeSpentEffortClassId);
        Assert.Equal("iç not", x.Note);
        // timeEntryDescription için SDK tipinde hedef alan yok — derleyici düzeyinde kanıt:
        Assert.Null(typeof(Sdk.RequestUpdateInput).GetProperty("TimeEntryDescription"));
    }

    [Fact]
    public void task_update_ayni_ucluyu_tasir()
    {
        var input = JsonNode.Parse("""{"id":"T1","timeSpent":30,"timeSpentEffortClassId":"EC1"}""")!.AsObject();
        var x = SdkGirdi.TaskUpdate(input);
        Assert.Equal("T1", x.ID);
        Assert.Equal(30, x.TimeSpent);
        Assert.Equal("EC1", x.TimeSpentEffortClassId);
    }

    /// <summary>XURRENT_GRAPHQL_URL'den SDK'nın istediği domain SONEKİ türetilir.</summary>
    [Fact]
    public void graphql_urlden_domain_soneki_turetilir()
    {
        Assert.Equal("xurrent.com", SdkLiveAdapter.DomainFromGraphqlUrl("https://graphql.xurrent.com"));
        Assert.Equal("xurrent.qa", SdkLiveAdapter.DomainFromGraphqlUrl("https://graphql.xurrent.qa"));
        Assert.Equal("xurrent-demo.com", SdkLiveAdapter.DomainFromGraphqlUrl("https://graphql.xurrent-demo.com"));
        // graphql. öneki yoksa host olduğu gibi kalır (sürpriz dönüşüm yok).
        Assert.Equal("127.0.0.1", SdkLiveAdapter.DomainFromGraphqlUrl("http://127.0.0.1:4000"));
    }

    /// <summary>SDK enum adları → sözleşmenin snake_case durum değerleri.</summary>
    [Fact]
    public void sdk_enum_adlari_snake_case_duruma_cevrilir()
    {
        Assert.Equal("in_progress", SdkLiveAdapter.StatusWire<Sdk.RequestStatus>(
            Sdk.RequestStatus.InProgress));
        Assert.Equal("waiting_for_customer", SdkLiveAdapter.StatusWire<Sdk.RequestStatus>(
            Sdk.RequestStatus.WaitingForCustomer));
        Assert.Null(SdkLiveAdapter.StatusWire<Sdk.RequestStatus>(null));
    }
}
