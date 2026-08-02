/**
 * Tool sonucu yardımcıları.
 *
 * KURAL: Her tool HEM structuredContent (makine için) HEM okunabilir bir
 * TÜRKÇE text bloğu yayınlar. Sebep: MCP client'ların bir kısmı structured
 * çıktıyı hiç göstermez, LLM'ler ise metni daha güvenilir yorumlar. İkisini
 * birden vermek "aynı gerçeğin iki sunumu"dur — ekstra iş değil, sözleşmenin parçası.
 */

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  // MCP SDK'nın CallToolResult tipi açık uçludur (_meta vb. için index imzası taşır).
  // Bu satır olmadan kendi ToolResult'ımız handler dönüş tipine ATANAMAZ.
  [key: string]: unknown;
}

export function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * İş kuralı hatası: isError=true + okunabilir Türkçe metin.
 * structuredContent yine döner — istemci ayrıntıyı görebilsin diye.
 */
export function failure(text: string, structured?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
    isError: true,
  };
}

/** Dakikayı insan diline çevirir: 135 → "2 sa 15 dk". */
export function humanMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${sign}${m} dk`;
  if (m === 0) return `${sign}${h} sa`;
  return `${sign}${h} sa ${m} dk`;
}

export function bullet(lines: string[], marker = "  • "): string {
  return lines.map((l) => marker + l).join("\n");
}
