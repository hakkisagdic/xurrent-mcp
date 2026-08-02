"""Xurrent GraphQL sorgu ve mutation metinleri.

Bu dosya dersin "gercek API neye benziyor" bolumudur. dry-run ciktisinda bu
metinler BIREBIR gosterilir; ogrenciye "ne olacagini" anlatmak yerine
GOSTERIYORUZ.

ENDPOINT: POST https://graphql.xurrent.com/ (TUM operasyonlar POST).
Header:   Authorization: Bearer <token>
          X-Xurrent-Account: <hesap slug'i — NUMERIK DEGIL>
          Content-Type: application/json
"""

from __future__ import annotations

# ---------------------------------------------------------------- Kimlik

ME_QUERY = """
query Whoami {
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
""".strip()


# TUZAK: PersonFilter.primaryEmail bir TextFilter'dir -> TAM eslesme yapar,
# substring DEGIL. Buyuk-kucuk harf ve format duyarlidir.
FIND_PERSON_QUERY = """
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
      organization { id name }
    }
  }
}
""".strip()


# ---------------------------------------------------------------- Acik isler
#
# TUZAK 1 — Filtre asimetrisi: RequestFilter'da atanan kisi alani 'member',
#           TaskFilter'da 'assignee'. Karistirmak SESSIZ bos sonuc uretir.
# TUZAK 2 — view varsayilani 'current_account'tur. 'all' gecilmezse kisinin
#           diger hesaplardaki isleri GORUNMEZ.
# TUZAK 3 — Acik/kapali ayrimi SADECE status ile yapilir; 'open' diye bir
#           view YOKTUR.
# TUZAK 4 — Request'te tamamlanma alani 'completedAt', Task'ta 'finishedAt'.
#           Task'ta completedAt YOKTUR.
# TUZAK 5 — personId variable'i String! olmali (ID! DEGIL), cunku
#           PersonReferenceFilter.values tipi [String]!.

OPEN_REQUESTS_QUERY = """
query OpenRequests($personId: String!, $first: Int!, $after: String, $view: RequestView) {
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
      nextTargetAt
      completedAt
      updatedAt
      team { name }
      member { id name }
    }
  }
}
""".strip()


# TaskStatus'ta BES terminal deger vardir: completed, approved, failed,
# rejected, canceled. Sadece 'completed'i elemek YETMEZ — 'approved' durumundaki
# bir kayit acik sanilir.
OPEN_TASKS_QUERY = """
query OpenTasks($personId: String!, $first: Int!, $after: String, $view: TaskView) {
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
      completionTargetAt
      finishedAt
      updatedAt
      team { name }
      member { id name }
      workflow { id subject }
    }
  }
}
""".strip()


# ---------------------------------------------------------------- Zaman baglami
#
# timeIncrement bilinmeden timeSpent SECILEMEZ. Izinli degerler:
# 5, 10, 15, 30, 60, 120, 240. Varsayilan 60'tir.
# EffortClassFilter'da 'disabled' filtresi YOKTUR -> client tarafinda elenir.

TIMESHEET_SETTINGS_QUERY = """
query TimesheetContext($first: Int!) {
  me {
    id
    organization {
      id
      timesheetSetting {
        id
        name
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
  effortClasses(first: $first) {
    nodes { id name position costMultiplier disabled }
  }
  timeAllocations(first: $first) {
    nodes { id name group descriptionRequired }
  }
}
""".strip()


# ---------------------------------------------------------------- Yazma — Yol A
#
# TimeEntryCreateInput'ta SADECE timeSpent zorunludur (Int!, DAKIKA).
# BU ALANLAR YOKTUR: assignmentId, requestId, taskId, projectTaskId, problemId,
# note(string), startTime, serviceInstanceId.
# => timeEntryCreate bir Request/Task'a BAGLANAMAZ. assignment degeri null olur.

TIME_ENTRY_CREATE_MUTATION = """
mutation CreateTimeEntry($input: TimeEntryCreateInput!) {
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
      timeAllocation { id name }
      effortClass { id name }
    }
  }
}
""".strip()


# TimeEntryUpdateInput = ayni alanlar + id: ID!, timeSpent nullable.
# Icinde assignment YOKTUR -> mevcut bir entry'nin date/startedAt/personId'sini
# guncellemek ticket bagini BOZMAZ. two_step stratejisi tam olarak buna dayanir.
TIME_ENTRY_UPDATE_MUTATION = """
mutation UpdateTimeEntry($input: TimeEntryUpdateInput!) {
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
""".strip()


# ---------------------------------------------------------------- Yazma — Yol B
#
# Ortak uclu: timeSpent (Int, DAKIKA, ARTIMLI — "eklenen sure", toplam DEGIL),
#             timeSpentEffortClassId (ID), timeEntryDescription (String)
#             ve ayrica note (String).
# Bu yolda date sunucu tarafindan "bugun", person authenticated user olarak
# atanir; KONTROL EDILEMEZ.

REQUEST_UPDATE_MUTATION = """
mutation LogTimeOnRequest($input: RequestUpdateInput!) {
  requestUpdate(input: $input) {
    clientMutationId
    errors { message path }
    request { id requestId subject status }
  }
}
""".strip()

TASK_UPDATE_MUTATION = """
mutation LogTimeOnTask($input: TaskUpdateInput!) {
  taskUpdate(input: $input) {
    clientMutationId
    errors { message path }
    task { id taskId subject status }
  }
}
""".strip()

PROJECT_TASK_UPDATE_MUTATION = """
mutation LogTimeOnProjectTask($input: ProjectTaskUpdateInput!) {
  projectTaskUpdate(input: $input) {
    clientMutationId
    errors { message path }
    projectTask { id subject status }
  }
}
""".strip()

PROBLEM_UPDATE_MUTATION = """
mutation LogTimeOnProblem($input: ProblemUpdateInput!) {
  problemUpdate(input: $input) {
    clientMutationId
    errors { message path }
    problem { id subject status }
  }
}
""".strip()


# two_step'in 2. adiminda guncellenecek entry'nin id'sini bulmak icin.
# NEDEN gerekli: requestUpdate payload'i Request'i doner, olusan TimeEntry'yi
# DEGIL. Bu yuzden en son olusan entry'yi ayrica sorgulamak gerekir.
LATEST_TIME_ENTRY_QUERY = """
query LatestTimeEntry($personId: String!, $date: ISO8601Date!) {
  timeEntries(
    first: 1
    order: { field: createdAt, direction: desc }
    filter: { person: { values: [$personId] }, date: { values: [$date] } }
  ) {
    nodes { id date startedAt timeSpent description }
  }
}
""".strip()


MUTATION_BY_PATH = {
    "timeEntryCreate": TIME_ENTRY_CREATE_MUTATION,
    "timeEntryUpdate": TIME_ENTRY_UPDATE_MUTATION,
    "requestUpdate": REQUEST_UPDATE_MUTATION,
    "taskUpdate": TASK_UPDATE_MUTATION,
    "projectTaskUpdate": PROJECT_TASK_UPDATE_MUTATION,
    "problemUpdate": PROBLEM_UPDATE_MUTATION,
}

# targetType -> (mutation path, GraphQL input tipi)
PARENT_UPDATE_BY_TARGET = {
    "request": "requestUpdate",
    "task": "taskUpdate",
    "project_task": "projectTaskUpdate",
    "problem": "problemUpdate",
}
