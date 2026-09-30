// Programação de Férias — lê o relatório "Programação de Férias" do Domínio Web (mesma esteira do
// Comparativo de Movimento, ver dominioRelatoriosSincronizar em server.ts), identifica os
// funcionários com férias VENCIDAS (ou perto de vencer) e manda um relatório curado — só com quem
// interessa — pra cada cliente, uma vez por mês (ou na hora, pelo botão "Enviar agora").
//
// [2026-09-29] Regra de vencimento usada aqui é a regra geral da CLT (período aquisitivo de 12 meses
// + período concessivo de mais 12 meses = vence 24 meses após o fim do período aquisitivo). O layout
// exato do PDF do Domínio (nomes de coluna, se tem período aquisitivo em duas datas "de/até" ou só
// uma) AINDA NÃO foi conferido contra um relatório real — feriasExtrairFuncionarios é o único lugar
// que precisa mudar quando isso for validado.
import type express from "express";

type Deps = {
  sqlite: any;
  blockCliente: express.RequestHandler;
  requirePermissao: (modulo: "dprh", acao: "visualizar" | "postar" | "editar") => express.RequestHandler;
  podeAcessarEmpresa: (user: any, empresaId: number) => boolean;
  empresasVisiveis: (user: any) => number[] | null;
  enviarEmail: (escritorioId: number, msg: { to: string[]; subject: string; text: string; attachments?: { filename: string; content: Buffer }[] }) => Promise<any>;
  // canal: "conversa" (deskcomm) ou "meta" (API oficial) — mesmo dispatcher de hoje mais cedo.
  enviarWhatsapp: (canal: string, escritorioId: number, telefone: string, nomeContato: string, descricao: string, arquivo: { nome: string; tipo: string; buffer: Buffer }, origem: { tabela: string; id: number }) => Promise<void>;
};

let deps: Deps;
const hojeIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Brasília ~UTC-3

function brParaIso(dataBr: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataBr);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
function isoParaBr(dataIso: string): string {
  const [a, m, d] = dataIso.split("-");
  return `${d}/${m}/${a}`;
}
function somarMeses(dataIso: string, meses: number): string {
  const d = new Date(dataIso + "T00:00:00");
  d.setMonth(d.getMonth() + meses);
  return d.toISOString().slice(0, 10);
}

