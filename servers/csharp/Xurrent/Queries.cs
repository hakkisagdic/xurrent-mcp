namespace XurrentMcp.Xurrent;

/// <summary>
/// Xurrent GraphQL sorgu/mutation metinleri.
/// Bu metinler dry-run çıktısında BİREBİR gösterilir — derste "ne gönderilecekti"
/// sorusunu anlatmak yerine GÖSTERMEK için.
/// </summary>
public static class Queries
{
    // ── Kimlik ───────────────────────────────────────────────────────────────
    public const string Me = """
        query Me {
          me {
            id
            name
            primaryEmail
            jobTitle
            timeZone
            disabled
            organization { id name }
          }
          account { id name directory }
        }
        """;

    // ── Kişi arama ───────────────────────────────────────────────────────────
    // TUZAK: PersonFilter.primaryEmail bir TextFilter'dır -> TAM eşleşme yapar,
    // substring araması DEĞİLDİR. "ayse" yazan kullanıcı 0 sonuç alır.
    public const string FindPerson = """
        query FindPerson($email: String!, $view: PersonView!) {
          people(first: 25, view: $view, filter: { primaryEmail: { values: [$email] } }) {
            totalCount
            nodes {
              id
              name
              primaryEmail
              jobTitle
              timeZone
              disabled
              organization { id name }
            }
          }
        }
        """;

    // ── Açık Request'ler ─────────────────────────────────────────────────────
    // TUZAK 1: RequestFilter'da atanan kişi alanı "member"dır ("assignee" DEĞİL).
    // TUZAK 2: $personId String! olarak deklare edilir — ID! DEĞİL. Çünkü
    //          PersonReferenceFilter.values tipi [String]!'dir.
    // TUZAK 3: view varsayılanı current_account'tur; "all" AÇIKÇA geçilmelidir.
    // TUZAK 4: RequestStatus'ta TEK terminal değer "completed"tir.
    // TUZAK 5: Request'te tamamlanma alanı "completedAt", hedef alanı "nextTargetAt".
    public const string OpenRequests = """
        query OpenRequests($personId: String!, $first: Int!, $after: String, $view: RequestView!) {
          requests(
            first: $first
            after: $after
            view: $view
            order: { field: updatedAt, direction: desc }
            filter: {
              member: { values: [$personId] }
              status: { negate: true, values: [completed] }
            }
          ) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              requestId
              subject
              status
              completedAt
              nextTargetAt
              updatedAt
              team { id name }
              member { id name }
            }
          }
        }
        """;

    // ── Açık Task'lar ────────────────────────────────────────────────────────
    // TUZAK 1: TaskFilter'da atanan kişi alanı "assignee"dir — "member" ALANI YOKTUR.
    // TUZAK 2: TaskStatus'ta BEŞ terminal değer vardır. Sadece "completed"ı elemek
    //          "approved" durumundaki kaydı AÇIK sanmaya yol açar.
    // TUZAK 3: Task'ta "completedAt" ALANI YOKTUR — karşılığı "finishedAt"tır.
    public const string OpenTasks = """
        query OpenTasks($personId: String!, $first: Int!, $after: String, $view: TaskView!) {
          tasks(
            first: $first
            after: $after
            view: $view
            order: { field: updatedAt, direction: desc }
            filter: {
              assignee: { values: [$personId] }
              status: { negate: true, values: [completed, approved, failed, rejected, canceled] }
            }
          ) {
            totalCount
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              taskId
              subject
              status
              finishedAt
              completionTargetAt
              updatedAt
              team { id name }
              member { id name }
              workflow { id subject }
            }
          }
        }
        """;

    // ── Zaman takibi bağlamı ─────────────────────────────────────────────────
    // TUZAK: EffortClassFilter'da "disabled" filtresi YOKTUR -> disabled olanlar
    //        CLIENT tarafında elenmek zorundadır. Bu yüzden disabled alanını çekiyoruz.
    public const string TimeTrackingContext = """
        query TimeTrackingContext($personId: String!) {
          me {
            id
            organization {
              id
              timesheetSetting {
                id
                unit
                workday
                workweek
                timeIncrement
                allowWorkdayOvertime
                allowWorkweekOvertime
                allocationTimeTracking
                assignmentTimeTracking
                requireNote
                requireTimeEntryDescription
                requestEffortClass { id }
                taskEffortClass { id }
                projectTaskEffortClass { id }
                problemEffortClass { id }
                timeAllocationEffortClass { id }
              }
            }
          }
          effortClasses(first: 100) {
            nodes { id name position costMultiplier disabled }
          }
          timeAllocations(first: 100, filter: { disabled: false }) {
            nodes { id name group descriptionRequired }
          }
        }
        """;

