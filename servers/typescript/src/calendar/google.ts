/**
 * Google Calendar API v3 sağlayıcısı.
 *
 * ÜÇ KRİTİK TUZAK:
 *
 *  1) singleEvents VARSAYILANI FALSE'TUR.
 *     true yapmazsan tekrarlayan toplantılar AÇILMAZ; seri master'ı ham RRULE ile
 *     döner ve o günkü occurrence'ı hiç göremezsin. orderBy="startTime" de
 *     YALNIZCA singleEvents=true iken çalışır — ikisi birbirine bağımlıdır.
 *
 *  2) timeMin/timeMax OFFSET ZORUNLUDUR (RFC3339). Çıplak timestamp reddedilir
 *     veya sessizce UTC sanılır.
 *
 *  3) transparency alanı varsayılan "opaque" iken CEVAPTA HİÇ ÇIKMAZ.
 *     ev.transparency === "transparent" kontrolü yeterli görünür ama alanın
 *     yokluğunu ele almazsan undefined ile karşılaşırsın → (t ?? "opaque").
 *
 * KİMLİK: İki yol var. (a) OAuth refresh token — kişisel Gmail dahil herkeste
 * çalışır; token ~/.xurrent-mcp/google-token.json dosyasındadır ve ÜÇ DİL DE
 * aynı dosyayı okur. (b) Service account + domain-wide delegation — YALNIZCA
 * Google Workspace; @gmail.com hesaplarında ÇALIŞMAZ.
 */

import { existsSync, readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type { AppConfig } from "../config.js";
import type { CalendarProvider } from "../types.js";
import type { RawEvent, Window } from "./types.js";

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  status?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  transparency?: string;
  organizer?: { email?: string };
  attendees?: Array<{ email?: string; self?: boolean; responseStatus?: string }>;
  recurringEventId?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ uri?: string; entryPointType?: string }> };
}

/** OAuth refresh token → access token. Düz bir HTTP POST; kütüphane gerekmez. */
async function tokenFromRefresh(cfg: AppConfig, signal?: AbortSignal): Promise<string> {
  if (!existsSync(cfg.google.tokenPath)) {
    throw new Error(
      `Google token dosyası yok: ${cfg.google.tokenPath} — önce "node scripts/google-auth.mjs" çalıştırın.`,
    );
  }
  const stored = JSON.parse(readFileSync(cfg.google.tokenPath, "utf8")) as { refresh_token?: string };
  if (!stored.refresh_token) throw new Error("Google token dosyasında refresh_token yok.");

  const body = new URLSearchParams({
    client_id: cfg.google.clientId,
    client_secret: cfg.google.clientSecret,
    refresh_token: stored.refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Google token yenilenemedi: HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google token cevabında access_token yok.");
  return json.access_token;
}

/** Service account + domain-wide delegation: elle imzalanmış JWT bearer akışı. */
async function tokenFromServiceAccount(
  cfg: AppConfig,
  impersonate: string,
  signal?: AbortSignal,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: cfg.google.saClientEmail,
    scope: CALENDAR_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    // sub = impersonate edilecek kullanıcı. Domain-wide delegation'ın çalıştığı yer burası.
    sub: impersonate,
    iat: now,
    exp: now + 3600,
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64(header)}.${b64(claims)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  const signature = signer.sign(cfg.google.saPrivateKey).toString("base64url");

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${unsigned}.${signature}`,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  if (!res.ok) throw new Error(`Google SA token alınamadı: HTTP ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("Google SA token cevabında access_token yok.");
  return json.access_token;
}

export async function googleEvents(
  cfg: AppConfig,
  win: Window,
  userEmail: string | undefined,
  signal?: AbortSignal,
): Promise<RawEvent[]> {
  const impersonate = userEmail || cfg.google.impersonateUser;
  const token =
    cfg.google.saClientEmail && cfg.google.saPrivateKey && impersonate
      ? await tokenFromServiceAccount(cfg, impersonate, signal)
      : await tokenFromRefresh(cfg, signal);

  const calendarId = impersonate && cfg.google.calendarId === "primary" ? impersonate : cfg.google.calendarId;

  const params = new URLSearchParams({
    // TUZAK 2: offset ZORUNLU. toISOString() UTC "Z" verir; o da geçerli bir offset'tir.
    timeMin: win.start.toISOString(),
    timeMax: win.end.toISOString(),
    // TUZAK 1: varsayılan FALSE. Yazmazsan tekrarlayanlar açılmaz.
    singleEvents: "true",
    // orderBy YALNIZCA singleEvents=true iken geçerlidir.
    orderBy: "startTime",
    maxResults: "2500",
  });

  const source: CalendarProvider = "google";
  const out: RawEvent[] = [];
  let pageToken: string | null = null;

  do {
    const q = new URLSearchParams(params);
    if (pageToken) q.set("pageToken", pageToken);
    const res: Response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q.toString()}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    if (!res.ok) throw new Error(`Google Calendar hatası: HTTP ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const ev of json.items ?? []) out.push(mapGoogleEvent(ev, source));
    pageToken = json.nextPageToken ?? null;
  } while (pageToken);

  return out;
}

/** export: ağa çıkmadan birim testi edilebilsin diye — üç tuzağın hepsi buradadır. */
export function mapGoogleEvent(ev: GoogleEvent, source: CalendarProvider = "google"): RawEvent {
  const isAllDay = Boolean(ev.start.date);
  const start = isAllDay ? new Date(`${ev.start.date}T00:00:00Z`) : new Date(ev.start.dateTime!);
  const end = isAllDay ? new Date(`${ev.end.date}T00:00:00Z`) : new Date(ev.end.dateTime!);

  const self = (ev.attendees ?? []).find((a) => a.self);

  return {
    source,
    id: ev.id,
    // Google'da singleEvents=true iken seri boyunca AYNI iCalUID gelir —
    // bu yüzden dedup anahtarına start instant'ı eklenir.
    iCalUID: ev.iCalUID ?? ev.id,
    title: ev.summary ?? "(başlıksız)",
    start,
    end,
    isAllDay,
    isCancelled: (ev.status ?? "confirmed") === "cancelled",
    declined: (self?.responseStatus ?? "") === "declined",
    // TUZAK 3: transparency varsayılan "opaque" iken cevapta HİÇ ÇIKMAZ.
    free: (ev.transparency ?? "opaque") === "transparent",
    organizer: ev.organizer?.email ?? null,
    attendeeCount: ev.attendees?.length ?? 0,
    categories: [],
    seriesId: ev.recurringEventId ?? null,
    joinUrl:
      ev.hangoutLink ??
      ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
      null,
  };
}
