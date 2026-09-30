// Programação de Férias — lê o relatório "Programação de Férias" do Domínio Web (mesma esteira do
// Comparativo de Movimento, ver dominioRelatoriosSincronizar em server.ts), identifica os
// funcionários com férias VENCIDAS (ou perto de vencer) e manda um relatório curado — só com quem
// interessa — pra cada cliente, uma vez por mês (ou na hora, pelo botão "Enviar agora").
//
// [2026-09-29] Layout conferido contra um relatório real do Domínio. A coluna "Fer. venc." já vem
// PRONTA de lá (quantidade de períodos vencidos) — não precisa calcular pela CLT, só ler: >0 é
// vencida, traz a linha inteira. Pra quem ainda não venceu, usa a própria coluna "Limite p/ gozo"
// pra avisar quando faltar 30 dias ("Último mês pra conceder as férias").
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
  // Relê do disco todo PDF já importado como "Programação de Férias" e roda feriasProcessarPdf de
  // novo em cada um — usado pelo agendador de verificação e pelo botão "Verificar agora" (a esteira
  // de 10s do Drive já pega arquivo NOVO sozinha; isso aqui é pra reconferir o que já tem).
  reprocessarExistentes: (escritorioId: number) => Promise<number>;
};

let deps: Deps;
const hojeIso = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); // Brasília ~UTC-3

function brParaIso(dataBr: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dataBr);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}
function isoParaBr(dataIso: string | null): string {
  if (!dataIso) return "—";
  const [a, m, d] = dataIso.split("-");
  return `${d}/${m}/${a}`;
}

