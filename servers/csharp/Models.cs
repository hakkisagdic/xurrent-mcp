using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using XurrentMcp.Calendars;

namespace XurrentMcp;

// Bu dosyadaki tipler contract/tools.json'daki $defs bölümünün BİREBİR karşılığıdır.
// JSON anahtarları camelCase olmak ZORUNDA (sözleşme testi bunu doğrular), bu yüzden
// her alanda açık [JsonPropertyName] var — PascalCase varsayılanına güvenilmiyor.

public sealed record OrganizationRef(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name);

public sealed record Person(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("primaryEmail")] string? PrimaryEmail,
    [property: JsonPropertyName("jobTitle")] string? JobTitle,
    [property: JsonPropertyName("timeZone")] string? TimeZone,
    [property: JsonPropertyName("disabled")] bool? Disabled,
    [property: JsonPropertyName("organization")] OrganizationRef? Organization);

public sealed record AccountInfo(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("directory")] bool? Directory);

public sealed record RateLimitInfo(
    [property: JsonPropertyName("limit")] double Limit,
    [property: JsonPropertyName("cost")] double Cost,
    [property: JsonPropertyName("remaining")] double Remaining,
    [property: JsonPropertyName("resetAt")] double ResetAt);

public sealed record WhoAmIResult(
    [property: JsonPropertyName("person")] Person Person,
    [property: JsonPropertyName("account")] AccountInfo Account,
    [property: JsonPropertyName("mode")] string Mode,
    [property: JsonPropertyName("rateLimit")] RateLimitInfo? RateLimit);

public sealed record FindPersonResult(
    [property: JsonPropertyName("totalCount")] int TotalCount,
    [property: JsonPropertyName("people")] IReadOnlyList<Person> People,
    [property: JsonPropertyName("suggestFuzzy")] bool SuggestFuzzy);

public sealed record WorkItem(
    [property: JsonPropertyName("kind")] string Kind,
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("displayId")] string DisplayId,
    [property: JsonPropertyName("subject")] string? Subject,
    [property: JsonPropertyName("status")] string? Status,
    [property: JsonPropertyName("statusLabel")] string? StatusLabel,
    [property: JsonPropertyName("isOpen")] bool IsOpen,
    [property: JsonPropertyName("targetAt")] string? TargetAt,
    [property: JsonPropertyName("team")] string? Team,
    [property: JsonPropertyName("member")] string? Member,
    [property: JsonPropertyName("parentLabel")] string? ParentLabel,
    [property: JsonPropertyName("updatedAt")] string? UpdatedAt);

public sealed record WorkPage(
    [property: JsonPropertyName("totalCount")] int TotalCount,
    [property: JsonPropertyName("hasNextPage")] bool HasNextPage,
    [property: JsonPropertyName("endCursor")] string? EndCursor,
    [property: JsonPropertyName("nodes")] IReadOnlyList<WorkItem> Nodes);

public sealed record ListOpenWorkResult(
    [property: JsonPropertyName("accountId")] string AccountId,
    [property: JsonPropertyName("requests")] WorkPage Requests,
    [property: JsonPropertyName("tasks")] WorkPage Tasks);

public sealed record EffortClass(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("position")] int? Position,
    [property: JsonPropertyName("costMultiplier")] double? CostMultiplier,
    [property: JsonPropertyName("disabled")] bool? Disabled);

public sealed record TimeAllocationInfo(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string? Name,
    [property: JsonPropertyName("group")] string? Group,
    [property: JsonPropertyName("descriptionRequired")] bool? DescriptionRequired);

public sealed record TimeTrackingDefaults(
    [property: JsonPropertyName("requestEffortClassId")] string? RequestEffortClassId,
    [property: JsonPropertyName("taskEffortClassId")] string? TaskEffortClassId,
    [property: JsonPropertyName("projectTaskEffortClassId")] string? ProjectTaskEffortClassId,
    [property: JsonPropertyName("problemEffortClassId")] string? ProblemEffortClassId,
    [property: JsonPropertyName("timeAllocationEffortClassId")] string? TimeAllocationEffortClassId);

public sealed record TimeTrackingContext(
    [property: JsonPropertyName("unit")] string? Unit,
    [property: JsonPropertyName("timeIncrement")] int? TimeIncrement,
    [property: JsonPropertyName("workday")] int? Workday,
    [property: JsonPropertyName("workweek")] int? Workweek,
    [property: JsonPropertyName("allowWorkdayOvertime")] bool? AllowWorkdayOvertime,
    [property: JsonPropertyName("allowWorkweekOvertime")] bool? AllowWorkweekOvertime,
    [property: JsonPropertyName("allocationTimeTracking")] bool? AllocationTimeTracking,
    [property: JsonPropertyName("assignmentTimeTracking")] bool? AssignmentTimeTracking,
    [property: JsonPropertyName("requireNote")] bool? RequireNote,
    [property: JsonPropertyName("requireTimeEntryDescription")] bool? RequireTimeEntryDescription,
    [property: JsonPropertyName("effortClasses")] IReadOnlyList<EffortClass> EffortClasses,
    [property: JsonPropertyName("timeAllocations")] IReadOnlyList<TimeAllocationInfo> TimeAllocations,
    [property: JsonPropertyName("defaults")] TimeTrackingDefaults Defaults);

