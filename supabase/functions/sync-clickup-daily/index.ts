import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const DRIVE_FOLDERS: Record<string, Record<string, string>> = {
  PACU: { CA: "1GKNIiUNm-AMr2C7WwDx6iq64tA_ZaNcd", CL: "1eFLY1mUt80TbzuCncqBdETzpcHoohYjx", RA: "1Ovsq9e2v59qvNxBVvYL9V1tyKek3Bth3" },
  OTIT: { CA: "18Ox6AlaXHg-TsqQxH4PAgBQAidT_AiA7", CL: "1t7T5vWPguWz-OJpF_AI-1hEt2Mo0HehT", RA: "13NfYDhg5AWYZxw66Hogxh8bSTdrtOF59" },
  OTIG: { CA: "1Yb6I4hi7jCnZBCjkfK3sUGq9IrY5gC--", CL: "1ZcdXPjubjKwu-eqnQJZAXsw4juKBU0Hr", RA: "1JeOgZx1uNzBofR22R8KtrJuvewURHFan" },
};

const cors = { "Access-Control-Allow-Origin": "https://chsousaa.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

async function nextRange(apiKey: string, offer: string, copyCode: string, reservedMax = 0) {
  const folder = DRIVE_FOLDERS[offer]?.[copyCode];
  if (!folder) throw new Error(`Pasta não configurada: ${copyCode}-${offer}`);
  const q = encodeURIComponent(`'${folder}' in parents and trashed = false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(name)&pageSize=1000`, { headers: { "x-goog-api-key": apiKey } });
  const data = await res.json();
  if (!res.ok) throw new Error(`Não foi possível ler ${copyCode}-${offer} no Drive.`);
  let max = 0;
  for (const f of data.files || []) {
    const name = String(f.name || "").toUpperCase();
    if (!name.includes(`${copyCode}-${offer}`)) continue; // OTIG ignora arquivos OTIT antigos
    const nums = [...name.matchAll(/\d+/g)].map((m) => Number(m[0]));
    if (nums.length) max = Math.max(max, ...nums);
  }
  max = Math.max(max, reservedMax);
  return { start: max + 1, end: max + 5 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const origin = req.headers.get("Origin");
    if (origin && origin !== "https://chsousaa.github.io") return json({ error: "Origem não permitida." }, 403);
    const auth = req.headers.get("Authorization") || "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: { user } } = await supabase.auth.getUser(auth.replace("Bearer ", ""));
    if (!user) return json({ error: "Sessão inválida." }, 401);
    if (user.id !== Deno.env.get("INTEGRATION_ALLOWED_USER_ID")) return json({ error: "Sua conta não tem permissão para usar esta integração." }, 403);
    const { action, date } = await req.json();
    if (!["preview", "create"].includes(action) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Pedido inválido." }, 400);
    const serverToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    if (date !== serverToday) return json({ error: "A sincronização só pode criar as tarefas do dia atual." }, 400);
    // A demanda é derivada do estado salvo no servidor. O navegador não decide
    // responsável, oferta ou numeração.
    const { data: stateRow, error: stateError } = await supabase.from("app_state").select("data").eq("user_id", user.id).single();
    if (stateError || !stateRow?.data) throw new Error("Planejamento não encontrado no servidor.");
    const state = stateRow.data;
    const anchor = new Date(`${state.config.weekStart}T12:00:00Z`), target = new Date(`${date}T12:00:00Z`);
    const dayDiff = Math.round((target.getTime() - anchor.getTime()) / 86400000);
    const weekNum = Math.floor(dayDiff / 7) + 1, off = ((dayDiff % 7) + 7) % 7;
    const col = ({ 0: "qui", 1: "sex", 4: "seg", 5: "ter", 6: "qua" } as Record<number,string>)[off];
    const week = state.weeks?.[weekNum] || state.weeks?.[String(weekNum)];
    if (!col || !week) throw new Error("Não há planejamento de copy para hoje.");
    const allowedCopies = new Set(["CA", "CL", "RA"]), allowedOffers = new Set(["PACU", "OTIT", "OTIG"]);
    const demands = (state.config.copyTeam || []).filter((p: any) => p.active).flatMap((p: any) => {
      const card = week.copy?.[p.name]?.[col];
      return card ? [{ copy: p.name, copyCode: p.sigla, offer: card.offer, date }] : [];
    });
    if (!demands.length || demands.some((d: any) => !allowedCopies.has(d.copyCode) || !allowedOffers.has(d.offer))) return json({ error: "Demanda do servidor não permitida." }, 400);
    const driveApiKey = Deno.env.get("GOOGLE_DRIVE_API_KEY");
    if (!driveApiKey) throw new Error("Google Drive ainda não configurado.");
    const { data: existing, error: existingError } = await supabase.from("integration_sync_log").select("copy_code,clickup_task_id,status,task_name").eq("user_id", user.id).eq("sync_date", date);
    const { data: reservations, error: reservationError } = await supabase.from("integration_sync_log").select("copy_code,offer_code,range_end,status").eq("user_id", user.id).in("status", ["pending", "created"]);
    if (existingError || reservationError) throw new Error("Falha ao conferir sincronizações anteriores.");
    const items = [];
    for (const d of demands) {
      const prev = existing?.find((x) => x.copy_code === d.copyCode && x.status === "created");
      const reservedMax = Math.max(0, ...(reservations || []).filter((x) => x.copy_code === d.copyCode && x.offer_code === d.offer).map((x) => Number(x.range_end) || 0));
      const range = await nextRange(driveApiKey, d.offer, d.copyCode, reservedMax);
      items.push({ ...d, name: `AD_${d.copyCode}-${d.offer}-${range.start}-${range.end}`, ...range, exists: !!prev, clickupTaskId: prev?.clickup_task_id || null });
    }
    if (action === "preview") return json({ items });
    const token = Deno.env.get("CLICKUP_API_TOKEN"), listId = Deno.env.get("CLICKUP_COPY_LIST_ID");
    const assignees = JSON.parse(Deno.env.get("CLICKUP_ASSIGNEE_IDS") || "{}");
    if (!token || !listId) throw new Error("ClickUp ainda não configurado.");
    let created = 0, skipped = 0;
    for (const item of items) {
      if (item.exists) { skipped++; continue; }
      const { error: reserveError } = await supabase.from("integration_sync_log").upsert({ user_id: user.id, sync_date: date, copy_code: item.copyCode, offer_code: item.offer, task_name: item.name, range_start: item.start, range_end: item.end, status: "pending", error_message: null, updated_at: new Date().toISOString() }, { onConflict: "user_id,sync_date,copy_code" });
      if (reserveError) { skipped++; continue; }
      const check = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task?include_closed=true&subtasks=true`, { headers: { Authorization: token } });
      if (!check.ok) throw new Error("Falha ao conferir duplicidades no ClickUp.");
      const found = (await check.json()).tasks?.find((task: any) => task.name === item.name);
      if (found) {
        await supabase.from("integration_sync_log").update({ status: "created", clickup_task_id: found.id, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("sync_date", date).eq("copy_code", item.copyCode);
        skipped++; continue;
      }
      const payload: Record<string, unknown> = { name: item.name, due_date: new Date(`${date}T12:00:00-03:00`).getTime(), due_date_time: true, markdown_content: `Demanda diária de copy\n\nOferta: ${item.offer}\nCopy: ${item.copy}\nNumeração conferida no Google Drive: ${item.start}-${item.end}` };
      if (assignees[item.copyCode]) payload.assignees = [Number(assignees[item.copyCode])];
      const res = await fetch(`https://api.clickup.com/api/v2/list/${listId}/task`, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const result = await res.json();
      if (!res.ok) {
        await supabase.from("integration_sync_log").update({ status: "failed", error_message: result.err || "Falha ClickUp", updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("sync_date", date).eq("copy_code", item.copyCode);
        throw new Error(`Falha ao criar ${item.name} no ClickUp.`);
      }
      await supabase.from("integration_sync_log").update({ status: "created", clickup_task_id: result.id, updated_at: new Date().toISOString() }).eq("user_id", user.id).eq("sync_date", date).eq("copy_code", item.copyCode);
      created++;
    }
    return json({ created, skipped, items });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Erro interno." }, 500); }
});
