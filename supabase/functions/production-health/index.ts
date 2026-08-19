import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const COPY_LIST_ID = "901325158816";
const EDIT_LIST_ID = "901325169844";
const REVIEW_STATUS = "revisão de edição";
const cors = { "Access-Control-Allow-Origin": "https://chsousaa.github.io", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Content-Type": "application/json" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const norm = (value: unknown) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function addBusinessDays(iso: string, amount: number) {
  const d = new Date(`${iso}T12:00:00-03:00`);
  let left = amount;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
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
    if (error || !row?.data) throw new Error("Planejamento não encontrado no servidor.");
    const state = row.data;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const anchor = new Date(`${state.config.weekStart}T12:00:00-03:00`), target = new Date(`${today}T12:00:00-03:00`);
    const dayDiff = Math.round((target.getTime() - anchor.getTime()) / 86400000);
    const weekNum = Math.floor(dayDiff / 7) + 1;
    const week = state.weeks?.[weekNum] || state.weeks?.[String(weekNum)];
    if (!week) throw new Error("Semana atual não encontrada no planejamento.");

    const dayOffsets: Record<string, number> = { qui: 0, sex: 1, seg: 4, ter: 5, qua: 6 };
    const copyCodes = Object.fromEntries((state.config.copyTeam || []).map((p: any) => [p.name, p.sigla]));
    const editorCodes = Object.fromEntries((state.config.editTeam || []).map((p: any) => [p.name, p.sigla]));
    const start = new Date(anchor); start.setDate(start.getDate() + (weekNum - 1) * 7);
    const startISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(start);
    const expected: any[] = [];
    for (const [editor, days] of Object.entries(week.edit || {}) as [string, any][]) {
      for (const [day, value] of Object.entries(days || {})) {
        if (dayOffsets[day] == null || !value) continue;
        const cards = Array.isArray(value) ? value : [value];
        const assigned = new Date(`${startISO}T12:00:00-03:00`); assigned.setDate(assigned.getDate() + dayOffsets[day]);
        const assignedISO = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(assigned);
        cards.forEach((card: any, index: number) => {
          const sequence = cards.length > 1 ? (Number(card.slot) || index + 1) : 1;
          const dueDate = addBusinessDays(assignedISO, sequence >= 2 ? 2 : 1);
          expected.push({ editor, editorCode: editorCodes[editor] || "", copy: card.by, copyCode: copyCodes[card.by] || "", offer: card.offer, assignedDate: assignedISO, dueDate, deadline: `${dueDate}T09:30:00-03:00`, sequence, cardUid: card.uid || null });
        });
      }
    }

    const [copyData, editData] = await Promise.all([
      clickupGet(token, `/list/${COPY_LIST_ID}/task?archived=false&include_closed=true&subtasks=true&page=0`),
      clickupGet(token, `/list/${EDIT_LIST_ID}/task?archived=false&include_closed=true&subtasks=true&page=0`),
    ]);
    const taskMap = new Map<string, any>();
    for (const task of [...(copyData.tasks || []), ...(editData.tasks || [])]) taskMap.set(task.id, task);
    const patterns = new Set(expected.map((x) => `${x.copyCode}-${x.offer}`.toUpperCase()));
    const candidates = [...taskMap.values()].filter((t: any) => [...patterns].some((p) => String(t.name || "").toUpperCase().includes(p)));
    const histories = new Map<string, any>();
    await Promise.all(candidates.map(async (task: any) => {
      try { histories.set(task.id, await clickupGet(token, `/task/${task.id}/time_in_status`)); } catch (_) { histories.set(task.id, null); }
    }));

    const used = new Set<string>();
    const now = Date.now();
    const items = expected.sort((a, b) => a.deadline.localeCompare(b.deadline)).map((item) => {
      const scored = candidates.filter((t: any) => !used.has(t.id) && String(t.name || "").toUpperCase().includes(`${item.copyCode}-${item.offer}`.toUpperCase())).map((task: any) => {
        const history = histories.get(task.id);
        const name = String(task.name || "").toUpperCase();
        const assignees = (task.assignees || []).map((a: any) => norm(a.username)).join(" ");
        let score = 10;
        if (item.editorCode && new RegExp(`-${item.editorCode}(?:2)?(?:$|[^A-Z])`, "i").test(name)) score += 8;
        if (assignees.includes(norm(item.editor).split(" ")[0])) score += 6;
        const ready = (history?.status_history || []).find((h: any) => norm(h.status) === "pronto para edicao");
        if (ready?.total_time?.since) {
          const readyDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Fortaleza", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Number(ready.total_time.since)));
          const gap = Math.abs((new Date(`${readyDate}T12:00:00-03:00`).getTime() - new Date(`${item.assignedDate}T12:00:00-03:00`).getTime()) / 86400000);
          if (gap <= 1) score += 12; else if (gap <= 3) score += 4;
        }
        return { task, history, score };
      }).sort((a, b) => b.score - a.score);
      const matched = scored[0]?.score >= 10 ? scored[0] : null;
      if (matched) used.add(matched.task.id);
      const reviewEntries = (matched?.history?.status_history || []).filter((h: any) => norm(h.status) === norm(REVIEW_STATUS) && h.total_time?.since);
      if (norm(matched?.history?.current_status?.status) === norm(REVIEW_STATUS) && matched?.history?.current_status?.total_time?.since) reviewEntries.push({ total_time: matched.history.current_status.total_time });
      const reviewAtMs = reviewEntries.length ? Math.min(...reviewEntries.map((h: any) => Number(h.total_time.since))) : null;
      const deadlineMs = new Date(item.deadline).getTime();
      let health = "in_progress";
      if (reviewAtMs) health = reviewAtMs <= deadlineMs ? "delivered_on_time" : "delivered_late";
      else if (now > deadlineMs) health = "overdue";
      else if (item.dueDate === today) health = "due_today";
      else if (!matched) health = "not_found";
      return { ...item, health, currentStatus: matched?.task?.status?.status || null, deliveredAt: reviewAtMs ? new Date(reviewAtMs).toISOString() : null, taskId: matched?.task?.id || null, taskName: matched?.task?.name || null, delayMinutes: reviewAtMs ? Math.max(0, Math.round((reviewAtMs - deadlineMs) / 60000)) : Math.max(0, Math.round((now - deadlineMs) / 60000)) };
    });
    const summary = { total: items.length, deliveredOnTime: items.filter((x) => x.health === "delivered_on_time").length, deliveredLate: items.filter((x) => x.health === "delivered_late").length, dueToday: items.filter((x) => x.health === "due_today").length, overdue: items.filter((x) => x.health === "overdue").length, notFound: items.filter((x) => x.health === "not_found").length };
    return json({ today, checkedAt: new Date().toISOString(), summary, items });
  } catch (e) { return json({ error: e instanceof Error ? e.message : "Erro interno." }, 500); }
});