public sealed record ValidationError(
    [property: JsonPropertyName("message")] string Message,
    [property: JsonPropertyName("path")] IReadOnlyList<string>? Path);

public sealed record PlannedMutation(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("mutation")] string Mutation,
    [property: JsonPropertyName("input")] JsonObject Input,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings,
    [property: JsonPropertyName("stepLabel")] string? StepLabel);

public sealed record WriteResult(
    [property: JsonPropertyName("dryRun")] bool DryRun,
    [property: JsonPropertyName("strategy")] string Strategy,
    [property: JsonPropertyName("strategyExplanation")] string StrategyExplanation,
    [property: JsonPropertyName("planned")] IReadOnlyList<PlannedMutation> Planned,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings,
    [property: JsonPropertyName("timeEntry")] JsonObject? TimeEntry,
    [property: JsonPropertyName("errors")] IReadOnlyList<ValidationError> Errors);

public sealed record BulkRowResult(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("timeEntryId")] string? TimeEntryId,
    [property: JsonPropertyName("errors")] IReadOnlyList<ValidationError> Errors);

public sealed record BulkSummary(
    [property: JsonPropertyName("requested")] int Requested,
    [property: JsonPropertyName("created")] int Created,
    [property: JsonPropertyName("failed")] int Failed,
    [property: JsonPropertyName("skipped")] int Skipped,
    [property: JsonPropertyName("totalMinutes")] int TotalMinutes);

public sealed record BulkResult(
    [property: JsonPropertyName("dryRun")] bool DryRun,
    [property: JsonPropertyName("planned")] IReadOnlyList<PlannedMutation> Planned,
    [property: JsonPropertyName("results")] IReadOnlyList<BulkRowResult> Results,
    [property: JsonPropertyName("summary")] BulkSummary Summary);

public sealed record CalendarTotals(
    [property: JsonPropertyName("count")] int Count,
    [property: JsonPropertyName("busyMinutes")] int BusyMinutes,
    [property: JsonPropertyName("naiveSumMinutes")] int NaiveSumMinutes,
    [property: JsonPropertyName("rawCount")] int RawCount,
    [property: JsonPropertyName("filteredOut")] int FilteredOut);

public sealed record CalendarResult(
    [property: JsonPropertyName("windowStart")] string WindowStart,
    [property: JsonPropertyName("windowEnd")] string WindowEnd,
    [property: JsonPropertyName("timeZone")] string TimeZone,
    [property: JsonPropertyName("provider")] string Provider,
    [property: JsonPropertyName("meetings")] IReadOnlyList<Meeting> Meetings,
    [property: JsonPropertyName("totals")] CalendarTotals Totals);

public sealed record Proposal(
    [property: JsonPropertyName("meetingTitle")] string MeetingTitle,
    [property: JsonPropertyName("startedAt")] string StartedAt,
    [property: JsonPropertyName("rawMinutes")] int RawMinutes,
    [property: JsonPropertyName("roundedMinutes")] int RoundedMinutes,
    [property: JsonPropertyName("suggestedTargetType")] string? SuggestedTargetType,
    [property: JsonPropertyName("suggestedTargetId")] string? SuggestedTargetId,
    [property: JsonPropertyName("suggestedTargetLabel")] string? SuggestedTargetLabel,
    [property: JsonPropertyName("matchReason")] string? MatchReason,
    [property: JsonPropertyName("matchConfidence")] double? MatchConfidence,
    [property: JsonPropertyName("needsUserDecision")] bool NeedsUserDecision,
    [property: JsonPropertyName("warnings")] IReadOnlyList<string> Warnings);

public sealed record PlanTotals(
    [property: JsonPropertyName("meetingMinutes")] int MeetingMinutes,
    [property: JsonPropertyName("proposedMinutes")] int ProposedMinutes);

public sealed record PlanResult(
    [property: JsonPropertyName("date")] string Date,
    [property: JsonPropertyName("timeIncrement")] int? TimeIncrement,
    [property: JsonPropertyName("proposals")] IReadOnlyList<Proposal> Proposals,
    [property: JsonPropertyName("unmatchedMeetings")] IReadOnlyList<string> UnmatchedMeetings,
    [property: JsonPropertyName("totals")] PlanTotals Totals);

/// <summary>Bir zaman girişi isteğinin dil-bağımsız girdi şekli (tool parametrelerinin taşıyıcısı).</summary>
public sealed class TimeEntryRequest
{
    public string TargetType { get; set; } = "request";
    public string TargetId { get; set; } = "";
    public int Minutes { get; set; }
    public string? Date { get; set; }
    public string? StartedAt { get; set; }
    public string? PersonId { get; set; }
    public string? EffortClassId { get; set; }
    public string? Description { get; set; }
    public string? Note { get; set; }
    public string? CustomerId { get; set; }
    public string? ServiceId { get; set; }
    public string? OrganizationId { get; set; }
    public string? TeamId { get; set; }
    public bool Correction { get; set; }
    public string? SourceId { get; set; }
    public string? BackdateStrategy { get; set; }
}
