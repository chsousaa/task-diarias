import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COPY_LIST_ID = "901325158816";
const EDIT_LIST_ID = "901325169844";
const cors = { "Access-Control-Allow-Origin": "https://chsousaa.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const norm = (value: unknown) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
const localISO = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

function mondayOf(iso: string) {
  const d = new Date(`${iso}T12:00:00-03:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localISO(d);
}
function addBusinessDays(iso: string, amount: number) {
  const d = new Date(`${iso}T12:00:00-03:00`);
  let left = amount;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return localISO(d);
}
async function clickupGet(token: string, path: string) {
  const res = await fetch(`https://api.clickup.com/api/v2${path}`, { headers: { Authorization: token } });
  if (!res.ok) throw new Error("Não foi possível consultar o andamento no ClickUp.");
  return await res.json();
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
    if (user.id !== Deno.env.get("INTEGRATION_ALLOWED_USER_ID")) return json({ error: "Sua conta não tem permissão para consultar este painel." }, 403);
    const token = Deno.env.get("CLICKUP_API_TOKEN");
    if (!token) throw new Error("ClickUp ainda não configurado.");

    const { data: row, error } = await supabase.from("app_state").select("data").eq("user_id", user.id).single();
    if (error || !row?.data) throw new Error("Configuração da equipe não encontrada.");
    const state = row.data;
    const copies = (state.config.copyTeam || []).filter((p: any) => p.active);
    const editors = (state.config.editTeam || []).filter((p: any) => p.active);
    const offers = new Set((state.config.offers || []).filter((o: any) => o.active).map((o: any) => String(o.code).toUpperCase()));
    const copyByCode = Object.fromEntries(copies.map((p: any) => [String(p.sigla).toUpperCase(), p.name]));
    const editorByCode = Object.fromEntries(editors.map((p: any) => [String(p.sigla).toUpperCase(), p.name]));
    const today = localISO(new Date()), fromDate = mondayOf(today), now = Date.now();

    const [copyData, editData] = await Promise.all([
      clickupGet(token, `/list/${COPY_LIST_ID}/task?archived=false&include_closed=true&subtasks=true&page=0`),
      clickupGet(token, `/list/${EDIT_LIST_ID}/task?archived=false&include_closed=true&subtasks=true&page=0`),
    ]);
    const taskMap = new Map<string, any>();
    for (const task of [...(copyData.tasks || []), ...(editData.tasks || [])]) taskMap.set(task.id, task);
    const histories = new Map<string, any>();
    await Promise.all([...taskMap.values()].map(async (task: any) => {
      try { histories.set(task.id, await clickupGet(token, `/task/${task.id}/time_in_status`)); } catch (_) { histories.set(task.id, null); }
    }));

    const items: any[] = [];
    for (const task of taskMap.values()) {
      const name = String(task.name || "").toUpperCase();
      const demand = name.match(/(?:AD_)?(CA|CL|RA)-([A-Z0-9]+)/);
      if (!demand || !copyByCode[demand[1]] || !offers.has(demand[2])) continue;
      const history = histories.get(task.id);
      const readyEntries = (history?.status_history || []).filter((h: any) => norm(h.status) === "pronto para edicao" && h.total_time?.since);
      if (!readyEntries.length) continue;
      const assignedMs = Math.min(...readyEntries.map((h: any) => Number(h.total_time.since)));
      const assignedDate = localISO(new Date(assignedMs));
      if (assignedDate < fromDate) continue;

      const editorTag = name.match(/-(WA|MA|LD)(2)?(?:$|[^A-Z0-9])/);
      let editorCode = editorTag?.[1] || "", editor = editorByCode[editorCode] || null;
      if (!editor) {
        const assignees = (task.assignees || []).map((a: any) => norm(a.username));
        for (const candidate of editors) {
          const first = norm(candidate.name).split(" ")[0];
          if (assignees.some((a: string) => a.includes(first))) { editor = candidate.name; editorCode = candidate.sigla; break; }
        }
      }
      const sequence = editorTag?.[2] === "2" ? 2 : 1;
      const dueDate = editor ? addBusinessDays(assignedDate, sequence === 2 ? 2 : 1) : null;
      const deadline = dueDate ? `${dueDate}T09:30:00-03:00` : null;
      const deadlineMs = deadline ? new Date(deadline).getTime() : null;
      const reviewEntries = (history?.status_history || []).filter((h: any) => norm(h.status) === "revisao de edicao" && h.total_time?.since);
      if (norm(history?.current_status?.status) === "revisao de edicao" && history?.current_status?.total_time?.since) reviewEntries.push({ total_time: history.current_status.total_time });
      const deliveredMs = reviewEntries.length ? Math.min(...reviewEntries.map((h: any) => Number(h.total_time.since))) : null;
      let health = "in_progress";
      if (!editor) health = "unassigned";
      else if (deliveredMs) health = deliveredMs <= deadlineMs! ? "delivered_on_time" : "delivered_late";
      else if (now > deadlineMs!) health = "overdue";
      else if (dueDate === today) health = "due_today";
      items.push({ taskId: task.id, taskName: task.name, copy: copyByCode[demand[1]], copyCode: demand[1], offer: demand[2], editor, editorCode, assignedDate, assignedAt: new Date(assignedMs).toISOString(), dueDate, deadline, sequence, health, currentStatus: task.status?.status || history?.current_status?.status || null, deliveredAt: deliveredMs ? new Date(deliveredMs).toISOString() : null, delayMinutes: deadlineMs ? (deliveredMs ? Math.max(0, Math.round((deliveredMs - deadlineMs) / 60000)) : Math.max(0, Math.round((now - deadlineMs) / 60000))) : 0 });
    }
    items.sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999") || a.assignedAt.localeCompare(b.assignedAt));
    const summary = { total: items.length, deliveredOnTime: items.filter((x) => x.health === "delivered_on_time").length, deliveredLate: items.filter((x) => x.health === "delivered_late").length, dueToday: items.filter((x) => x.health === "due_today").length, overdue: items.filter((x) => x.health === "overdue").length, inProgress: items.filter((x) => x.health === "in_progress").length, unassigned: items.filter((x) => x.health === "unassigned").length };
    return json({ today, fromDate, checkedAt: new Date().toISOString(), summary, items });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Erro interno." }, 500); }
});