    // ── YOL A: timeEntryCreate ───────────────────────────────────────────────
    // DİKKAT: TimeEntryCreateInput içinde requestId / taskId / assignmentId ALANI YOKTUR.
    // Bu mutation ile oluşan kaydın assignment değeri NULL'dır — ticket'a bağlanmaz.
    // Şema seviyesinde TEK zorunlu alan timeSpent'tir (Int!, DAKİKA).
    public const string TimeEntryCreate = """
        mutation TimeEntryCreate($input: TimeEntryCreateInput!) {
          timeEntryCreate(input: $input) {
            clientMutationId
            errors { message path }
            timeEntry {
              id
              date
              startedAt
              timeSpent
              description
              correction
              person { id name }
              effortClass { id name }
              timeAllocation { id name }
            }
          }
        }
        """;

    // ── YOL A telafisi / two_step 2. adımı: timeEntryUpdate ──────────────────
    // KRİTİK: TimeEntryUpdateInput içinde de assignment ALANI YOKTUR.
    // Bir alan input şemasında yoksa güncellenemez -> mevcut değeri KORUNUR.
    // two_step stratejisi tam olarak bu garantiye dayanır: 2. adım ticket bağını BOZAMAZ.
    public const string TimeEntryUpdate = """
        mutation TimeEntryUpdate($input: TimeEntryUpdateInput!) {
          timeEntryUpdate(input: $input) {
            clientMutationId
            errors { message path }
            timeEntry {
              id
              date
              startedAt
              timeSpent
              description
              person { id name }
            }
          }
        }
        """;

    // ── YOL B: parent update mutation'ları ───────────────────────────────────
    // Ortak üçlü: timeSpent (Int, DAKİKA, ARTIMLI), timeSpentEffortClassId, timeEntryDescription.
    // timeSpent "en son girişten bu yana EKLENEN süre"dir — TOPLAM DEĞİLDİR.
    // date sunucu tarafından "bugün", person authenticated user olarak atanır; KONTROL EDİLEMEZ.
    public const string RequestUpdate = """
        mutation RequestUpdate($input: RequestUpdateInput!) {
          requestUpdate(input: $input) {
            clientMutationId
            errors { message path }
            request { id requestId subject status timeSpent }
          }
        }
        """;

    public const string TaskUpdate = """
        mutation TaskUpdate($input: TaskUpdateInput!) {
          taskUpdate(input: $input) {
            clientMutationId
            errors { message path }
            task { id taskId subject status timeSpent }
          }
        }
        """;

    public const string ProjectTaskUpdate = """
        mutation ProjectTaskUpdate($input: ProjectTaskUpdateInput!) {
          projectTaskUpdate(input: $input) {
            clientMutationId
            errors { message path }
            projectTask { id subject status timeSpent }
          }
        }
        """;

    public const string ProblemUpdate = """
        mutation ProblemUpdate($input: ProblemUpdateInput!) {
          problemUpdate(input: $input) {
            clientMutationId
            errors { message path }
            problem { id subject status timeSpent }
          }
        }
        """;

    /// <summary>targetType -> (mutation adı, mutation metni)</summary>
    public static (string Path, string Text) ParentUpdateFor(string targetType) => targetType switch
    {
        "request" => ("requestUpdate", RequestUpdate),
        "task" => ("taskUpdate", TaskUpdate),
        "project_task" => ("projectTaskUpdate", ProjectTaskUpdate),
        "problem" => ("problemUpdate", ProblemUpdate),
        _ => throw new ArgumentOutOfRangeException(nameof(targetType), targetType,
            "Yol B yalnızca request | task | project_task | problem hedefleri için geçerlidir."),
    };
}
