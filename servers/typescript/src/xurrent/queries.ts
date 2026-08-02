/**
 * Xurrent GraphQL sorgu ve mutation metinleri.
 *
 * Bu metinler dry-run çıktısında BİREBİR gösterilir. Öğrenciye "şu olacak" demek
 * yerine "şu gönderilecek" diye GERÇEK metni göstermek dersin temel yöntemidir.
 *
 * Endpoint: POST https://graphql.xurrent.com/ — TÜM operasyonlar POST'tur.
 * Header: Authorization: Bearer <token> + X-Xurrent-Account: <slug>
 */

// ─────────────────────────────────────────────────────────────────────────────
// Okuma
// ─────────────────────────────────────────────────────────────────────────────

export const ME_QUERY = /* GraphQL */ `
  query Whoami {
    me {
      id
      name
      primaryEmail
      jobTitle
      timeZone
      disabled
      organization {
        id
        name
      }
    }
    account {
      id
      name
      directory
    }
  }
`;

export const FIND_PERSON_QUERY = /* GraphQL */ `
  query FindPerson($email: String!, $view: PersonView) {
    people(first: 25, view: $view, filter: { primaryEmail: { values: [$email] } }) {
      totalCount
      nodes {
        id
        name
        primaryEmail
        jobTitle
        timeZone
        disabled
        organization {
          id
          name
        }
      }
    }
  }
`;

/**
 * TUZAK — FİLTRE ASİMETRİSİ:
 *   RequestFilter'da atanan kişi alanı "member"dır.
 *   TaskFilter'da    atanan kişi alanı "assignee"dir; "member" YOKTUR.
 * Karıştırmak şema hatası verir ya da (çoğu client'ta yakalanmazsa) boş liste
 * döndürür — yani SESSİZ hata. En kötü hata türü.
 *
 * TUZAK — personId değişkeni String! olarak deklare edilir, ID! DEĞİL.
 * Çünkü PersonReferenceFilter { negate, values: [String]! } şeklindedir.
 * values "$me" özel değerini de kabul eder.
 *
 * TUZAK — view varsayılanı "current_account"tur. "all" geçmezsen kişinin
 * diğer hesaplardaki işleri GÖRÜNMEZ.
 *
 * TUZAK — "open" diye bir view YOKTUR; açık/kapalı ayrımı yalnızca status ile yapılır.
 */
export const OPEN_REQUESTS_QUERY = /* GraphQL */ `
  query OpenRequests($personId: String!, $first: Int!, $after: String, $view: RequestView) {
    requests(
      first: $first
      after: $after
      view: $view
      order: { field: updatedAt, direction: desc }
      filter: { member: { values: [$personId] } }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        requestId
        subject
        status
        completedAt
        nextTargetAt
        updatedAt
        team {
          id
          name
        }
        member {
          id
          name
        }
      }
    }
  }
`;

export const OPEN_TASKS_QUERY = /* GraphQL */ `
  query OpenTasks($personId: String!, $first: Int!, $after: String, $view: TaskView) {
    tasks(
      first: $first
      after: $after
      view: $view
      order: { field: updatedAt, direction: desc }
      filter: { assignee: { values: [$personId] } }
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        taskId
        subject
        status
        finishedAt
        completionTargetAt
        updatedAt
        team {
          id
          name
        }
        member {
          id
          name
        }
        workflow {
          id
          subject
        }
      }
    }
  }
`;

/**
 * Timesheet ayarları + effort class'lar.
 *
 * TUZAK: EffortClassFilter'da "disabled" filtresi YOKTUR. Disabled kayıtlar
 * SUNUCU TARAFINDA elenemez; client tarafında elemek zorunludur.
 */
export const TIME_TRACKING_CONTEXT_QUERY = /* GraphQL */ `
  query TimeTrackingContext($first: Int!) {
    me {
      id
      organization {
        id
        name
        timesheetSetting {
          id
          name
          unit
          workday
          workweek
          timeIncrement
          percentageIncrement
          allowWorkdayOvertime
          allowWorkweekOvertime
          allocationTimeTracking
          assignmentTimeTracking
          requireNote
          requireTimeEntryDescription
          requestEffortClass {
            id
            name
          }
          taskEffortClass {
            id
            name
          }
          projectTaskEffortClass {
            id
            name
          }
          problemEffortClass {
            id
            name
          }
          timeAllocationEffortClass {
            id
            name
          }
        }
      }
    }
    effortClasses(first: $first) {
      nodes {
        id
        name
        position
        costMultiplier
        disabled
      }
    }
    timeAllocations(first: $first, filter: { disabled: false }) {
      nodes {
        id
        name
        group {
          id
          name
        }
        descriptionRequired
      }
    }
  }
`;

/**
 * two_step'in 2. adımı için gereken ARA SORGU.
 *
 * NEDEN GEREKLİ: RequestUpdatePayload / TaskUpdatePayload oluşan TimeEntry'nin
 * id'sini DÖNDÜRMEZ. Yani "yaz, sonra düzelt" akışında 1. adımın çıktısından
 * 2. adımın girdisini doğrudan alamayız — aradaki id'yi SORGULAMAK zorundayız.
 * Bu, two_step'in atomik olmamasının yanında ikinci bir maliyeti: ekstra istek
 * ve teorik bir yarış koşulu (aynı anda başka bir istemci de yazarsa).
 */
