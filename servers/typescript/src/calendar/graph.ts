/**
 * Microsoft Graph takvim sağlayıcısı.
 *
 * DÖRT KRİTİK TUZAK — hepsi bu dosyada yorumlu:
 *
 *  1) /me/events DEĞİL, /me/calendarView KULLANILIR.
 *     events tekrarlayan toplantıların SERİ MASTER'ını döner; o günkü occurrence'ı
 *     hiç göremezsin. calendarView occurrence'ları AÇILMIŞ (expanded) halde verir.
 *
 *  2) startDateTime/endDateTime OFFSETLİ gönderilir ("2026-08-02T00:00:00+03:00").
 *     Çıplak timestamp sessizce yanlış günü getirir.
 *
 *  3) Prefer: outlook.timezone başlığı GÖNDERİLMEZ.
 *     Göndermezsek Graph her şeyi UTC döner; tek bir referans dilim olur.
 *
 *  4) Cevaptaki dateTime alanı OFFSET TAŞIMAZ ve 7 kesirli hane içerir.
 *     new Date(...) ile doğrudan parse etmek SUNUCUNUN yerel saatini varsayar → bug.
 *     Bkz. util/time.ts → parseGraphDateTime.
 *
 * İZİN NOTU: Doğru izin Calendars.Read'dir. Calendars.Read.All etkinlik okumak için
 * DEĞİLDİR — "tüm kullanıcıların çalışma saatleri ve lokasyonları"nı okur.
 * Client credentials akışında scope HER ZAMAN https://graph.microsoft.com/.default'tur.
 */

import type { AppConfig } from "../config.js";
import type { CalendarProvider } from "../types.js";
import { parseGraphDateTime, toOffsetISO } from "../util/time.js";
import type { RawEvent, Window } from "./types.js";

interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string | null;
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string | null;
  start: GraphDateTimeTimeZone;
  end: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string | null;
  responseStatus?: { response?: string | null } | null;
  organizer?: { emailAddress?: { address?: string | null } | null } | null;
  attendees?: unknown[] | null;
  categories?: string[] | null;
  seriesMasterId?: string | null;
  onlineMeeting?: { joinUrl?: string | null } | null;
}

async function acquireToken(cfg: AppConfig, signal?: AbortSignal): Promise<string> {
  const { tenantId, clientId, clientSecret } = cfg.ms;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("Microsoft Graph için MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET gerekli.");
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    // Client credentials akışında scope HER ZAMAN ".default"tur —
    // tek tek izin adı yazmak bu akışta çalışmaz.
    scope: "https://graph.microsoft.com/.default",
  });
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Graph token alınamadı: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Graph token cevabında access_token yok.");
  return json.access_token;
}

export async function graphEvents(
  cfg: AppConfig,
  win: Window,
  userEmail: string | undefined,
  signal?: AbortSignal,
): Promise<RawEvent[]> {
  const token = await acquireToken(cfg, signal);
  const user = userEmail || cfg.ms.impersonateUser;
  const base = user
    ? `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(user)}`
    : "https://graph.microsoft.com/v1.0/me";

  // TUZAK 2: offset GÖMÜLÜ gönderiyoruz.
  const startStr = toOffsetISO(win.start, cfg.timeZone);
  const endStr = toOffsetISO(win.end, cfg.timeZone);

  const params = new URLSearchParams({
    startDateTime: startStr,
    endDateTime: endStr,
    $top: "200",
    $orderby: "start/dateTime",
    $select:
      "id,iCalUId,subject,start,end,isAllDay,isCancelled,showAs,responseStatus,organizer,attendees,categories,seriesMasterId,onlineMeeting",
  });

  // TUZAK 1: calendarView — events DEĞİL.
  const url = `${base}/calendarView?${params.toString()}`;

  const source: CalendarProvider = "graph";
  const out: RawEvent[] = [];
  let next: string | null = url;

  while (next) {
    const res: Response = await fetch(next, {
      // TUZAK 3: Prefer: outlook.timezone GÖNDERMİYORUZ → cevap UTC gelir.
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    if (!res.ok) {
      throw new Error(`Graph calendarView hatası: HTTP ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { value?: GraphEvent[]; "@odata.nextLink"?: string };
    for (const ev of json.value ?? []) {
      out.push(mapGraphEvent(ev, source));
    }
    next = json["@odata.nextLink"] ?? null;
  }

  return out;
}

/** export: ağa çıkmadan birim testi edilebilsin diye — TUZAK 4 tam olarak burada yaşar. */
export function mapGraphEvent(ev: GraphEvent, source: CalendarProvider = "graph"): RawEvent {
  // TUZAK 4: parseGraphDateTime — 7 kesirli hane + offset yok.
  const start = parseGraphDateTime(ev.start.dateTime, ev.start.timeZone);
  const end = parseGraphDateTime(ev.end.dateTime, ev.end.timeZone);

  const response = (ev.responseStatus?.response ?? "").toLowerCase();
  return {
    source,
    id: ev.id,
    // Graph'te her occurrence FARKLI bir iCalUId taşır — dedup anahtarına
    // start instant'ı eklememizin sebeplerinden biri budur.
    iCalUID: ev.iCalUId ?? ev.id,
    title: ev.subject ?? "(başlıksız)",
    start,
    end,
    isAllDay: ev.isAllDay ?? false,
    isCancelled: ev.isCancelled ?? false,
    declined: response === "declined",
    // Graph'te "meşgul değil" göstergesi showAs alanıdır.
    free: (ev.showAs ?? "busy").toLowerCase() === "free",
    organizer: ev.organizer?.emailAddress?.address ?? null,
    attendeeCount: Array.isArray(ev.attendees) ? ev.attendees.length : 0,
    categories: ev.categories ?? [],
    seriesId: ev.seriesMasterId ?? null,
    joinUrl: ev.onlineMeeting?.joinUrl ?? null,
  };
}