// Lê o texto do PDF linha a linha: uma linha "parece" um funcionário quando tem um nome (2+
// palavras, maioria letras) seguido de pelo menos uma data dd/mm/aaaa. Se a linha tiver duas datas
// (típico de "período aquisitivo: 01/01/2023 a 31/12/2023"), usa a SEGUNDA como fim do período
// aquisitivo; com uma data só, usa essa mesma (suposição a confirmar com o relatório real).
export function feriasExtrairFuncionarios(texto: string): { nome: string; matricula: string | null; periodoAquisitivoFimBr: string }[] {
  const funcionarios: { nome: string; matricula: string | null; periodoAquisitivoFimBr: string }[] = [];
  const linhas = texto.split(/\r?\n/);
  const dataRe = /\d{2}\/\d{2}\/\d{4}/g;
  for (const linhaOriginal of linhas) {
    const linha = linhaOriginal.trim();
    if (!linha) continue;
    const datas = [...linha.matchAll(dataRe)];
    if (!datas.length) continue;
    const antesDaData = linha.slice(0, datas[0].index).trim();
    const matriculaMatch = /^(\d{1,10})\s*[-.]?\s*/.exec(antesDaData);
    const nome = (matriculaMatch ? antesDaData.slice(matriculaMatch[0].length) : antesDaData).trim();
    const palavras = nome.split(/\s+/).filter(Boolean);
    if (palavras.length < 2 || !/^[A-ZÀ-Ý][A-ZÀ-Ýa-zà-ÿ'.\- ]+$/.test(nome)) continue;
    const periodoAquisitivoFimBr = datas.length >= 2 ? datas[1][0] : datas[0][0];
    funcionarios.push({ nome, matricula: matriculaMatch ? matriculaMatch[1] : null, periodoAquisitivoFimBr });
  }
  return funcionarios;
}
export function feriasCalcularStatus(periodoAquisitivoFimIso: string, hoje = hojeIso()): { status: "vencida" | "proxima" | "ok"; limiteConcessao: string } {
  const limiteConcessao = somarMeses(periodoAquisitivoFimIso, 12);
  const diffDias = Math.round((new Date(limiteConcessao + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) / 86400000);
  const status = diffDias < 0 ? "vencida" : diffDias <= 30 ? "proxima" : "ok";
  return { status, limiteConcessao };
}
// Chamado pelo loop de dominioRelatoriosSincronizar (server.ts) quando um PDF é classificado como
// "programacao_ferias" — substitui a foto anterior dessa empresa pela nova (o relatório do Domínio
// sempre vem completo, não é incremental).
export function feriasProcessarPdf(escritorioId: number, empresaId: number, texto: string, origemDocId: number | null): number {
  const funcionarios = feriasExtrairFuncionarios(texto);
  const hoje = hojeIso();
  deps.sqlite.prepare(`DELETE FROM ferias_funcionarios WHERE empresa_id = ?`).run(empresaId);
  const ins = deps.sqlite.prepare(
    `INSERT INTO ferias_funcionarios (escritorio_id, empresa_id, nome, matricula, periodo_aquisitivo_fim, limite_concessao, status, origem_doc_id) VALUES (?,?,?,?,?,?,?,?)`
  );
  let gravados = 0;
  for (const f of funcionarios) {
    const iso = brParaIso(f.periodoAquisitivoFimBr);
    if (!iso) continue;
    const { status, limiteConcessao } = feriasCalcularStatus(iso, hoje);
    ins.run(escritorioId, empresaId, f.nome, f.matricula, iso, limiteConcessao, status, origemDocId);
    gravados++;
  }
  return gravados;
}

const MENSAGEM_STATUS: Record<string, string> = {
  vencida: "Férias vencidas — atenção: gera pagamento em dobro se não forem concedidas",
  proxima: "Último mês para conceder as férias",
};

function gerarHtmlRelatorio(escritorioNome: string, empresaNome: string, funcionarios: any[]): string {
  const linhas = funcionarios
    .map(
      (f) => `<tr>
        <td>${f.nome}</td>
        <td class="${f.status === "vencida" ? "vencida" : "proxima"}">${f.status === "vencida" ? "Vencida" : "Próxima do limite"}</td>
        <td>${isoParaBr(f.limite_concessao)}</td>
        <td>${MENSAGEM_STATUS[f.status] || ""}</td>
      </tr>`
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Helvetica Neue',Arial,sans-serif; color:#1c2b24; margin:0; padding:28px 32px;}
    h1{font-size:18px; margin:0 0 2px;}
    .sub{font-size:12px; color:#5b6b63; margin:0 0 18px;}
    table{width:100%; border-collapse:collapse; font-size:12px;}
    th{text-align:left; background:#eef5f1; padding:8px 10px; border-bottom:2px solid #cfe0d8; font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; color:#3c584a;}
    td{padding:8px 10px; border-bottom:1px solid #e5eae7;}
    td.vencida{color:#b23b3b; font-weight:600;}
    td.proxima{color:#a5730a; font-weight:600;}
    .rodape{margin-top:22px; font-size:10.5px; color:#8a938d;}
  </style></head><body>
    <h1>Programação de Férias — pendências</h1>
    <p class="sub"><b>${empresaNome}</b> · gerado em ${new Date().toLocaleDateString("pt-BR")} por ${escritorioNome}</p>
    <table><thead><tr><th>Funcionário</th><th>Situação</th><th>Limite para conceder</th><th>Observação</th></tr></thead>
    <tbody>${linhas}</tbody></table>
    <p class="rodape">Relatório gerado automaticamente a partir da Programação de Férias do Domínio Web. Férias vencidas geram o pagamento em dobro previsto na CLT — recomendamos agendar o quanto antes.</p>
  </body></html>`;
}
export async function gerarPdfFeriasVencidas(escritorioNome: string, empresaNome: string, funcionarios: any[]): Promise<Buffer> {
  const html = gerarHtmlRelatorio(escritorioNome, empresaNome, funcionarios);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "0", bottom: "0", left: "0", right: "0" } });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}

function funcionariosPendentes(sqlite: any, empresaId: number): any[] {
  return sqlite
    .prepare(`SELECT * FROM ferias_funcionarios WHERE empresa_id = ? AND status IN ('vencida','proxima') ORDER BY status, limite_concessao`)
    .all(empresaId) as any[];
}
async function enviarRelatorioEmpresa(escritorioId: number, empresa: any, canal: string): Promise<{ ok: boolean; erro?: string; qtd: number }> {
  const funcionarios = funcionariosPendentes(deps.sqlite, empresa.id);
  if (!funcionarios.length) return { ok: false, erro: "Nenhum funcionário com férias vencidas ou próximas do limite.", qtd: 0 };
  const escritorio = deps.sqlite.prepare(`SELECT nome FROM escritorios WHERE id = ?`).get(escritorioId) as any;
  const pdf = await gerarPdfFeriasVencidas(escritorio?.nome || "Escritório Contábil", empresa.nome, funcionarios);
  const nomeArquivo = `Programacao de Ferias - Pendencias - ${empresa.nome}.pdf`;
  const contatosEmail = deps.sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1 AND email IS NOT NULL AND email != ''`).all(empresa.id) as any[];
  const contatosWpp = deps.sqlite.prepare(`SELECT telefone FROM empresa_contatos WHERE empresa_id = ? AND receber_whatsapp = 1 AND telefone IS NOT NULL AND telefone != ''`).all(empresa.id) as any[];
  if (!contatosEmail.length && !contatosWpp.length) return { ok: false, erro: "Empresa sem contato de e-mail nem WhatsApp cadastrado.", qtd: funcionarios.length };
  let algumOk = false;
  const erros: string[] = [];
  if (contatosEmail.length) {
    try {
      await deps.enviarEmail(escritorioId, {
        to: contatosEmail.map((c) => c.email),
        subject: `${empresa.nome} — Programação de Férias (pendências)`,
        text: `Olá!\n\nSegue em anexo o relatório de funcionários com férias vencidas ou próximas do limite para concessão.\n\nQualquer dúvida, estamos à disposição.`,
        attachments: [{ filename: nomeArquivo, content: pdf }],
      });
      algumOk = true;
    } catch (e: any) { erros.push(e.message); }
  }
  for (const c of contatosWpp) {
    try {
      await deps.enviarWhatsapp(canal, escritorioId, c.telefone, empresa.nome, "Programação de Férias — funcionários com férias vencidas/próximas do limite", { nome: nomeArquivo, tipo: "application/pdf", buffer: pdf }, { tabela: "ferias_agendamento_log", id: empresa.id });
      algumOk = true;
    } catch (e: any) { erros.push(e.message); }
  }
  return { ok: algumOk, erro: algumOk ? undefined : erros[0], qtd: funcionarios.length };
}

export function registerFerias(app: express.Express, d: Deps) {
  deps = d;
  const { sqlite } = d;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ferias_funcionarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      nome TEXT NOT NULL,
      matricula TEXT,
      periodo_aquisitivo_fim TEXT NOT NULL,
      limite_concessao TEXT NOT NULL,
      status TEXT NOT NULL, -- 'vencida' | 'proxima' | 'ok'
      origem_doc_id INTEGER,
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_ferias_func_empresa ON ferias_funcionarios(empresa_id, status);
    CREATE TABLE IF NOT EXISTS ferias_agendamento_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ativo INTEGER NOT NULL DEFAULT 0,
      dia_mes INTEGER NOT NULL DEFAULT 5,
      hora INTEGER NOT NULL DEFAULT 8,
      minuto INTEGER NOT NULL DEFAULT 0,
      ultima_execucao_competencia TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS ferias_agendamento_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      competencia TEXT NOT NULL,
      sucesso INTEGER NOT NULL,
      qtd_funcionarios INTEGER NOT NULL DEFAULT 0,
      mensagem TEXT,
      executado_em TEXT DEFAULT (datetime('now'))
    );
  `);
  sqlite.prepare(`INSERT OR IGNORE INTO ferias_agendamento_config (id) VALUES (1)`).run();

  app.get("/api/ferias/estado", d.blockCliente, d.requirePermissao("dprh", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const visiveis = d.empresasVisiveis(user);
    const cfg = sqlite.prepare(`SELECT * FROM ferias_agendamento_config WHERE id = 1`).get() as any;
    let sql = `SELECT e.id, e.nome, MAX(f.atualizado_em) as atualizadoEm,
        SUM(CASE WHEN f.status='vencida' THEN 1 ELSE 0 END) as vencidas,
        SUM(CASE WHEN f.status='proxima' THEN 1 ELSE 0 END) as proximas
      FROM ferias_funcionarios f JOIN empresas e ON e.id = f.empresa_id
      WHERE f.status IN ('vencida','proxima')`;
    const params: any[] = [];
    if (visiveis !== null) {
      if (!visiveis.length) return res.json({ empresas: [], ativo: !!cfg.ativo, diaMes: cfg.dia_mes, hora: cfg.hora, minuto: cfg.minuto });
      sql += ` AND e.id IN (${visiveis.map(() => "?").join(",")})`;
      params.push(...visiveis);
    }
    sql += ` GROUP BY e.id ORDER BY vencidas DESC, proximas DESC, e.nome`;
    const empresas = sqlite.prepare(sql).all(...params) as any[];
    for (const emp of empresas) {
      emp.funcionarios = funcionariosPendentes(sqlite, emp.id).map((f) => ({
        nome: f.nome, status: f.status, limiteConcessao: f.limite_concessao, mensagem: MENSAGEM_STATUS[f.status] || "",
      }));
    }
    res.json({ empresas, ativo: !!cfg.ativo, diaMes: cfg.dia_mes, hora: cfg.hora, minuto: cfg.minuto });
  });
  app.post("/api/ferias/config", d.blockCliente, d.requirePermissao("dprh", "editar"), (req, res) => {
    const b = req.body || {};
    const diaMes = Math.min(28, Math.max(1, Number(b.diaMes) || 5));
    const hora = Math.min(23, Math.max(0, Number(b.hora) || 0));
    const minuto = Math.min(59, Math.max(0, Number(b.minuto) || 0));
    sqlite.prepare(`UPDATE ferias_agendamento_config SET ativo = ?, dia_mes = ?, hora = ?, minuto = ?, updated_at = datetime('now') WHERE id = 1`).run(b.ativo ? 1 : 0, diaMes, hora, minuto);
    res.json({ ok: true });
  });
  app.post("/api/ferias/empresas/:id/enviar-agora", d.blockCliente, d.requirePermissao("dprh", "postar"), async (req, res) => {
    const user = (req as any).user;
    const empresaId = Number(req.params.id);
    if (!d.podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
    const empresa = sqlite.prepare(`SELECT id, nome, escritorio_id FROM empresas WHERE id = ?`).get(empresaId) as any;
    if (!empresa) return res.status(404).json({ error: "Empresa não encontrada." });
    try {
      const r = await enviarRelatorioEmpresa(empresa.escritorio_id, empresa, String(req.body?.canal) === "meta" ? "meta" : "conversa");
      sqlite
        .prepare(`INSERT INTO ferias_agendamento_log (empresa_id, competencia, sucesso, qtd_funcionarios, mensagem) VALUES (?, ?, ?, ?, ?)`)
        .run(empresa.id, new Date().toISOString().slice(0, 7), r.ok ? 1 : 0, r.qtd, r.erro || null);
      if (!r.ok) return res.status(400).json({ error: r.erro || "Não consegui enviar." });
      res.json({ ok: true, qtd: r.qtd });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Uma vez por mês (trava por competência, sobrevive a reinício — mesmo padrão do agendamento de
  // NFS-e): manda o relatório curado só pras empresas com pelo menos 1 funcionário vencida/próxima.
  setInterval(async () => {
    const cfg = sqlite.prepare(`SELECT * FROM ferias_agendamento_config WHERE id = 1`).get() as any;
    if (!cfg?.ativo) return;
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    const competencia = agora.toISOString().slice(0, 7);
    if (cfg.ultima_execucao_competencia === competencia) return;
    if (agora.getDate() !== cfg.dia_mes || agora.getHours() !== cfg.hora || agora.getMinutes() !== cfg.minuto) return;
    sqlite.prepare(`UPDATE ferias_agendamento_config SET ultima_execucao_competencia = ? WHERE id = 1`).run(competencia);
    const empresas = sqlite
      .prepare(`SELECT DISTINCT e.id, e.nome, e.escritorio_id FROM empresas e JOIN ferias_funcionarios f ON f.empresa_id = e.id WHERE f.status IN ('vencida','proxima') AND e.ativo = 1`)
      .all() as any[];
    for (const empresa of empresas) {
      try {
        const r = await enviarRelatorioEmpresa(empresa.escritorio_id, empresa, "conversa");
        sqlite
          .prepare(`INSERT INTO ferias_agendamento_log (empresa_id, competencia, sucesso, qtd_funcionarios, mensagem) VALUES (?, ?, ?, ?, ?)`)
          .run(empresa.id, competencia, r.ok ? 1 : 0, r.qtd, r.erro || null);
      } catch (e: any) {
        sqlite.prepare(`INSERT INTO ferias_agendamento_log (empresa_id, competencia, sucesso, qtd_funcionarios, mensagem) VALUES (?, ?, 0, 0, ?)`).run(empresa.id, competencia, String(e.message).slice(0, 300));
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 60_000).unref();
}
