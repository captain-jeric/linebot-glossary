const { supabase } = require("./db");

const GLOSSARY_LANGS = ["zh", "zh-TW", "en", "th", "my", "ja"];
const TERM_STATUSES = new Set(["draft", "active", "deprecated"]);
const RISK_LEVELS = new Set(["low", "medium", "high"]);
const TERM_SOURCES = new Set(["manual", "ai", "import", "suggestion"]);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function parseList(value) {
  return String(value || "")
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function parseDateInput(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T23:59:59+07:00`;
  return text;
}

function buildAdminUrl(path, token, message = "") {
  const params = new URLSearchParams();
  if (token) params.set("token", token);
  if (message) params.set("message", message);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function renderAdminShell({ title, token, message, adminEmail, content }) {
  const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: Arial, "PingFang SC", sans-serif; background: #f4f6fa; color: #172033; }
    header { background: #0f172a; color: #fff; padding: 18px 24px; }
    main { max-width: 1180px; margin: 0 auto; padding: 22px; }
    h1 { margin: 0; font-size: 22px; }
    h2 { font-size: 18px; margin: 22px 0 12px; }
    h3 { margin: 16px 0 10px; font-size: 15px; }
    a { color: #175cd3; }
    nav { display: flex; gap: 18px; margin-top: 12px; flex-wrap: wrap; }
    nav a { color: #fff; text-decoration: none; font-size: 17px; font-weight: 700; }
    nav a:hover { text-decoration: underline; }
    form { margin: 0; }
    label { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: 13px; color: #4b5870; }
    input, select, textarea { box-sizing: border-box; width: 100%; padding: 8px 10px; border: 1px solid #b7c2d1; border-radius: 6px; font-size: 14px; line-height: 20px; background: #fff; }
    input, select { height: 38px; }
    textarea { min-height: 76px; resize: vertical; }
    button, .button { display: inline-flex; align-items: center; justify-content: center; min-width: 88px; height: 38px; padding: 0 13px; border: 0; border-radius: 6px; background: #1f6feb; color: #fff; font-size: 14px; font-weight: 700; cursor: pointer; text-decoration: none; white-space: nowrap; }
    button.secondary, .button.secondary { background: #536078; }
    button.danger { background: #b42318; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    .meta { color: #536078; font-size: 13px; margin: 8px 0 0; }
    .message { background: #ecfdf3; border: 1px solid #abefc6; color: #067647; padding: 10px 12px; border-radius: 6px; margin-bottom: 14px; }
    .panel, details { background: #fff; border: 1px solid #d9e0ea; border-radius: 8px; margin-bottom: 10px; }
    .panel { padding: 16px; }
    summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; cursor: pointer; }
    summary::-webkit-details-marker { display: none; }
    .body { border-top: 1px solid #e8edf3; padding: 14px; }
    .toolbar, .actions { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
    .toolbar { justify-content: space-between; margin-bottom: 14px; }
    .search-form { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
    .search-form label { width: min(360px, 100%); }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(170px, 1fr)); gap: 12px 14px; align-items: start; }
    .wide { grid-column: span 2; }
    .full { grid-column: 1 / -1; }
    .metrics { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; }
    .metric { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 9px 10px; min-height: 38px; box-sizing: border-box; overflow-wrap: anywhere; }
    .metric b { display: block; color: #4b5870; font-size: 12px; font-weight: 600; }
    .metric span { display: block; color: #172033; font-size: 14px; margin-top: 3px; }
    .badge { background: #e8f2ff; color: #175cd3; border-radius: 999px; padding: 2px 8px; font-size: 12px; }
    .badge.warn { background: #fff7e6; color: #b54708; }
    .badge.danger { background: #fff1f0; color: #a8071a; }
    .examples { display: grid; gap: 8px; margin-top: 10px; }
    .example { background: #f8fafc; border: 1px solid #e8edf3; border-radius: 6px; padding: 9px 10px; font-size: 13px; }
    @media (max-width: 860px) {
      main { padding: 14px; }
      summary { align-items: flex-start; flex-direction: column; }
      .grid, .metrics { grid-template-columns: 1fr; }
      .wide { grid-column: span 1; }
      .toolbar { align-items: stretch; flex-direction: column; }
      .search-form { flex-wrap: nowrap; }
      .search-form label { flex: 1 1 auto; width: auto; }
    }
  </style>
  <script>
    async function submitAdminForm(form, submitter) {
      const method = String(form.method || "get").toLowerCase();
      if (method !== "post") return false;

      const formData = new FormData(form);
      if (submitter?.name) formData.set(submitter.name, submitter.value || "");
      const previousText = submitter?.textContent;
      if (submitter) {
        submitter.disabled = true;
        submitter.textContent = "处理中";
      }

      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "accept": "text/html",
          },
          body: new URLSearchParams(formData),
          credentials: "same-origin",
        });
        const html = await response.text();
        const next = new DOMParser().parseFromString(html, "text/html");
        if (!response.ok || !next.body) throw new Error("请求失败");
        document.title = next.title || document.title;
        document.body.replaceWith(next.body);
        const nextUrl = new URL(response.url);
        window.history.replaceState({}, "", nextUrl);
        if (nextUrl.hash) document.querySelector(nextUrl.hash)?.scrollIntoView();
      } catch (error) {
        if (submitter?.name && !form.querySelector('input[name="' + submitter.name + '"][type="hidden"]')) {
          const hidden = document.createElement("input");
          hidden.type = "hidden";
          hidden.name = submitter.name;
          hidden.value = submitter.value || "";
          form.appendChild(hidden);
        }
        form.submit();
      } finally {
        if (submitter && document.contains(submitter)) {
          submitter.disabled = false;
          submitter.textContent = previousText;
        }
      }
      return true;
    }

    document.addEventListener("submit", async (event) => {
      const form = event.target;
      if (!(form instanceof HTMLFormElement)) return;
      if (String(form.method || "get").toLowerCase() !== "post") return;
      event.preventDefault();
      await submitAdminForm(form, event.submitter);
    });
  </script>
</head>
<body>
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">当前管理员：${escapeHtml(adminEmail || "unknown")} · <a href="/admin/logout">退出</a></p>
    <nav>
      <a href="/admin${tokenParam}">用户管理</a>
      <a href="/admin${tokenParam}#conversations">群聊绑定</a>
      <a href="/admin/suggestions${tokenParam}">候选词</a>
      <a href="/admin/glossary${tokenParam}">术语库</a>
    </nav>
  </header>
  <main>
    ${message ? `<div class="message">${escapeHtml(message)}</div>` : ""}
    ${content}
  </main>
</body>
</html>`;
}

function renderMetric(label, value) {
  return `<div class="metric"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span></div>`;
}

function renderExamples(examples) {
  const list = Array.isArray(examples) ? examples : [];
  if (!list.length) return '<p class="meta">暂无 examples。</p>';
  return `<div class="examples">${list.map((item) => `<div class="example">${escapeHtml(item)}</div>`).join("")}</div>`;
}

function parseTermInput(body, existing = {}) {
  const terms = {};
  const aliases = {};
  const definitions = {};

  for (const lang of GLOSSARY_LANGS) {
    const term = String(body[`term_${lang}`] || "").trim();
    const aliasList = parseList(body[`aliases_${lang}`]);
    const definition = String(body[`definition_${lang}`] || "").trim();

    if (term) terms[lang] = term;
    if (aliasList.length) aliases[lang] = aliasList;
    if (definition) definitions[lang] = definition;
  }

  const status = TERM_STATUSES.has(String(body.status || "")) ? String(body.status) : existing.status || "draft";
  const riskLevel = RISK_LEVELS.has(String(body.risk_level || "")) ? String(body.risk_level) : existing.risk_level || "low";

  return {
    terms,
    aliases,
    definitions,
    domain: String(body.domain || existing.domain || "general").trim() || "general",
    status,
    source: TERM_SOURCES.has(String(body.source || "")) ? String(body.source) : existing.source || "manual",
    reviewed: String(body.reviewed || "") === "true",
    reviewed_by: String(body.reviewed_by || "").trim() || existing.reviewed_by || null,
    risk_level: riskLevel,
    requires_disclaimer: String(body.requires_disclaimer || "") === "true",
    review_after: parseDateInput(body.review_after),
  };
}

function validateTermPayload(payload) {
  if (!Object.keys(payload.terms || {}).length) return "至少需要填写一个标准术语。";
  if (!TERM_STATUSES.has(payload.status)) return "术语状态不正确。";
  if (!RISK_LEVELS.has(payload.risk_level)) return "风险级别不正确。";
  if (!TERM_SOURCES.has(payload.source)) return "术语来源不正确。";
  return "";
}

function renderStatusOptions(selected) {
  return ["draft", "active", "deprecated"]
    .map((status) => `<option value="${status}" ${selected === status ? "selected" : ""}>${status}</option>`)
    .join("");
}

function renderRiskOptions(selected) {
  return ["low", "medium", "high"]
    .map((level) => `<option value="${level}" ${selected === level ? "selected" : ""}>${level}</option>`)
    .join("");
}

function renderSourceOptions(selected) {
  return ["manual", "ai", "import", "suggestion"]
    .map((source) => `<option value="${source}" ${selected === source ? "selected" : ""}>${source}</option>`)
    .join("");
}

function renderTermForm({ term = {}, token, action, title }) {
  const terms = term.terms || {};
  const aliases = term.aliases || {};
  const definitions = term.definitions || {};

  return `<section class="panel">
    <h2>${escapeHtml(title)}</h2>
    <form method="post" action="${escapeHtml(action)}">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <div class="grid">
        ${GLOSSARY_LANGS.map((lang) => `
          <label>${escapeHtml(lang)} 标准术语
            <input name="term_${escapeHtml(lang)}" value="${escapeHtml(terms[lang] || "")}">
          </label>
          <label>${escapeHtml(lang)} 别名
            <textarea name="aliases_${escapeHtml(lang)}" placeholder="逗号或换行分隔">${escapeHtml((aliases[lang] || []).join("\n"))}</textarea>
          </label>
          <label class="wide">${escapeHtml(lang)} 定义
            <textarea name="definition_${escapeHtml(lang)}">${escapeHtml(definitions[lang] || "")}</textarea>
          </label>
        `).join("")}
        <label>领域 <input name="domain" value="${escapeHtml(term.domain || "general")}"></label>
        <label>状态 <select name="status">${renderStatusOptions(term.status || "draft")}</select></label>
        <label>风险级别 <select name="risk_level">${renderRiskOptions(term.risk_level || "low")}</select></label>
        <label>来源 <select name="source">${renderSourceOptions(term.source || "manual")}</select></label>
        <label>是否审核
          <select name="reviewed">
            <option value="false" ${term.reviewed ? "" : "selected"}>否</option>
            <option value="true" ${term.reviewed ? "selected" : ""}>是</option>
          </select>
        </label>
        <label>审核人 <input name="reviewed_by" value="${escapeHtml(term.reviewed_by || "")}"></label>
        <label>需要免责声明
          <select name="requires_disclaimer">
            <option value="false" ${term.requires_disclaimer ? "" : "selected"}>否</option>
            <option value="true" ${term.requires_disclaimer ? "selected" : ""}>是</option>
          </select>
        </label>
        <label>复审日期 <input name="review_after" type="date" value="${escapeHtml(formatDate(term.review_after) === "-" ? "" : formatDate(term.review_after))}"></label>
        <div class="full actions">
          <button type="submit">保存术语</button>
          <a class="button secondary" href="${escapeHtml(buildAdminUrl("/admin/glossary", token))}">返回列表</a>
        </div>
      </div>
    </form>
  </section>`;
}

async function loadMessageTerms(status = "candidate") {
  const { data, error } = await supabase
    .from("message_terms")
    .select("*")
    .eq("status", status)
    .order("count", { ascending: false })
    .order("last_seen_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data || [];
}

async function loadSuggestions(status = "pending_review") {
  const { data, error } = await supabase
    .from("term_suggestions")
    .select("*")
    .eq("status", status)
    .order("count", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  return data || [];
}

function renderMessageTermRows(rows, token) {
  if (!rows.length) return '<section class="panel">暂无候选词。</section>';

  return rows.map((row) => `<details>
    <summary>
      <span><strong>${escapeHtml(row.text)}</strong> <code>${escapeHtml(row.language)}</code> <span class="badge">${escapeHtml(row.status)}</span></span>
      <span class="meta">count ${Number(row.count || 0).toLocaleString("en-US")} · ${escapeHtml((row.domains || []).join(", ") || "general")}</span>
    </summary>
    <div class="body">
      <div class="metrics">
        ${renderMetric("标准化", row.normalized_text)}
        ${renderMetric("首次出现", formatDate(row.first_seen_at))}
        ${renderMetric("最近出现", formatDate(row.last_seen_at))}
        ${renderMetric("领域", (row.domains || []).join(", ") || "general")}
      </div>
      <h3>Examples</h3>
      ${renderExamples(row.examples)}
      <form method="post" action="/admin/message-terms/${escapeHtml(row.id)}/action" class="actions">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit" name="action" value="create_suggestion">生成建议</button>
        <button type="submit" name="action" value="promote_draft" class="secondary">转术语草稿</button>
        <button type="submit" name="action" value="ignore" class="danger">忽略</button>
      </form>
    </div>
  </details>`).join("");
}

function renderSuggestionRows(rows, token) {
  if (!rows.length) return '<section class="panel">暂无待审核建议。</section>';

  return rows.map((row) => `<details>
    <summary>
      <span><strong>${escapeHtml(row.source_text)}</strong> <code>${escapeHtml(row.language)}</code> <span class="badge warn">${escapeHtml(row.status)}</span></span>
      <span class="meta">count ${Number(row.count || 0).toLocaleString("en-US")} · ${escapeHtml(row.suggested_domain || "general")}</span>
    </summary>
    <div class="body">
      <div class="metrics">
        ${renderMetric("标准化", row.normalized_text)}
        ${renderMetric("领域", row.suggested_domain || "general")}
        ${renderMetric("创建时间", formatDate(row.created_at))}
        ${renderMetric("更新时间", formatDate(row.updated_at))}
      </div>
      <form method="post" action="/admin/suggestions/${escapeHtml(row.id)}/action" class="actions">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit" name="action" value="promote_draft">转术语草稿</button>
        <button type="submit" name="action" value="ignore" class="danger">忽略</button>
      </form>
    </div>
  </details>`).join("");
}

async function createGlossaryDraftFromMessageTerm(id) {
  const { data: row, error } = await supabase
    .from("message_terms")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !row) throw error || new Error("找不到候选词。");

  const terms = { [row.language || "und"]: row.text };
  const { data: term, error: insertError } = await supabase
    .from("glossary_terms")
    .insert({
      terms,
      aliases: {},
      definitions: {},
      domain: row.domains?.[0] || "general",
      status: "draft",
      source: "suggestion",
      risk_level: ["tax", "boi", "legal"].includes(row.domains?.[0]) ? "high" : "low",
      requires_disclaimer: ["tax", "boi", "legal"].includes(row.domains?.[0]),
    })
    .select("id")
    .single();

  if (insertError) throw insertError;

  await supabase.from("message_terms").update({ status: "promoted" }).eq("id", row.id);
  return term;
}

async function createGlossaryDraftFromSuggestion(id) {
  const { data: row, error } = await supabase
    .from("term_suggestions")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !row) throw error || new Error("找不到建议。");

  const terms = { [row.language || "und"]: row.source_text };
  const highRisk = ["tax", "boi", "legal"].includes(row.suggested_domain);
  const { data: term, error: insertError } = await supabase
    .from("glossary_terms")
    .insert({
      terms,
      aliases: {},
      definitions: {},
      domain: row.suggested_domain || "general",
      status: "draft",
      source: "suggestion",
      risk_level: highRisk ? "high" : "low",
      requires_disclaimer: highRisk,
    })
    .select("id")
    .single();

  if (insertError) throw insertError;

  await supabase
    .from("term_suggestions")
    .update({ status: "approved", glossary_term_id: term.id })
    .eq("id", row.id);

  if (row.message_term_id) {
    await supabase.from("message_terms").update({ status: "promoted" }).eq("id", row.message_term_id);
  }

  return term;
}

async function loadGlossaryTerms({ search = "", status = "" }) {
  let query = supabase
    .from("glossary_terms")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(150);

  if (status && TERM_STATUSES.has(status)) {
    query = query.eq("status", status);
  }

  const { data, error } = await query;
  if (error) throw error;

  const termSearch = String(search || "").trim().toLowerCase();
  if (!termSearch) return data || [];

  return (data || []).filter((row) =>
    JSON.stringify({
      terms: row.terms || {},
      aliases: row.aliases || {},
      definitions: row.definitions || {},
      domain: row.domain || "",
    }).toLowerCase().includes(termSearch)
  );
}

function renderGlossaryRows(rows, token) {
  if (!rows.length) return '<section class="panel">暂无术语。</section>';

  return rows.map((row) => {
    const terms = row.terms || {};
    const title = terms.zh || terms.en || terms.th || terms.my || terms.ja || row.id;
    const badgeClass = row.status === "active" ? "" : row.status === "deprecated" ? "danger" : "warn";

    return `<details>
      <summary>
        <span><strong>${escapeHtml(title)}</strong> <span class="badge ${badgeClass}">${escapeHtml(row.status)}</span> <code>${escapeHtml(row.domain)}</code></span>
        <span class="meta">${escapeHtml(row.risk_level)} · 更新 ${escapeHtml(formatDate(row.updated_at))}</span>
      </summary>
      <div class="body">
        <div class="metrics">
          ${GLOSSARY_LANGS.map((lang) => renderMetric(`${lang} 术语`, terms[lang] || "-")).join("")}
          ${renderMetric("审核", row.reviewed ? "是" : "否")}
          ${renderMetric("免责声明", row.requires_disclaimer ? "需要" : "不需要")}
          ${renderMetric("复审日期", formatDate(row.review_after))}
        </div>
        <div class="actions" style="margin-top: 12px;">
          <a class="button" href="${escapeHtml(buildAdminUrl(`/admin/glossary/${row.id}`, token))}">编辑</a>
        </div>
      </div>
    </details>`;
  }).join("");
}

function registerAdminGlossaryRoutes(app, options) {
  const { requireAdmin, adminTokenFromRequest } = options;

  app.get("/admin/suggestions", requireAdmin, async (req, res) => {
    try {
      const token = adminTokenFromRequest(req);
      const [messageTerms, suggestions] = await Promise.all([
        loadMessageTerms(String(req.query.term_status || "candidate")),
        loadSuggestions(String(req.query.suggestion_status || "pending_review")),
      ]);

      const content = `
        <div class="toolbar">
          <h2>术语候选与待审核建议</h2>
          <a class="button secondary" href="${escapeHtml(buildAdminUrl("/admin/glossary", token))}">查看术语库</a>
        </div>
        <section class="panel">
          <p class="meta">这里展示聊天中聚合出来的词和短语，只用于发现术语。候选词不会自动发布，必须人工转成术语草稿并审核。</p>
        </section>
        <h2>待审核建议</h2>
        ${renderSuggestionRows(suggestions, token)}
        <h2>术语候选词</h2>
        ${renderMessageTermRows(messageTerms, token)}
      `;

      res.status(200).send(renderAdminShell({
        title: "Glossary 候选词",
        token,
        message: req.query.message || "",
        adminEmail: req.adminEmail,
        content,
      }));
    } catch (error) {
      console.error("Load glossary suggestions failed:", error);
      res.status(500).send("候选词页面加载失败，请查看服务日志。");
    }
  });

  app.post("/admin/message-terms/:id/action", requireAdmin, async (req, res) => {
    const token = adminTokenFromRequest(req);
    const action = String(req.body.action || "");

    try {
      if (action === "ignore") {
        const { error } = await supabase.from("message_terms").update({ status: "ignored" }).eq("id", req.params.id);
        if (error) throw error;
        res.redirect(buildAdminUrl("/admin/suggestions", token, "候选词已忽略。"));
        return;
      }

      if (action === "create_suggestion") {
        const { error } = await supabase.rpc("create_term_suggestion_if_needed", {
          p_message_term_id: req.params.id,
          p_min_count: 1,
        });
        if (error) throw error;
        res.redirect(buildAdminUrl("/admin/suggestions", token, "已生成待审核建议。"));
        return;
      }

      if (action === "promote_draft") {
        const term = await createGlossaryDraftFromMessageTerm(req.params.id);
        res.redirect(buildAdminUrl(`/admin/glossary/${term.id}`, token, "已转为术语草稿，请继续编辑。"));
        return;
      }

      res.redirect(buildAdminUrl("/admin/suggestions", token, "未知操作。"));
    } catch (error) {
      console.error("Handle message term action failed:", error);
      res.redirect(buildAdminUrl("/admin/suggestions", token, `操作失败：${error.message}`));
    }
  });

  app.post("/admin/suggestions/:id/action", requireAdmin, async (req, res) => {
    const token = adminTokenFromRequest(req);
    const action = String(req.body.action || "");

    try {
      if (action === "ignore") {
        const { error } = await supabase.from("term_suggestions").update({ status: "ignored" }).eq("id", req.params.id);
        if (error) throw error;
        res.redirect(buildAdminUrl("/admin/suggestions", token, "建议已忽略。"));
        return;
      }

      if (action === "promote_draft") {
        const term = await createGlossaryDraftFromSuggestion(req.params.id);
        res.redirect(buildAdminUrl(`/admin/glossary/${term.id}`, token, "已转为术语草稿，请继续编辑。"));
        return;
      }

      res.redirect(buildAdminUrl("/admin/suggestions", token, "未知操作。"));
    } catch (error) {
      console.error("Handle suggestion action failed:", error);
      res.redirect(buildAdminUrl("/admin/suggestions", token, `操作失败：${error.message}`));
    }
  });

  app.get("/admin/glossary", requireAdmin, async (req, res) => {
    try {
      const token = adminTokenFromRequest(req);
      const search = String(req.query.search || "");
      const status = String(req.query.status || "");
      const rows = await loadGlossaryTerms({ search, status });
      const content = `
        <div class="toolbar">
          <h2>正式术语库</h2>
          <a class="button" href="${escapeHtml(buildAdminUrl("/admin/glossary/new", token))}">新增术语</a>
        </div>
        <section class="panel">
          <form method="get" action="/admin/glossary" class="search-form">
            <input type="hidden" name="token" value="${escapeHtml(token)}">
            <label>搜索 <input name="search" value="${escapeHtml(search)}" placeholder="术语 / 别名 / 定义 / 领域"></label>
            <label>状态
              <select name="status">
                <option value="" ${status ? "" : "selected"}>全部</option>
                ${["draft", "active", "deprecated"].map((item) => `<option value="${item}" ${status === item ? "selected" : ""}>${item}</option>`).join("")}
              </select>
            </label>
            <button type="submit" class="secondary">搜索</button>
          </form>
        </section>
        ${renderGlossaryRows(rows, token)}
      `;

      res.status(200).send(renderAdminShell({
        title: "Glossary 术语库",
        token,
        message: req.query.message || "",
        adminEmail: req.adminEmail,
        content,
      }));
    } catch (error) {
      console.error("Load glossary terms failed:", error);
      res.status(500).send("术语库页面加载失败，请查看服务日志。");
    }
  });

  app.get("/admin/glossary/new", requireAdmin, (req, res) => {
    const token = adminTokenFromRequest(req);
    res.status(200).send(renderAdminShell({
      title: "新增术语",
      token,
      message: req.query.message || "",
      adminEmail: req.adminEmail,
      content: renderTermForm({
        token,
        action: "/admin/glossary",
        title: "新增术语",
        term: { status: "draft", domain: "general", risk_level: "low" },
      }),
    }));
  });

  app.post("/admin/glossary", requireAdmin, async (req, res) => {
    const token = adminTokenFromRequest(req);
    const payload = parseTermInput(req.body);
    const validationError = validateTermPayload(payload);

    if (validationError) {
      res.redirect(buildAdminUrl("/admin/glossary/new", token, validationError));
      return;
    }

    const { data, error } = await supabase.from("glossary_terms").insert(payload).select("id").single();
    if (error) {
      console.error("Create glossary term failed:", error);
      res.redirect(buildAdminUrl("/admin/glossary/new", token, `创建失败：${error.message}`));
      return;
    }

    res.redirect(buildAdminUrl(`/admin/glossary/${data.id}`, token, "术语已创建。"));
  });

  app.get("/admin/glossary/:id", requireAdmin, async (req, res) => {
    try {
      const token = adminTokenFromRequest(req);
      const { data: term, error } = await supabase
        .from("glossary_terms")
        .select("*")
        .eq("id", req.params.id)
        .single();

      if (error || !term) throw error || new Error("找不到术语。");

      res.status(200).send(renderAdminShell({
        title: "编辑术语",
        token,
        message: req.query.message || "",
        adminEmail: req.adminEmail,
        content: renderTermForm({
          token,
          action: `/admin/glossary/${term.id}`,
          title: "编辑术语",
          term,
        }),
      }));
    } catch (error) {
      console.error("Load glossary term failed:", error);
      res.redirect(buildAdminUrl("/admin/glossary", adminTokenFromRequest(req), `加载失败：${error.message}`));
    }
  });

  app.post("/admin/glossary/:id", requireAdmin, async (req, res) => {
    const token = adminTokenFromRequest(req);
    const payload = parseTermInput(req.body);
    const validationError = validateTermPayload(payload);

    if (validationError) {
      res.redirect(buildAdminUrl(`/admin/glossary/${req.params.id}`, token, validationError));
      return;
    }

    const { error } = await supabase
      .from("glossary_terms")
      .update(payload)
      .eq("id", req.params.id);

    if (error) {
      console.error("Update glossary term failed:", error);
      res.redirect(buildAdminUrl(`/admin/glossary/${req.params.id}`, token, `保存失败：${error.message}`));
      return;
    }

    res.redirect(buildAdminUrl(`/admin/glossary/${req.params.id}`, token, "术语已保存。"));
  });
}

module.exports = {
  registerAdminGlossaryRoutes,
};
