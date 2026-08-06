using Xunit;
using XurrentMcp.Agent;
using XurrentMcp.Core;

namespace XurrentMcp.Tests;

/// <summary>
/// ★ Wire-denetimi (contract/wizard.md §1/§6): timesheet_wizard Gemini
/// functionDeclarations listesine ÇEVRİLMEZ. Sebep: wizard'ın kendisi bir chatbot'tur;
/// LLM'e tool olarak verilseydi LLM'li chatbot içinden LLM'siz chatbot çağrılır ve
/// kendi kendini çağırma döngüsü doğardı.
///
/// Test GERÇEK zinciri ölçer: AgentCore süreç içi MCP oturumu açar, tools/list'i
/// çeker ve functionDeclarations'ı kurar — filtre tam bu köprüde yaşar.
/// </summary>
public class GeminiFiltreTests
{
    [Fact]
    public void filtre_karari_tek_yerde_yasar_ve_yalnizca_wizardi_dislar()
    {
        Assert.False(ToolNames.ExposedToLlm(ToolNames.TimesheetWizard));

        foreach (var ad in new[]
                 {
                     ToolNames.WhoAmI, ToolNames.FindPerson, ToolNames.ListOpenWork,
                     ToolNames.TimeTrackingContext, ToolNames.CreateTimeEntry,
                     ToolNames.CreateTimeEntriesBulk, ToolNames.CalendarListToday,
                     ToolNames.PlanFromCalendar, ToolNames.ListTimeEntries,
                 })
            Assert.True(ToolNames.ExposedToLlm(ad), $"{ad} LLM'e açık olmalıydı");
    }

    [Fact]
    public async Task gemini_ye_cevrilen_listede_wizard_YOK_diger_dokuz_tool_VAR()
    {
        var cfg = Ortam.Yapilandirma();

        // requireLlm=false: GEMINI_API_KEY olmadan da tool köprüsü kurulur; sohbet edilmez.
        await using var agent = await AgentCore.CreateAsync(cfg, requireLlm: false);

        // tools/list 10 tool döner; çeviri listesi 9'da kalır — fark tam olarak wizard'dır.
        Assert.Equal(9, agent.ToolNames.Count);
        Assert.DoesNotContain(ToolNames.TimesheetWizard, agent.ToolNames);

        // Yeni okuma tool'u DAHİLDİR — filtre yalnızca wizard'ı dışlar.
        Assert.Contains(ToolNames.ListTimeEntries, agent.ToolNames);

        // Sıra da sözleşme sırasıdır (wizard atlanarak).
        var beklenen = ToolContracts.Order.Where(ToolNames.ExposedToLlm).ToList();
        Assert.Equal(beklenen, agent.ToolNames);
    }
}