// [2026-09-29] Conferido contra o texto REAL extraído por pdf-parse (não o layout visual do PDF): as
// colunas vêm grudadas sem separador confiável — o pdf-parse não preserva os espaços visuais da
// tabela. Ordem real observada por linha: NOME (maiúsculo) + CÓDIGO (1-4 dígitos, colado, sem espaço
// antes da data) + Data admissão + Fer. venc. (colado, sem espaço) + Fer. pro. (NN/NN) + Início
// aquisitivo (colado) + Fim aquisitivo (colado) + [miolo sem uso confiável: início gozo/dias/abono/
// 13º, tudo pontinhos ou números sem separador claro] + Limite p/ gozo (1ª data depois do miolo).
// "Vencto. férias" e Dias dir./goz. não têm posição confiável o bastante pra extrair — ficam de fora
// (feriasCalcularStatus não depende deles: usa só Fer. venc. + Limite p/ gozo, ambos confiáveis).
export function feriasExtrairFuncionarios(texto: string): {
  codigo: string; nome: string;
  dataAdmissaoBr: string | null; ferVenc: number;
  inicioAquisitivoBr: string | null; fimAquisitivoBr: string | null;
  diasRestantes: number | null; limiteGozoBr: string | null;
}[] {
  const funcionarios: ReturnType<typeof feriasExtrairFuncionarios> = [];
  const linhas = texto.split(/\r?\n/);
  // grupos: 1 nome | 2 código | 3 admissão | 4 fer.venc | 5 fer.pro (descartado) | 6 início aquis. | 7 fim aquis. | 8 resto da linha
  const linhaRe = /^([A-ZÀ-Ý][A-ZÀ-Ýa-zà-ÿ'.\- ]{3,60}?)\s{0,3}(\d{1,4})(\d{2}\/\d{2}\/\d{4})(\d{1,2})\s{0,3}(\d{1,2}\/\d{1,2})(\d{2}\/\d{2}\/\d{4})(\d{2}\/\d{2}\/\d{4})(.*)$/;
  for (const linhaOriginal of linhas) {
    const linha = linhaOriginal.trim();
    if (!linha) continue;
    const m = linhaRe.exec(linha);
    if (!m) continue;
    const nome = m[1].trim();
    if (nome.split(/\s+/).filter(Boolean).length < 2) continue; // nome de verdade tem 2+ palavras
    const resto = m[8];
    const restoDatas = [...resto.matchAll(/\d{2}\/\d{2}\/\d{4}/g)];
    const limiteGozoBr = restoDatas[0]?.[0] || null;
    let diasRestantes: number | null = null;
    if (restoDatas[0]) {
      const numeros = [...resto.slice(0, restoDatas[0].index).matchAll(/\d{1,3}/g)];
      if (numeros.length) diasRestantes = parseInt(numeros[numeros.length - 1][0], 10);
    }
    funcionarios.push({
      codigo: m[2], nome,
      dataAdmissaoBr: m[3], ferVenc: parseInt(m[4], 10) || 0,
      inicioAquisitivoBr: m[6], fimAquisitivoBr: m[7],
      diasRestantes, limiteGozoBr,
    });
  }
  return funcionarios;
}
// "vencida" vem PRONTO da coluna Fer. venc. (>0). Sem vencida ainda, mas a 30 dias (ou menos) do
// Limite p/ gozo: "proxima" (avisa "Último mês pra conceder"). O resto não entra no relatório.
export function feriasCalcularStatus(ferVenc: number, limiteGozoBr: string | null, hoje = hojeIso()): "vencida" | "proxima" | "ok" {
  if (ferVenc > 0) return "vencida";
  const iso = limiteGozoBr ? brParaIso(limiteGozoBr) : null;
  if (iso) {
    const diffDias = Math.round((new Date(iso + "T00:00:00").getTime() - new Date(hoje + "T00:00:00").getTime()) / 86400000);
    if (diffDias <= 30) return "proxima";
  }
  return "ok";
}
// Chamado pelo loop de dominioRelatoriosSincronizar (server.ts) quando um PDF é classificado como
// "programacao_ferias" — substitui a foto anterior dessa empresa pela nova (o relatório do Domínio
// sempre vem completo, não é incremental).
export function feriasProcessarPdf(escritorioId: number, empresaId: number, texto: string, origemDocId: number | null): number {
  const funcionarios = feriasExtrairFuncionarios(texto);
  const hoje = hojeIso();
  deps.sqlite.prepare(`DELETE FROM ferias_funcionarios WHERE empresa_id = ?`).run(empresaId);
  const ins = deps.sqlite.prepare(
    `INSERT INTO ferias_funcionarios (escritorio_id, empresa_id, codigo, nome, data_admissao, fer_venc, inicio_aquisitivo, fim_aquisitivo, dias_restantes, limite_gozo, status, origem_doc_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  let gravados = 0;
  for (const f of funcionarios) {
    const status = feriasCalcularStatus(f.ferVenc, f.limiteGozoBr, hoje);
    if (status === "ok") continue; // só guarda quem interessa (vencida/próxima) — igual foi pedido
    ins.run(
      escritorioId, empresaId, f.codigo, f.nome,
      brParaIso(f.dataAdmissaoBr || ""), f.ferVenc,
      brParaIso(f.inicioAquisitivoBr || ""), brParaIso(f.fimAquisitivoBr || ""),
      f.diasRestantes, brParaIso(f.limiteGozoBr || ""),
      status, origemDocId
    );
    gravados++;
  }
  return gravados;
}

const MENSAGEM_STATUS: Record<string, string> = {
  vencida: "Férias vencidas — atenção: gera pagamento em dobro se não forem concedidas",
  proxima: "Último mês para conceder as férias",
};

// Layout "empolgante" pra mandar pro cliente: faixa colorida no topo com o total de pendências,
// cards por funcionário (não uma tabela seca) e uma chamada clara pra ação.
function gerarHtmlRelatorio(escritorioNome: string, empresaNome: string, funcionarios: any[]): string {
  const vencidas = funcionarios.filter((f) => f.status === "vencida");
  const proximas = funcionarios.filter((f) => f.status === "proxima");
  const cardFuncionario = (f: any) => `
    <div class="pessoa ${f.status}">
      <div class="pessoa-topo">
        <span class="selo ${f.status}">${f.status === "vencida" ? "⚠ VENCIDA" : "⏳ ÚLTIMO MÊS"}</span>
        <span class="nome">${f.nome}</span>
      </div>
      <div class="linhas">
        <span>Admissão: <b>${isoParaBr(f.data_admissao)}</b></span>
        <span>Período aquisitivo: <b>${isoParaBr(f.inicio_aquisitivo)} a ${isoParaBr(f.fim_aquisitivo)}</b></span>
        <span>Prazo para conceder: <b>${isoParaBr(f.limite_gozo)}</b></span>
        ${f.dias_restantes != null ? `<span>Dias de férias em aberto: <b>${f.dias_restantes}</b></span>` : ""}
      </div>
      <div class="msg">${MENSAGEM_STATUS[f.status] || ""}</div>
    </div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Helvetica Neue',Arial,sans-serif; color:#1c2b24; margin:0; background:#f4f8f6;}
    .topo{background:linear-gradient(135deg,#1f6f4d,#154d36); color:#fff; padding:30px 36px 26px;}
    .topo h1{margin:0 0 4px; font-size:21px;}
    .topo p{margin:0; opacity:.85; font-size:12.5px;}
    .resumo{display:flex; gap:14px; margin-top:16px;}
    .pill{background:rgba(255,255,255,.14); border-radius:10px; padding:10px 16px;}
    .pill b{display:block; font-size:22px;}
    .pill span{font-size:11px; opacity:.85; text-transform:uppercase; letter-spacing:.04em;}
    .corpo{padding:22px 36px 30px;}
    .pessoa{background:#fff; border-radius:12px; padding:14px 18px; margin-bottom:12px; border-left:5px solid #cfd8d3; box-shadow:0 1px 3px rgba(20,40,30,.06);}
    .pessoa.vencida{border-left-color:#c0392b;}
    .pessoa.proxima{border-left-color:#c9861a;}
    .pessoa-topo{display:flex; align-items:center; gap:10px; margin-bottom:8px;}
    .selo{font-size:10.5px; font-weight:700; letter-spacing:.03em; padding:3px 9px; border-radius:20px; color:#fff;}
    .selo.vencida{background:#c0392b;}
    .selo.proxima{background:#c9861a;}
    .nome{font-weight:700; font-size:14px;}
    .linhas{display:flex; flex-wrap:wrap; gap:4px 18px; font-size:12px; color:#4a5852; margin-bottom:6px;}
    .msg{font-size:12px; font-weight:600; color:#3c584a;}
    .rodape{padding:16px 36px 26px; font-size:10.5px; color:#8a938d;}
  </style></head><body>
    <div class="topo">
      <h1>Programação de Férias — ${empresaNome}</h1>
      <p>Relatório gerado em ${new Date().toLocaleDateString("pt-BR")} por ${escritorioNome}</p>
      <div class="resumo">
        ${vencidas.length ? `<div class="pill"><b>${vencidas.length}</b><span>Vencidas</span></div>` : ""}
        ${proximas.length ? `<div class="pill"><b>${proximas.length}</b><span>Último mês</span></div>` : ""}
      </div>
    </div>
    <div class="corpo">${funcionarios.map(cardFuncionario).join("")}</div>
    <p class="rodape">Férias vencidas geram pagamento em dobro previsto na CLT — recomendamos agendar o quanto antes. Qualquer dúvida, estamos à disposição.</p>
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

// Exportação pro controle interno do escritório: separado por empresa (um bloco + tabela por
// empresa, igual os cards da tela) em vez de uma tabela só com a empresa repetida em toda linha.
export async function gerarPdfControleInterno(escritorioNome: string, empresas: { nome: string; funcionarios: any[] }[]): Promise<Buffer> {
  const totalVencidas = empresas.reduce((s, e) => s + e.funcionarios.filter((f) => f.status === "vencida").length, 0);
  const totalProximas = empresas.reduce((s, e) => s + e.funcionarios.filter((f) => f.status === "proxima").length, 0);
  const linhaFunc = (f: any) => `<tr>
        <td>${f.codigo || "—"}</td>
        <td>${f.nome}</td>
        <td class="${f.status}">${f.status === "vencida" ? "Vencida" : "Último mês"}</td>
        <td>${isoParaBr(f.data_admissao)}</td>
        <td>${isoParaBr(f.inicio_aquisitivo)} a ${isoParaBr(f.fim_aquisitivo)}</td>
        <td>${isoParaBr(f.limite_gozo)}</td>
        <td>${f.dias_restantes ?? "—"}</td>
      </tr>`;
  const blocoEmpresa = (emp: { nome: string; funcionarios: any[] }) => {
    const v = emp.funcionarios.filter((f) => f.status === "vencida").length;
    const p = emp.funcionarios.filter((f) => f.status === "proxima").length;
    return `<div class="empresa">
      <div class="empresa-topo"><span class="empresa-nome">${emp.nome}</span>
        <span class="empresa-cont">${v ? `<b class="vencida">${v} vencida(s)</b>` : ""}${v && p ? " · " : ""}${p ? `<b class="proxima">${p} próxima(s)</b>` : ""}</span></div>
      <table><thead><tr><th>Código</th><th>Funcionário</th><th>Situação</th><th>Admissão</th><th>Período aquisitivo</th><th>Limite p/ gozo</th><th>Dias em aberto</th></tr></thead>
      <tbody>${emp.funcionarios.map(linhaFunc).join("")}</tbody></table>
    </div>`;
  };
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Helvetica Neue',Arial,sans-serif; color:#1c2b24; margin:0; padding:26px 30px;}
    h1{font-size:17px; margin:0 0 2px;}
    .sub{font-size:11.5px; color:#5b6b63; margin:0 0 14px;}
    .resumo{font-size:12px; margin-bottom:18px;}
    .resumo b.vencida{color:#b23b3b;} .resumo b.proxima{color:#a5730a;}
    .empresa{margin-bottom:16px; break-inside:avoid;}
    .empresa-topo{background:#eef5f1; border-radius:8px 8px 0 0; padding:7px 10px; display:flex; justify-content:space-between; align-items:baseline;}
    .empresa-nome{font-weight:700; font-size:12.5px;}
    .empresa-cont{font-size:10.5px;}
    .empresa-cont b.vencida{color:#b23b3b;} .empresa-cont b.proxima{color:#a5730a;}
    table{width:100%; border-collapse:collapse; font-size:10.5px; border:1px solid #e5eae7; border-top:none;}
    th{text-align:left; background:#f7faf9; padding:5px 8px; border-bottom:1px solid #e5eae7; font-size:9.5px; letter-spacing:.03em; text-transform:uppercase; color:#3c584a;}
    td{padding:5px 8px; border-bottom:1px solid #eef2f0;}
    td.vencida{color:#b23b3b; font-weight:600;}
    td.proxima{color:#a5730a; font-weight:600;}
  </style></head><body>
    <h1>Programação de Férias — Controle interno</h1>
    <p class="sub">${escritorioNome} · gerado em ${new Date().toLocaleDateString("pt-BR")} às ${new Date().toLocaleTimeString("pt-BR")}</p>
    <p class="resumo"><b class="vencida">${totalVencidas} vencida(s)</b> · <b class="proxima">${totalProximas} próxima(s) do limite</b> · ${empresas.length} empresa(s)</p>
    ${empresas.map(blocoEmpresa).join("")}
  </body></html>`;
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle" });
    const pdf = await page.pdf({ format: "A4", landscape: true, printBackground: true, margin: { top: "10px", bottom: "10px", left: "10px", right: "10px" } });
    return pdf as Buffer;
  } finally {
    await browser.close();
  }
}

function funcionariosPendentes(sqlite: any, empresaId: number): any[] {
  return sqlite
    .prepare(`SELECT * FROM ferias_funcionarios WHERE empresa_id = ? AND status IN ('vencida','proxima') ORDER BY status, limite_gozo`)
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
  // [2026-09-29] Esquema da tabela mudou (colunas antigas tinham NOT NULL que não existe mais no
  // layout real do relatório) — criada hoje mais cedo, sem nenhum dado de produção ainda (nenhum PDF
  // de verdade passou por ela até agora). Migração ÚNICA: só derruba se ainda estiver no esquema
  // velho (detectado pela coluna "periodo_aquisitivo_fim", que não existe mais) — depois desta vez,
  // a tabela já nasce certa e este bloco não encontra mais essa coluna, não roda de novo.
  const colsAntigas = (sqlite.prepare(`PRAGMA table_info(ferias_funcionarios)`).all() as any[]).map((c) => c.name);
  if (colsAntigas.includes("periodo_aquisitivo_fim") || colsAntigas.includes("vencto_ferias")) sqlite.exec(`DROP TABLE ferias_funcionarios;`);
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ferias_funcionarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
      codigo TEXT,
      nome TEXT NOT NULL,
      data_admissao TEXT,
      fer_venc INTEGER NOT NULL DEFAULT 0,
      inicio_aquisitivo TEXT,
      fim_aquisitivo TEXT,
      dias_restantes INTEGER,
      limite_gozo TEXT,
      status TEXT NOT NULL, -- 'vencida' | 'proxima'
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
    -- Agendador SEPARADO do de envio acima: controla quando o site relê o que já foi importado em
    -- Relatórios › Programação de Férias (a esteira do Drive já pega arquivo NOVO sozinha em 10s;
    -- isso aqui é pra reconferir/recalcular o que já tem, no dia/hora que o usuário escolher).
    CREATE TABLE IF NOT EXISTS ferias_verificacao_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ativo INTEGER NOT NULL DEFAULT 0,
      dia_mes INTEGER NOT NULL DEFAULT 15,
      hora INTEGER NOT NULL DEFAULT 7,
      minuto INTEGER NOT NULL DEFAULT 0,
      ultima_execucao_em TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  sqlite.prepare(`INSERT OR IGNORE INTO ferias_agendamento_config (id) VALUES (1)`).run();
  sqlite.prepare(`INSERT OR IGNORE INTO ferias_verificacao_config (id) VALUES (1)`).run();

  app.get("/api/ferias/estado", d.blockCliente, d.requirePermissao("dprh", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const visiveis = d.empresasVisiveis(user);
    const cfgEnvio = sqlite.prepare(`SELECT * FROM ferias_agendamento_config WHERE id = 1`).get() as any;
    const cfgVerif = sqlite.prepare(`SELECT * FROM ferias_verificacao_config WHERE id = 1`).get() as any;
    const base = {
      ativo: !!cfgEnvio.ativo, diaMes: cfgEnvio.dia_mes, hora: cfgEnvio.hora, minuto: cfgEnvio.minuto,
      verifAtivo: !!cfgVerif.ativo, verifDiaMes: cfgVerif.dia_mes, verifHora: cfgVerif.hora, verifMinuto: cfgVerif.minuto, verifUltimaEm: cfgVerif.ultima_execucao_em,
    };
    let sql = `SELECT e.id, e.nome, MAX(f.atualizado_em) as atualizadoEm,
        SUM(CASE WHEN f.status='vencida' THEN 1 ELSE 0 END) as vencidas,
        SUM(CASE WHEN f.status='proxima' THEN 1 ELSE 0 END) as proximas
      FROM ferias_funcionarios f JOIN empresas e ON e.id = f.empresa_id
      WHERE f.status IN ('vencida','proxima')`;
    const params: any[] = [];
    if (visiveis !== null) {
      if (!visiveis.length) return res.json({ empresas: [], ...base });
      sql += ` AND e.id IN (${visiveis.map(() => "?").join(",")})`;
      params.push(...visiveis);
    }
    sql += ` GROUP BY e.id ORDER BY vencidas DESC, proximas DESC, e.nome`;
    const empresas = sqlite.prepare(sql).all(...params) as any[];
    for (const emp of empresas) emp.funcionarios = funcionariosPendentes(sqlite, emp.id);
    res.json({ empresas, ...base });
  });
  app.get("/api/ferias/exportar-pdf", d.blockCliente, d.requirePermissao("dprh", "visualizar"), async (req, res) => {
    const user = (req as any).user;
    const visiveis = d.empresasVisiveis(user);
    let sql = `SELECT DISTINCT e.id, e.nome FROM ferias_funcionarios f JOIN empresas e ON e.id = f.empresa_id WHERE f.status IN ('vencida','proxima')`;
    const params: any[] = [];
    if (visiveis !== null) {
      if (!visiveis.length) return res.status(400).json({ error: "Nenhuma pendência de férias pra exportar." });
      sql += ` AND e.id IN (${visiveis.map(() => "?").join(",")})`;
      params.push(...visiveis);
    }
    sql += ` ORDER BY e.nome`;
    const empresasRows = sqlite.prepare(sql).all(...params) as any[];
    if (!empresasRows.length) return res.status(400).json({ error: "Nenhuma pendência de férias pra exportar." });
    const empresas = empresasRows.map((e) => ({ nome: e.nome, funcionarios: funcionariosPendentes(sqlite, e.id) }));
    const escritorio = sqlite.prepare(`SELECT nome FROM escritorios WHERE id = ?`).get(user.escritorioId) as any;
    try {
      const pdf = await gerarPdfControleInterno(escritorio?.nome || "Escritório Contábil", empresas);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="Programacao de Ferias - Controle Interno.pdf"`);
      res.send(pdf);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
  app.post("/api/ferias/config", d.blockCliente, d.requirePermissao("dprh", "editar"), (req, res) => {
    const b = req.body || {};
    const diaMes = Math.min(28, Math.max(1, Number(b.diaMes) || 5));
    const hora = Math.min(23, Math.max(0, Number(b.hora) || 0));
    const minuto = Math.min(59, Math.max(0, Number(b.minuto) || 0));
    sqlite.prepare(`UPDATE ferias_agendamento_config SET ativo = ?, dia_mes = ?, hora = ?, minuto = ?, updated_at = datetime('now') WHERE id = 1`).run(b.ativo ? 1 : 0, diaMes, hora, minuto);
    res.json({ ok: true });
  });
  app.post("/api/ferias/verificacao-config", d.blockCliente, d.requirePermissao("dprh", "editar"), (req, res) => {
    const b = req.body || {};
    const diaMes = Math.min(28, Math.max(1, Number(b.diaMes) || 15));
    const hora = Math.min(23, Math.max(0, Number(b.hora) || 0));
    const minuto = Math.min(59, Math.max(0, Number(b.minuto) || 0));
    sqlite.prepare(`UPDATE ferias_verificacao_config SET ativo = ?, dia_mes = ?, hora = ?, minuto = ?, updated_at = datetime('now') WHERE id = 1`).run(b.ativo ? 1 : 0, diaMes, hora, minuto);
    res.json({ ok: true });
  });
  app.post("/api/ferias/verificar-agora", d.blockCliente, d.requirePermissao("dprh", "postar"), async (req, res) => {
    const user = (req as any).user;
    try {
      const qtd = await d.reprocessarExistentes(user.escritorioId);
      sqlite.prepare(`UPDATE ferias_verificacao_config SET ultima_execucao_em = datetime('now') WHERE id = 1`).run();
      res.json({ ok: true, qtd });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
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

  // Verificação automática: no dia/hora escolhido, relê os "Programação de Férias" já importados
  // (escritorio_id = 1, mesmo padrão de instalação única já usado pelo Robô do Comparativo/NFS-e).
  setInterval(async () => {
    const cfg = sqlite.prepare(`SELECT * FROM ferias_verificacao_config WHERE id = 1`).get() as any;
    if (!cfg?.ativo) return;
    const agora = new Date(Date.now() - 3 * 3600 * 1000);
    if (agora.getDate() !== cfg.dia_mes || agora.getHours() !== cfg.hora || agora.getMinutes() !== cfg.minuto) return;
    try {
      await d.reprocessarExistentes(1);
    } catch (e: any) {
      console.error("[ferias] verificação automática:", e.message);
    }
    sqlite.prepare(`UPDATE ferias_verificacao_config SET ultima_execucao_em = datetime('now') WHERE id = 1`).run();
  }, 60_000).unref();

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