export const LATEST_TIME_ENTRY_QUERY = /* GraphQL */ `
  query LatestTimeEntry($personId: String!, $dateFrom: ISO8601Date!) {
    timeEntries(
      first: 5
      order: { field: createdAt, direction: desc }
      filter: { person: { values: [$personId] }, date: { greaterThanOrEqualTo: $dateFrom } }
    ) {
      nodes {
        id
        date
        timeSpent
        startedAt
        description
        assignment {
          ... on Request {
            id
            requestId
          }
          ... on Task {
            id
            taskId
          }
        }
      }
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Yazma — YOL A: timeEntryCreate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YOL A — timeEntryCreate.
 *
 * TimeEntryCreateInput alanları (doğrulanmış):
 *   timeSpent(Int!, DAKİKA, şema seviyesinde TEK zorunlu alan), date(ISO8601Date),
 *   personId, customerId, serviceId, description(max 80), timeAllocationId,
 *   effortClassId, startedAt(ISO8601Timestamp), correction(Boolean),
 *   organizationId, teamId, noteId, deleted, source, sourceID, clientMutationId
 *
 * BU ALANLAR YOKTUR: assignmentId, requestId, taskId, projectTaskId, problemId,
 * note(string), startTime, serviceInstanceId.
 * => timeEntryCreate bir Request/Task'a BAĞLANAMAZ. Oluşan kaydın assignment'ı null'dır.
 *
 * Validation hataları HTTP 200 + errors dolu + timeEntry null olarak döner;
 * top-level GraphQL "errors" alanı DEĞİL. İstemci ikisini de kontrol etmelidir.
 */
export const TIME_ENTRY_CREATE_MUTATION = /* GraphQL */ `
  mutation CreateTimeEntry($input: TimeEntryCreateInput!) {
    timeEntryCreate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      timeEntry {
        id
        date
        timeSpent
        startedAt
        description
        correction
        person {
          id
          name
        }
        timeAllocation {
          id
          name
        }
        effortClass {
          id
          name
        }
      }
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Yazma — YOL B: parent update mutation'ları
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YOL B — bir Request/Task/ProjectTask/Problem'e zaman yazmanın TEK yolu.
 *
 * Ortak üçlü (dördünde de aynı):
 *   timeSpent(Int, DAKİKA, ARTIMLI — "eklenen süre", TOPLAM DEĞİL)
 *   timeSpentEffortClassId(ID)
 *   timeEntryDescription(String)
 * ayrıca note(String).
 *
 * Bu yolda date SUNUCU tarafından "bugün", person authenticated user olarak
 * atanır ve KONTROL EDİLEMEZ. İster #2'deki "T-1" bu yüzden tek adımda karşılanamaz.
 *
 * ARTIMLI olması entegrasyonlarda çift sayma hatalarının bir numaralı sebebidir:
 * 60 göndermek "toplamı 60 yap" değil "üzerine 60 ekle" demektir.
 */
export const REQUEST_UPDATE_MUTATION = /* GraphQL */ `
  mutation AddTimeToRequest($input: RequestUpdateInput!) {
    requestUpdate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      request {
        id
        requestId
        subject
        status
      }
    }
  }
`;

export const TASK_UPDATE_MUTATION = /* GraphQL */ `
  mutation AddTimeToTask($input: TaskUpdateInput!) {
    taskUpdate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      task {
        id
        taskId
        subject
        status
      }
    }
  }
`;

export const PROJECT_TASK_UPDATE_MUTATION = /* GraphQL */ `
  mutation AddTimeToProjectTask($input: ProjectTaskUpdateInput!) {
    projectTaskUpdate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      projectTask {
        id
        subject
        status
      }
    }
  }
`;

export const PROBLEM_UPDATE_MUTATION = /* GraphQL */ `
  mutation AddTimeToProblem($input: ProblemUpdateInput!) {
    problemUpdate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      problem {
        id
        subject
        status
      }
    }
  }
`;

/**
 * two_step'in 2. adımı — telafi.
 *
 * TimeEntryUpdateInput = TimeEntryCreateInput alanları + id: ID! (timeSpent nullable).
 * İÇİNDE assignment ALANI YOKTUR.
 *
 * İşte kısıtı avantaja çeviren nokta: bir alan input şemasında YOKSA o alan
 * güncellenemez, dolayısıyla mevcut değeri KORUNUR. Yani date/startedAt/personId'yi
 * düzeltmek ticket bağını BOZAMAZ. two_step stratejisi tam olarak buna dayanır.
 */
export const TIME_ENTRY_UPDATE_MUTATION = /* GraphQL */ `
  mutation FixTimeEntry($input: TimeEntryUpdateInput!) {
    timeEntryUpdate(input: $input) {
      clientMutationId
      errors {
        message
        path
      }
      timeEntry {
        id
        date
        timeSpent
        startedAt
        description
        person {
          id
          name
        }
      }
    }
  }
`;

/** targetType → (mutation adı, GraphQL metni, input tipi) eşlemesi. */
export const PARENT_UPDATE_BY_TARGET = {
  request: { path: "requestUpdate", mutation: REQUEST_UPDATE_MUTATION, inputType: "RequestUpdateInput" },
  task: { path: "taskUpdate", mutation: TASK_UPDATE_MUTATION, inputType: "TaskUpdateInput" },
  project_task: {
    path: "projectTaskUpdate",
    mutation: PROJECT_TASK_UPDATE_MUTATION,
    inputType: "ProjectTaskUpdateInput",
  },
  problem: { path: "problemUpdate", mutation: PROBLEM_UPDATE_MUTATION, inputType: "ProblemUpdateInput" },
} as const;
