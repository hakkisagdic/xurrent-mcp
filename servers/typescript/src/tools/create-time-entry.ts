/**
 * xurrent_create_time_entry — İNCE SARMALAYICI.
 *
 * runCreateTimeEntry onayı ctx.confirm üzerinden SORAR (sihirbaz/chatbot yolu).
 * MCP adaptörleri bunun yerine core/toolimpl.ts → runToolCore kullanır ve onayı
 * PROTOKOLE çevirir (v1: elicitation, v2: InputRequiredResult).
 */
export {
  prepareTimeEntry,
  finishTimeEntry,
  runCreateTimeEntry,
  renderWriteResult,
  confirmRequestForEntry,
  type PreparedEntry,
} from "../core/toolimpl.js";
export const NAME = "xurrent_create_time_entry";
