// Central de Envio de Documentos por setor (CRM, DP/RH, Contabilidade, Fiscal).
// Lê PDFs de pastas do Google Drive do escritório (conta de serviço, só leitura), identifica o tipo (Rescisão, Holerite…)
// pelas palavras-chave que o admin cadastra, acha a empresa pelo CNPJ dentro do PDF e coloca tudo em "Pendentes de envio".
// O envio (WhatsApp/e-mail) é sempre por clique e cada envio vira uma linha nova em "Enviados" — nada é sobrescrito.
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type express from "express";
import { PDFDocument } from "pdf-lib";
import { gerarPdfDeHtml } from "./contratos";

export const SETORES_CENTRAL = ["crm", "dprh", "contabil", "fiscal"] as const;
type Setor = (typeof SETORES_CENTRAL)[number];

type Deps = {
  sqlite: any;
  blockCliente: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  abaConfigPermitida: (user: any) => boolean; // Administrador, ou Colaborador com a aba "Envio de documentos" liberada em Usuários
  hasPermissao: (user: any, modulo: any, acao: "visualizar" | "postar" | "editar") => boolean;
  cifrar: (s: string) => string;
  decifrar: (s: string) => string;
  uploadsDir: string;
  enviarEmail: (escritorioId: number, msg: any) => Promise<any>;
  // canal: "conversa" (número de atendimento, deskcomm) ou "meta" (API oficial da Meta, número separado) —
  // veio direto do body do pedido de envio (o usuário escolhe na hora, dois botões na tela).
  enviarWhatsapp: (escritorioId: number, telefone: string, vars: { nome: string; valor: string }[], arquivo: { nome: string; tipo: string; buffer: Buffer }, origem: { tabela: "central_envio_enviados"; id: number }, canal: string) => Promise<void>;
  mapaDocumentos: (escritorioId: number) => { porDocumento: Map<string, any>; porCodigo: Map<string, any> };
  identificarEmpresa: (mapa: { porDocumento: Map<string, any>; porCodigo: Map<string, any> }, texto: string, nomeArquivo: string) => { empresa: any | null; cnpjDetectado: string | null };
  extrairPeriodo: (texto: string, nomeArquivo: string) => { inicio: string; fim: string } | null;
  pdfParse: (buf: Buffer) => Promise<{ text: string }>;
};

const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const nomeArquivoSeguro = (s: string) => String(s || "documento").replace(/[\\/:*?"<>|\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);

// ---------------------------------------------------------------- Google Drive (conta de serviço, somente leitura)
export type Cred = { client_email: string; private_key: string };
const tokens = new Map<number, { token: string; ate: number }>();

export async function tokenDrive(escId: number, cred: Cred): Promise<string> {
  const c = tokens.get(escId);
  if (c && c.ate > Date.now() + 60_000) return c.token;
  const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const agora = Math.floor(Date.now() / 1000);
  const corpo = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: cred.client_email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: "https://oauth2.googleapis.com/token", iat: agora, exp: agora + 3600 })}`;
  const assinatura = crypto.createSign("RSA-SHA256").update(corpo).sign(cred.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${corpo}.${assinatura}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(`Google recusou a chave da conta de serviço: ${j.error_description || j.error || r.status}`);
  tokens.set(escId, { token: j.access_token, ate: Date.now() + (j.expires_in || 3600) * 1000 });
  return j.access_token;
}
export async function driveGet(escId: number, cred: Cred, caminho: string, params: Record<string, string> = {}): Promise<any> {
  const t = await tokenDrive(escId, cred);
  const qs = new URLSearchParams({ supportsAllDrives: "true", includeItemsFromAllDrives: "true", ...params });
  const r = await fetch(`https://www.googleapis.com/drive/v3/${caminho}?${qs}`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(30_000) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Google Drive: ${j.error?.message || r.status}`);
  return j;
}
export async function driveBaixar(escId: number, cred: Cred, id: string): Promise<Buffer> {
  const t = await tokenDrive(escId, cred);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`Google Drive: não consegui baixar o arquivo (${r.status}).`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------------------------------------------------------------- leitura do PDF
// Títulos e rótulos dos modelos (nunca são nome de pessoa): "PROVENTOS E DESCONTOS", "BASE PARA CÁLCULO", "RECIBO DE FÉRIAS"…
const PALAVRAS_DE_TITULO = /PROVENTO|DESCONTO|\bBASE\b|CALCULO|\bTOTAL\b|LIQUIDO|PERIODO|NOTIFICACAO|FERIAS|RECIBO|AVISO|PREVIO|SALARIO|VENCIMENTO|REFERENCIA|DESCRICAO|CODIGO|FOLHA|MENSAL|TERMO|RESCISAO|CONTRATO|TRABALHO|EMPREGADOR|IDENTIFICACAO|DISCRIMINACAO|VERBAS|DEDUCOES|ADIANTAMENTO|HOLERITE|PAGAMENTO|ABONO|AQUISICAO|GOZO|CIENTE|\bDATA\b|VALOR|RUBRICA|CATEGORIA|TRABALHADOR|ASSINATURA|FUNCIONARIO|DEPARTAMENTO|ADMISSAO|CARGO|FILIAL|MATRICULA|DEPOSITO|SAQUE|BANCO/;
const NOME_VALOR = "([A-ZÀ-Ú][A-ZÀ-Ú'.]*(?:[ ]+[A-ZÀ-Ú'.]+){1,8})";
export function extrairColaboradorECpf(texto: string, ehEmpresa: (nomeNormalizado: string) => boolean = () => false): { colaborador: string | null; cpf: string | null } {
  const cpfRot = /CPF[\s\S]{0,60}?(\d{3}\.\d{3}\.\d{3}-\d{2})/.exec(texto);
  const cpf = (cpfRot && cpfRot[1]) || (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.exec(texto) || [])[0] || null;
  // Nomes de pessoas vêm em MAIÚSCULAS nesses modelos; rótulos como "Número Carteira Profissional" (maiúscula/minúscula) não passam.
  const ruim = (v: string) => !/^[A-ZÀ-Ú][A-ZÀ-Ú'. ]{4,70}$/.test(v) || v.trim().split(/\s+/).length < 2 || /LTDA|EMPRESA|CNPJ|EIRELI|\bME\b|ENDERE|BAIRRO|MUNIC|CARTEIRA|S[ÉE]RIE/.test(v) || PALAVRAS_DE_TITULO.test(norm(v));
  // Junta TODOS os nomes de pessoa achados (PDF com vários recibos/holerites): mais de um nome diferente vira "Vários".
  const achados = new Map<string, string>();
  const guardar = (v: string) => { const t = v.replace(/\s+/g, " ").trim(); if (!ruim(t) && !ehEmpresa(norm(t))) achados.set(norm(t), t); }; // nome de empresa cadastrada nunca é nome de trabalhador
  // 1) Modelos numerados (ex.: Termo de Rescisão: "11 Nome" seguido do nome, mesmo com a célula ao lado na mesma linha)
  for (const m of texto.matchAll(new RegExp("(?<!\\d)\\d{1,2}\\s*Nome(?!\\s*d[ao]\\s*(?:M|P|Soc|Empr))\\s*[:\\-–]?\\s*" + NOME_VALOR, "g"))) guardar(m[1]);
  // Contrato de Experiência (texto corrido, sem rótulo "Nome"): "...designada EMPREGADORA e\nFULANO DA SILVA portador..."
  // Sem esse regex específico, o rótulo "EMPREGADO" da etapa 2 casava colado em "EMPREGADORA" (PDF sem espaço entre as
  // duas palavras na linha de assinatura) e devolvia o título "T E R M O DE PRORROGAÇÃO" em vez do nome do funcionário.
  const contratoExp = new RegExp("EMPREGADORA\\s+e\\s+" + NOME_VALOR + "\\s+portador", "i").exec(texto);
  if (contratoExp) guardar(contratoExp[1]);
  // Campo numerado "11 Nome" ou o do Contrato de Experiência achado: é ele — não mistura com o resto do texto.
  if (achados.size) { const n = [...achados.values()]; return { colaborador: n.length > 1 ? "Vários" : n[0], cpf: n.length > 1 ? null : cpf }; }
  // 2) Rótulo no começo da linha: "Nome do Funcionário: FULANO", "Nome do empregado", "Empregado", "Colaborador"…
  const linhas = texto.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rotulo = /^(?:\d{1,2}\s*)?(?:NOME(?:\s+DO)?(?:\s+(?:FUNCION[ÁA]RIO|EMPREGADO|COLABORADOR|TRABALHADOR))?(?!\s+D[AO]\s+(?:M[ÃA]E|PAI))|FUNCION[ÁA]RIO|EMPREGADO|COLABORADOR|TRABALHADOR)\s*[:\-–]?\s*(.*)$/i;
  const limpar = (v: string) => v.replace(/^[\d\s.\-–:]+/, "").replace(/\d.*$/, "").replace(/\s{2,}.*/, "").replace(/\s+(CPF|CTPS|PIS|CBO|ADMISS|CARGO|MATR).*$/i, "").trim();
  for (let i = 0; i < linhas.length; i++) {
    const m = rotulo.exec(linhas[i]);
    if (!m) continue;
    for (const cand of [m[1], linhas[i + 1] || "", linhas[i + 2] || "", linhas[i + 3] || "", linhas[i + 4] || ""]) {
      const v = limpar(cand || "");
      if (!ruim(v)) { guardar(v); break; }
    }
  }
  // 3) Sem rótulo reconhecível: o nome do trabalhador costuma se repetir (campo do nome, "CIENTE", assinatura). Vale a linha em
  //    MAIÚSCULAS que se repete 2+ vezes — nunca a da empresa nem títulos do modelo.
  if (!achados.size) {
    const cont = new Map<string, { nome: string; n: number }>();
    for (const l of linhas) {
      const v = l.replace(/\d.*$/, "").replace(/\s+/g, " ").trim();
      if (ruim(v)) continue;
      const c = cont.get(norm(v)) || { nome: v, n: 0 };
      c.n++;
      cont.set(norm(v), c);
    }
    // só o mais repetido (repetições de cidade/bairro não viram "Vários")
    const top = [...cont.values()].sort((x, y) => y.n - x.n)[0];
    if (top && top.n >= 2) achados.set(norm(top.nome), top.nome);
  }
  const nomes = [...achados.values()];
  return { colaborador: nomes.length > 1 ? "Vários" : nomes[0] || null, cpf: nomes.length > 1 ? null : cpf };
}
// Data do fato gerador do documento: na rescisão é a "Data de Afastamento" (campo 26). O texto do PDF pode vir com cada
// rótulo seguido do seu valor OU com a linha de rótulos e depois a linha de valores — os dois jeitos são tratados.
export function extrairDataAfastamento(texto: string): string | null {
  const D = "\\d{2}\\s*\\/\\s*\\d{2}\\s*\\/\\s*\\d{4}";
  const limpaData = (x: string) => x.replace(/\s+/g, "");
  // Sequências de 1 a 4 datas coladas ou separadas por espaço/linha ("20/03/202608/09/202608/09/2026")
  const corridas = [...texto.matchAll(new RegExp(`${D}(?:\\s*${D}){0,3}`, "g"))].map((m) => ({ pos: m.index || 0, datas: (m[0].match(new RegExp(D, "g")) || []).map(limpaData) }));
  const doGrupo = (datas: string[]) => (datas.length >= 3 ? datas[2] : datas[datas.length - 1]); // ordem do modelo: admissão, aviso prévio, afastamento
  // A) campo 24 "Data de Admissão": os valores dos campos 24, 25 e 26 vêm em sequência — a 3ª é a data de afastamento
  const adm = /Data\s+de\s+Admiss[ãa]o/i.exec(texto);
  if (adm) {
    const depois = corridas.find((c) => c.pos > adm.index && c.datas.length >= 2);
    if (depois) return doGrupo(depois.datas);
    const antes = [...corridas].reverse().find((c) => c.pos < adm.index && c.datas.length >= 3);
    if (antes) return doGrupo(antes.datas);
  }
  // B) rótulo "Data de Afastamento": valor logo depois dele, ou (rótulos em linha e valores na seguinte) a última data da sequência
  const rot = /Data\s+de\s+Afastamento/i.exec(texto);
  if (!rot) return null;
  const depois = corridas.find((c) => c.pos > rot.index);
  if (!depois) return null;
  const entre = texto.slice(rot.index + rot[0].length, depois.pos);
  if (!/Cod\.?\s*Afastamento|Pens[ãa]o|Categoria|\d{2}\s+[A-Z]/i.test(entre)) return depois.datas[0]; // rótulo e valor juntos
  return depois.datas[depois.datas.length - 1];
}
// "Competência: 08/2026", "Mês/Ano: 08/2026", "Referente a 08/2026" e "Agosto de 2026" (folha mensal); nas férias, o período de gozo.
const MESES_NOME = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
export function extrairCompetenciaMes(texto: string): string | null {
  // O período de gozo é o único que vem com "= N Dias" (o de aquisição não); funciona mesmo com as datas coladas.
  // Vários períodos diferentes no mesmo PDF (vários recibos) → "Vários".
  const gozos = [...texto.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*A\s*(\d{2}\/\d{2}\/\d{4})\s*=\s*\d+\s*Dias/gi)].map((g) => `${g[1]} a ${g[2]}`);
  if (gozos.length) return new Set(gozos).size > 1 ? "Vários" : gozos[0];
  const gozo = /Gozo\s+d[ao]s?\s+F[ée]rias\s*[:\-]?\s*(\d{2}\/\d{2}\/\d{4})\s*A\s*(\d{2}\/\d{2}\/\d{4})/i.exec(texto);
  if (gozo) return `${gozo[1]} a ${gozo[2]}`;
  const m = /(?:Compet[êe]ncia|M[êe]s\s*\/?\s*Ano|Refer[êe]ncia|Referente\s+a)\s*[:\-]?\s*(?:\d{2}\/)?(0[1-9]|1[0-2])\/(20\d{2})\b/i.exec(texto);
  if (m) return `${m[1]}/${m[2]}`;
  // Cabeçalho do "EXTRATO MENSAL" (Folha Mensal e Complementar): o pdf-parse embaralha rótulo e valor
  // do cabeçalho — "09/2026" aparece ANTES do próprio rótulo "Competência:", logo antes de "Empresa:"
  // ("...EXTRATO MENSAL\nTodos\n09/2026\nEmpresa:\nCompetência:..."). O regex acima (rótulo seguido do
  // valor) nunca bate nesse formato — sem isso caía pra data de afastamento de outro funcionário no
  // resto do documento (achado ao vivo: extrato de 09/2026 saindo com competência 12/2027).
  const cabecalhoExtrato = /^[\s\S]{0,250}?\b(0[1-9]|1[0-2])\/(20\d{2})\b[\s\S]{0,120}?Empresa\s*:/i.exec(texto);
  if (cabecalhoExtrato) return `${cabecalhoExtrato[1]}/${cabecalhoExtrato[2]}`;
  // "Agosto de 2026" — mas não "08 de setembro de 2026" (data por extenso de um documento qualquer)
  const nomes = /(?<!\d\s{0,3}de\s{0,3})(janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(20\d{2})/i.exec(texto);
  if (nomes) { const i = MESES_NOME.indexOf(nomes[1].toLowerCase().replace("ç", "c")); if (i >= 0) return `${String(i + 1).padStart(2, "0")}/${nomes[2]}`; }
  return null;
}
const rotuloCompetencia = (p: { inicio: string; fim: string } | null): string | null => {
  const f = p?.fim || p?.inicio;
  return f && /^\d{4}-\d{2}/.test(f) ? `${f.slice(5, 7)}/${f.slice(0, 4)}` : null;
};

// Credencial do Drive já configurada em Configurações › Envio de documentos — reaproveitada por outras
// ferramentas do sistema (ex.: importação de certificados digitais) pra não pedir uma segunda conexão.
export function credencialDriveDoEscritorio(sqlite: any, decifrar: (s: string) => string, escritorioId: number): Cred | null {
  const c = sqlite.prepare(`SELECT sa_json_cifrado FROM central_envio_config WHERE escritorio_id = ?`).get(escritorioId) as any;
  if (!c?.sa_json_cifrado) return null;
  try {
    const j = JSON.parse(decifrar(c.sa_json_cifrado));
    return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null;
  } catch {
    return null;
  }
}
export function registerCentralEnvio(app: express.Express, d: Deps) {
  const db = d.sqlite;
  db.exec(`
    CREATE TABLE IF NOT EXISTS central_envio_config (
      escritorio_id INTEGER PRIMARY KEY, sa_json_cifrado TEXT, sa_email TEXT, ultimo_erro TEXT, ultima_varredura TEXT, dias_inicial INTEGER NOT NULL DEFAULT 30
    );
    CREATE TABLE IF NOT EXISTS central_envio_pastas (
      id INTEGER PRIMARY KEY AUTOINCREMENT, escritorio_id INTEGER NOT NULL, setor TEXT NOT NULL, user_id INTEGER, pasta_id TEXT NOT NULL, pasta_nome TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (escritorio_id, setor, user_id, pasta_id)
    );
    CREATE TABLE IF NOT EXISTS central_envio_tipos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, escritorio_id INTEGER NOT NULL, setor TEXT NOT NULL, nome TEXT NOT NULL, palavras_json TEXT NOT NULL DEFAULT '[]',
      exige_todas INTEGER NOT NULL DEFAULT 1, texto_whatsapp TEXT, ativo INTEGER NOT NULL DEFAULT 1, ordem INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS central_envio_docs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, escritorio_id INTEGER NOT NULL, setor TEXT NOT NULL, user_id INTEGER, pasta_id TEXT, drive_file_id TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL, modificado_em TEXT, md5 TEXT NOT NULL, tamanho INTEGER, tipo_id INTEGER, tipo_nome TEXT, empresa_id INTEGER, cnpj TEXT,
      colaborador_nome TEXT, cpf TEXT, competencia TEXT, titulo TEXT NOT NULL, arquivo_path TEXT NOT NULL, versao INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pendente', criado_em TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (escritorio_id, drive_file_id, md5)
    );
    CREATE INDEX IF NOT EXISTS idx_central_docs_status ON central_envio_docs(escritorio_id, setor, status);
    CREATE TABLE IF NOT EXISTS central_envio_enviados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id INTEGER, escritorio_id INTEGER NOT NULL, empresa_id INTEGER, empresa_nome TEXT, setor TEXT, tipo_nome TEXT, titulo TEXT,
      colaborador_nome TEXT, competencia TEXT, canal TEXT NOT NULL, destino TEXT, enviado_por INTEGER, enviado_por_nome TEXT, enviado_em TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL, erro TEXT, arquivo_path TEXT
    );
    CREATE TABLE IF NOT EXISTS central_envio_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, escritorio_id INTEGER NOT NULL, drive_file_id TEXT NOT NULL, nome TEXT, pasta TEXT, motivo TEXT NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (escritorio_id, drive_file_id, motivo)
    );
    CREATE TABLE IF NOT EXISTS central_envio_agendados (
      id INTEGER PRIMARY KEY AUTOINCREMENT, escritorio_id INTEGER NOT NULL, doc_id INTEGER NOT NULL, agendado_para TEXT NOT NULL,
      canais_json TEXT NOT NULL, telefones_json TEXT NOT NULL DEFAULT '[]', emails_json TEXT NOT NULL DEFAULT '[]',
      criado_por INTEGER, criado_por_nome TEXT, status TEXT NOT NULL DEFAULT 'agendado', erro TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')), executado_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_central_agend ON central_envio_agendados(status, agendado_para);
    CREATE INDEX IF NOT EXISTS idx_central_env_empresa ON central_envio_enviados(escritorio_id, empresa_id, enviado_em);
  `);

  const colsDocs = (db.prepare(`PRAGMA table_info(central_envio_docs)`).all() as any[]).map((c) => c.name);
  for (const [col, ddl] of [["texto_amostra", "TEXT"], ["grupo_id", "INTEGER"], ["e_grupo", "INTEGER NOT NULL DEFAULT 0"], ["grupo_chave", "TEXT"], ["n_arquivos", "INTEGER NOT NULL DEFAULT 1"]] as const)
    if (!colsDocs.includes(col)) db.exec(`ALTER TABLE central_envio_docs ADD COLUMN ${col} ${ddl}`);
  if (!(db.prepare(`PRAGMA table_info(central_envio_tipos)`).all() as any[]).some((c) => c.name === "agrupar")) db.exec(`ALTER TABLE central_envio_tipos ADD COLUMN agrupar INTEGER NOT NULL DEFAULT 0`);
  for (const [tab, col, ddl] of [
    ["central_envio_enviados", "entrega_ref", "INTEGER"], ["central_envio_agendados", "extras_json", "TEXT NOT NULL DEFAULT '[]'"],
    ["central_envio_agendados", "canal_whatsapp", "TEXT NOT NULL DEFAULT 'conversa'"],
  ] as const) if (!(db.prepare(`PRAGMA table_info(${tab})`).all() as any[]).some((c) => c.name === col)) db.exec(`ALTER TABLE ${tab} ADD COLUMN ${col} ${ddl}`);
  // Correção pontual de rótulo (pedida): um título do PDF ("PROVENTOS E DESCONTOSBASE PARA CÁLCULO") foi lido como nome de colaborador.
  // Só o texto do título/nome nas listas é ajustado; datas, destinatários e status dos envios não mudam. Idempotente.
  for (const tabela of ["central_envio_enviados", "central_envio_docs"]) {
    db.prepare(`UPDATE ${tabela} SET titulo = REPLACE(titulo, ' - PROVENTOS E DESCONTOSBASE PARA CÁLCULO', ''), colaborador_nome = NULL WHERE colaborador_nome LIKE 'PROVENTOS E DESCONTOS%' OR titulo LIKE '%PROVENTOS E DESCONTOSBASE PARA CÁLCULO%'`).run();
  }
  // ------------------------------------------------------------ configuração / credencial
  const credDe = (escId: number): Cred | null => {
    const c = db.prepare(`SELECT sa_json_cifrado FROM central_envio_config WHERE escritorio_id = ?`).get(escId) as any;
    if (!c?.sa_json_cifrado) return null;
    try { const j = JSON.parse(d.decifrar(c.sa_json_cifrado)); return j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key } : null; } catch { return null; }
  };
  const semAcesso = (res: express.Response) => res.status(403).json({ error: "Você não tem permissão para fazer isso." });
  const setorValido = (v: any): Setor | null => ((SETORES_CENTRAL as readonly string[]).includes(String(v)) ? (String(v) as Setor) : null);

  // ------------------------------------------------------------ varredura
  const emVarredura = new Set<number>();
  const varreduraManual = new Set<number>(); // leitura pedida pela pessoa (só ela mostra "Lendo…" na tela)
  // Descobre a qual pasta configurada (raiz) um PDF pertence subindo pelos "pais" — só das pastas dos arquivos que mudaram,
  // em vez de listar todas as subpastas do Drive (que podem ser milhares). O caminho de cada pasta fica em cache.
  const paisCache = new Map<string, { pai: string | null; nome: string; em: number }>();
  const registrarLog = (escId: number, fileId: string, nome: string, pasta: string, motivo: string) =>
    db.prepare(`INSERT OR IGNORE INTO central_envio_log (escritorio_id, drive_file_id, nome, pasta, motivo) VALUES (?, ?, ?, ?, ?)`).run(escId, fileId, nome, pasta, motivo.slice(0, 300));
  async function raizDaPasta(escId: number, cred: Cred, pastaId: string, raizes: Map<string, { pastaId: string; setor: string; userId: number | null }>) {
    let atual: string | null = pastaId;
    for (let n = 0; atual && n < 15; n++) {
      const r = raizes.get(atual);
      if (r) return r;
      const chave = `${escId}:${atual}`;
      let c = paisCache.get(chave);
      if (!c || Date.now() - c.em > 30 * 60_000) {
        const f: any = await driveGet(escId, cred, `files/${encodeURIComponent(atual)}`, { fields: "id,name,parents" });
        c = { pai: (f.parents && f.parents[0]) || null, nome: f.name || "", em: Date.now() };
        paisCache.set(chave, c);
      }
      atual = c.pai;
    }
    return null;
  }

  async function analisarPdf(escId: number, setor: string, buf: Buffer, nomeArquivo: string) {
    let texto = "";
    try { texto = (await d.pdfParse(buf)).text || ""; } catch { /* PDF de imagem/protegido: cai em "sem tipo" */ }
    const tipos = db.prepare(`SELECT * FROM central_envio_tipos WHERE escritorio_id = ? AND ativo = 1 AND (setor = ? OR setor = 'crm') ORDER BY (setor = ?) DESC, ordem, id`).all(escId, setor, setor) as any[];
    const tn = norm(texto);
    const tipo = tipos.find((t) => {
      const ps: string[] = JSON.parse(t.palavras_json || "[]").map(norm).filter(Boolean);
      return ps.length && (t.exige_todas ? ps.every((p) => tn.includes(p)) : ps.some((p) => tn.includes(p)));
    });
    let { empresa, cnpjDetectado } = d.identificarEmpresa(d.mapaDocumentos(escId), texto, nomeArquivo);
    // Documentos sem CNPJ (aviso/recibo de férias): acha a empresa pelo NOME dentro do texto (o mais longo que aparecer).
    if (!empresa) {
      const flat = norm(texto).replace(/\s+/g, " ");
      let melhor: any = null;
      for (const e of db.prepare(`SELECT id, nome FROM empresas WHERE escritorio_id = ? AND ativo = 1`).all(escId) as any[]) {
        const n = norm(e.nome).replace(/\s+/g, " ").trim();
        if (n.length >= 8 && flat.includes(n) && (!melhor || n.length > melhor.len)) melhor = { id: e.id, nome: e.nome, len: n.length };
      }
      if (melhor) empresa = { id: melhor.id, nome: melhor.nome };
    }
    const nomesEmpresas = (db.prepare(`SELECT nome FROM empresas WHERE escritorio_id = ?`).all(escId) as any[]).map((e) => norm(e.nome).replace(/\s+/g, " ").trim()).filter((n) => n.length >= 6);
    const { colaborador, cpf } = extrairColaboradorECpf(texto, (n) => nomesEmpresas.some((e) => e === n || (n.length >= 8 && e.includes(n)) || n.includes(e)));
    // extrairCompetenciaMes primeiro: quando o PDF tem um rótulo explícito "Competência: MM/AAAA" (caso do Extrato
    // Mensal/Folha Mensal), ele é a fonte mais confiável e deve valer sempre. extrairDataAfastamento foi feita pra
    // Rescisão (documento organizado por datas, sem rótulo de competência) — mas um Extrato Mensal "e Complementar"
    // pode incluir a rescisão de um funcionário demitido no meio do texto, com "Data de Admissão"/"Data de
    // Afastamento" dele; antes disso rodava primeiro e sequestrava a competência do documento inteiro (achado ao
    // vivo: extrato de 09/2026 saindo com competência 12/2027, puxada de uma data de afastamento de outro
    // funcionário nas páginas seguintes do mesmo PDF).
    const competencia = extrairCompetenciaMes(texto) || extrairDataAfastamento(texto) || rotuloCompetencia(d.extrairPeriodo(texto, nomeArquivo));
    const titulo = [tipo?.nome || String(nomeArquivo).replace(/\.pdf$/i, ""), colaborador, empresa?.nome, competencia].filter(Boolean).join(" - ");
    return { texto, agrupar: !!tipo?.agrupar, tipoId: tipo?.id ?? null, tipoNome: tipo?.nome ?? null, empresaId: empresa?.id ?? null, cnpj: cnpjDetectado, colaborador, cpf, competencia, titulo };
  }
  async function mesclarPdfs(caminhos: string[]): Promise<Buffer> {
    const saida = await PDFDocument.create();
    for (const c of caminhos) {
      const origem = await PDFDocument.load(fs.readFileSync(c), { ignoreEncryption: true });
      for (const pg of await saida.copyPages(origem, origem.getPageIndices())) saida.addPage(pg);
    }
    return Buffer.from(await saida.save());
  }
  async function agruparNoPendente(escId: number, filhoId: number, a: any, raiz: { setor: string; userId: number | null; pastaId: string }) {
    const chave = `${a.tipoId}:${a.empresaId}:${a.competencia}`;
    const filho = db.prepare(`SELECT * FROM central_envio_docs WHERE id = ?`).get(filhoId) as any;
    let pai = db.prepare(`SELECT * FROM central_envio_docs WHERE escritorio_id = ? AND e_grupo = 1 AND grupo_chave = ? AND status = 'pendente'`).get(escId, chave) as any;
    const jaEnviado = !pai && (db.prepare(`SELECT 1 FROM central_envio_docs WHERE escritorio_id = ? AND e_grupo = 1 AND grupo_chave = ? AND status = 'enviado'`).get(escId, chave) as any);
    const empresa = db.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(a.empresaId) as any;
    const titulo = `${a.tipoNome} - ${empresa?.nome || ""} - ${a.competencia}${jaEnviado ? " (complemento)" : ""}`;
    if (!pai) {
      const dir = path.join(d.uploadsDir, "central-envio", String(escId));
      const info = db.prepare(
        `INSERT INTO central_envio_docs (escritorio_id, setor, user_id, pasta_id, drive_file_id, nome_arquivo, md5, tipo_id, tipo_nome, empresa_id, cnpj, competencia, titulo, arquivo_path, e_grupo, grupo_chave, n_arquivos)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`
      ).run(escId, raiz.setor, raiz.userId, raiz.pastaId, `grupo:${chave}:${Date.now()}`, `${a.tipoNome} ${a.competencia.replace("/", "-")}.pdf`, `g${Date.now()}`, a.tipoId, a.tipoNome, a.empresaId, a.cnpj, a.competencia, titulo, path.join(dir, `grupo-${Date.now()}.pdf`), chave);
      pai = db.prepare(`SELECT * FROM central_envio_docs WHERE id = ?`).get(Number(info.lastInsertRowid));
    }
    // Se o MESMO arquivo do Drive foi alterado, a versão antiga sai do grupo (não entra duas vezes no PDF).
    db.prepare(`UPDATE central_envio_docs SET status = 'substituido' WHERE grupo_id = ? AND drive_file_id = ? AND id != ?`).run(pai.id, filho.drive_file_id, filho.id);
    db.prepare(`UPDATE central_envio_docs SET grupo_id = ?, status = 'agrupado' WHERE id = ?`).run(pai.id, filho.id);
    const filhos = db.prepare(`SELECT arquivo_path, nome_arquivo FROM central_envio_docs WHERE grupo_id = ? AND status = 'agrupado' ORDER BY nome_arquivo COLLATE NOCASE, id`).all(pai.id) as any[];
    const pdf = await mesclarPdfs(filhos.map((f) => f.arquivo_path));
    fs.mkdirSync(path.dirname(pai.arquivo_path), { recursive: true });
    fs.writeFileSync(pai.arquivo_path, pdf);
    db.prepare(`UPDATE central_envio_docs SET n_arquivos = ?, tamanho = ?, titulo = ?, modificado_em = datetime('now') WHERE id = ?`).run(filhos.length, pdf.length, titulo, pai.id);
  }
  async function processarArquivo(escId: number, cred: Cred, arq: any, raiz: { pastaId: string; setor: string; userId: number | null }) {
    const md5 = arq.md5Checksum || `${arq.modifiedTime}-${arq.size}`;
    if (db.prepare(`SELECT 1 FROM central_envio_docs WHERE escritorio_id = ? AND drive_file_id = ? AND md5 = ?`).get(escId, arq.id, md5)) return false;
    if (Number(arq.size) > 40 * 1024 * 1024) { registrarLog(escId, arq.id, arq.name, "", "Arquivo maior que 40 MB — não é lido."); return false; }
    const buf = await driveBaixar(escId, cred, arq.id);
    const a = await analisarPdf(escId, raiz.setor, buf, arq.name);
    const versao = ((db.prepare(`SELECT COUNT(*) n FROM central_envio_docs WHERE escritorio_id = ? AND drive_file_id = ?`).get(escId, arq.id) as any).n || 0) + 1;
    const dir = path.join(d.uploadsDir, "central-envio", String(escId));
    fs.mkdirSync(dir, { recursive: true });
    const destino = path.join(dir, `${Date.now()}-${md5.slice(0, 12)}.pdf`);
    fs.writeFileSync(destino, buf);
    const info = db.prepare(
      `INSERT INTO central_envio_docs (escritorio_id, setor, user_id, pasta_id, drive_file_id, nome_arquivo, modificado_em, md5, tamanho, tipo_id, tipo_nome, empresa_id, cnpj, colaborador_nome, cpf, competencia, titulo, arquivo_path, versao, texto_amostra)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(escId, raiz.setor, raiz.userId, raiz.pastaId, arq.id, arq.name, arq.modifiedTime, md5, buf.length, a.tipoId, a.tipoNome, a.empresaId, a.cnpj, a.colaborador, a.cpf, a.competencia, a.titulo, destino, versao, a.texto.slice(0, 8000));
    // Tipos com "juntar num PDF só" (ex.: Folha Mensal): todos os arquivos da mesma empresa + competência viram UM pendente.
    if (a.agrupar && a.empresaId && a.competencia && /^\d{2}\/\d{4}$/.test(a.competencia)) await agruparNoPendente(escId, Number(info.lastInsertRowid), a, raiz);
    return true;
  }

  async function varrer(escId: number, opts: { dias?: number } = {}): Promise<{ novos: number }> {
    const cred = credDe(escId);
    if (!cred || emVarredura.has(escId)) return { novos: 0 };
    if (!db.prepare(`SELECT 1 FROM central_envio_pastas WHERE escritorio_id = ?`).get(escId)) return { novos: 0 };
    emVarredura.add(escId);
    if (opts.dias) varreduraManual.add(escId);
    try {
      const cfg = db.prepare(`SELECT ultima_varredura, dias_inicial FROM central_envio_config WHERE escritorio_id = ?`).get(escId) as any;
      const inicioMs = opts.dias ? Date.now() - opts.dias * 86400000 : cfg?.ultima_varredura ? new Date(cfg.ultima_varredura).getTime() - 10 * 60_000 : Date.now() - (cfg?.dias_inicial || 30) * 86400000;
      const desde = new Date(inicioMs).toISOString();
      const inicioVarredura = new Date().toISOString();
      const raizes = new Map<string, { pastaId: string; setor: string; userId: number | null }>();
      for (const r of db.prepare(`SELECT pasta_id, setor, user_id FROM central_envio_pastas WHERE escritorio_id = ?`).all(escId) as any[]) raizes.set(r.pasta_id, { pastaId: r.pasta_id, setor: r.setor, userId: r.user_id ?? null });
      let novos = 0, pagina: string | undefined;
      do {
        const j = await driveGet(escId, cred, "files", { q: `mimeType='application/pdf' and trashed=false and (modifiedTime > '${desde}' or createdTime > '${desde}')`, orderBy: "modifiedTime", pageSize: "100", fields: "nextPageToken,files(id,name,parents,modifiedTime,createdTime,md5Checksum,size)", ...(pagina ? { pageToken: pagina } : {}) });
        for (const a of j.files || []) {
          let raiz: any = null;
          for (const p of a.parents || []) { raiz = await raizDaPasta(escId, cred, p, raizes); if (raiz) break; }
          if (!raiz) {
            // Só registra arquivos recentes (o Drive da conta de serviço enxerga tudo que foi compartilhado com ela)
            if (Date.now() - new Date(a.createdTime || a.modifiedTime).getTime() < 3 * 86400000) {
              const paiNome = (a.parents || []).map((p: string) => paisCache.get(`${escId}:${p}`)?.nome).find(Boolean) || "";
              registrarLog(escId, a.id, a.name, paiNome, "Está numa pasta que NÃO é uma das pastas lidas. Escolha essa pasta (ou a pasta de cima) em Minha pasta / Configurações › Envio de documentos.");
            }
            continue;
          }
          try { if (await processarArquivo(escId, cred, a, raiz)) novos++; } catch (e: any) { console.error(`[central-envio] ${a.name}:`, e.message); registrarLog(escId, a.id, a.name, "", `Erro ao ler o arquivo: ${e.message}`); }
        }
        pagina = j.nextPageToken;
      } while (pagina);
      db.prepare(`UPDATE central_envio_config SET ultima_varredura = ?, ultimo_erro = NULL WHERE escritorio_id = ?`).run(inicioVarredura, escId);
      return { novos };
    } catch (e: any) {
      db.prepare(`UPDATE central_envio_config SET ultimo_erro = ? WHERE escritorio_id = ?`).run(String(e.message).slice(0, 300), escId);
      return { novos: 0 };
    } finally { emVarredura.delete(escId); varreduraManual.delete(escId); }
  }
  setInterval(async () => {
    for (const r of db.prepare(`SELECT escritorio_id FROM central_envio_config WHERE sa_json_cifrado IS NOT NULL`).all() as any[]) await varrer(r.escritorio_id).catch(() => {});
  }, 10_000).unref();

  // Quem recebe a aba "Envio de documentos" em Configurações (Usuários › Abas de Configurações) pode montar os modelos (tipos) e as
  // pastas dos setores a que tem acesso. A chave do Google (conexão) continua só do Administrador.
  const gerir: express.RequestHandler = (req, res, next) => ((req as any).user && d.abaConfigPermitida((req as any).user) ? next() : void res.status(403).json({ error: "Você não tem acesso a esta aba de Configurações." }));
  const setorDoUsuario = (user: any, setor: string) => user.perfil === "Administrador" || d.hasPermissao(user, setor, "visualizar");
  // ------------------------------------------------------------ rotas: conexão, pastas, tipos
  app.get("/api/central-envio/config", d.blockCliente, gerir, (req, res) => {
    const c = db.prepare(`SELECT sa_email, ultimo_erro, ultima_varredura, dias_inicial, sa_json_cifrado IS NOT NULL as ok FROM central_envio_config WHERE escritorio_id = ?`).get((req as any).user.escritorioId) as any;
    res.json({ conectado: !!c?.ok, email: c?.sa_email || null, ultimoErro: c?.ultimo_erro || null, ultimaVarredura: c?.ultima_varredura || null, diasInicial: c?.dias_inicial || 30 });
  });
  app.put("/api/central-envio/config", d.blockCliente, d.requireAdmin, async (req, res) => {
    const esc = (req as any).user.escritorioId;
    try {
      let j: any;
      try { j = JSON.parse(String(req.body?.json || "")); } catch { return res.status(400).json({ error: "O conteúdo colado não é um JSON válido. Cole o arquivo .json inteiro, do primeiro { ao último }." }); }
      if (j.type !== "service_account" || !j.client_email || !j.private_key) return res.status(400).json({ error: "Esse JSON não é a chave de uma conta de serviço do Google (faltam client_email/private_key)." });
      tokens.delete(esc);
      await tokenDrive(esc, { client_email: j.client_email, private_key: j.private_key });
      db.prepare(`INSERT INTO central_envio_config (escritorio_id, sa_json_cifrado, sa_email, ultimo_erro) VALUES (?, ?, ?, NULL)
                  ON CONFLICT(escritorio_id) DO UPDATE SET sa_json_cifrado = excluded.sa_json_cifrado, sa_email = excluded.sa_email, ultimo_erro = NULL`).run(esc, d.cifrar(JSON.stringify(j)), j.client_email);
      res.json({ ok: true, email: j.client_email });
    } catch (e: any) { res.status(400).json({ error: e.message }); }
  });
  app.delete("/api/central-envio/config", d.blockCliente, d.requireAdmin, (req, res) => {
    db.prepare(`UPDATE central_envio_config SET sa_json_cifrado = NULL, sa_email = NULL WHERE escritorio_id = ?`).run((req as any).user.escritorioId);
    res.json({ ok: true });
  });
  // Seletor de pastas: sem `pai` lista as pastas compartilhadas com a conta de serviço; com `pai`, as subpastas dele.
  app.get("/api/central-envio/drive/pastas", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    if (!SETORES_CENTRAL.some((s) => d.hasPermissao(user, s, "visualizar"))) return semAcesso(res);
    const cred = credDe(user.escritorioId);
    if (!cred) return res.status(400).json({ error: "A conexão com o Google Drive ainda não foi configurada (Configurações › Envio de documentos)." });
    try {
      const pai = String(req.query.pai || "");
      const q = pai ? `'${pai.replace(/[^\w-]/g, "")}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false` : `sharedWithMe = true and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const j = await driveGet(user.escritorioId, cred, "files", { q, orderBy: "name", pageSize: "200", fields: "files(id,name)" });
      res.json({ itens: j.files || [] });
    } catch (e: any) { res.status(502).json({ error: e.message }); }
  });
  app.get("/api/central-envio/pastas", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const rows = db.prepare(`SELECT p.*, u.nome as user_nome FROM central_envio_pastas p LEFT JOIN app_users u ON u.id = p.user_id WHERE p.escritorio_id = ? ORDER BY p.setor, u.nome`).all(user.escritorioId) as any[];
    res.json({ itens: rows.filter((r) => d.hasPermissao(user, r.setor, "visualizar")) });
  });
  app.post("/api/central-envio/pastas", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const setor = setorValido(req.body?.setor);
    const pastaId = String(req.body?.pastaId || "").replace(/[^\w-]/g, "");
    if (!setor || !pastaId) return res.status(400).json({ error: "Escolha o setor e a pasta." });
    // Cada um escolhe a SUA pasta (dentro do setor a que tem acesso); pasta geral do setor (sem colaborador) só o Administrador.
    const paraMim = !!req.body?.minha;
    if (paraMim ? !d.hasPermissao(user, setor, "visualizar") : !(d.abaConfigPermitida(user) && setorDoUsuario(user, setor))) return semAcesso(res);
    try {
      db.prepare(`INSERT INTO central_envio_pastas (escritorio_id, setor, user_id, pasta_id, pasta_nome) VALUES (?, ?, ?, ?, ?)`).run(user.escritorioId, setor, paraMim ? user.id : null, pastaId, String(req.body?.pastaNome || "").slice(0, 200));
    } catch { return res.status(409).json({ error: "Essa pasta já está cadastrada." }); }
    void varrer(user.escritorioId, { dias: Number(req.body?.dias) || 30 });
    res.json({ ok: true });
  });
  app.delete("/api/central-envio/pastas/:id", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const p = db.prepare(`SELECT * FROM central_envio_pastas WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!p) return res.status(404).json({ error: "Pasta não encontrada." });
    if (user.perfil !== "Administrador" && p.user_id !== user.id && !(d.abaConfigPermitida(user) && setorDoUsuario(user, p.setor))) return semAcesso(res);
    db.prepare(`DELETE FROM central_envio_pastas WHERE id = ?`).run(p.id);
    res.json({ ok: true });
  });

  const TIPOS_PADRAO: Record<string, [string, string[], boolean][]> = {
    dprh: [
      ["Rescisão", ["TERMO DE RESCISÃO"], true], ["Recibo de Férias", ["RECIBO DE FÉRIAS"], true], ["Aviso de Férias", ["AVISO DE FÉRIAS"], true],
      ["Adiantamento de Salário", ["ADIANTAMENTO"], true], ["Holerite", ["RECIBO DE PAGAMENTO DE SALÁRIO"], true],
    ],
  };
  app.get("/api/central-envio/tipos", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    if (!SETORES_CENTRAL.some((s) => d.hasPermissao(user, s, "visualizar"))) return semAcesso(res);
    let rows = db.prepare(`SELECT * FROM central_envio_tipos WHERE escritorio_id = ? ORDER BY setor, ordem, id`).all(user.escritorioId) as any[];
    if (!rows.length && user.perfil === "Administrador") { // primeira vez: sugestões iniciais (editáveis) pro DP/RH
      let o = 0;
      for (const [setor, lista] of Object.entries(TIPOS_PADRAO)) for (const [nome, palavras, todas] of lista)
        db.prepare(`INSERT INTO central_envio_tipos (escritorio_id, setor, nome, palavras_json, exige_todas, ordem) VALUES (?, ?, ?, ?, ?, ?)`).run(user.escritorioId, setor, nome, JSON.stringify(palavras), todas ? 1 : 0, o++);
      rows = db.prepare(`SELECT * FROM central_envio_tipos WHERE escritorio_id = ? ORDER BY setor, ordem, id`).all(user.escritorioId) as any[];
    }
    // Escritórios que já tinham os tipos iniciais: acrescenta "Folha Mensal" (junta todos os PDFs da empresa/mês num só).
    if (user.perfil === "Administrador" && !rows.some((r) => r.setor === "dprh" && norm(r.nome) === "FOLHA MENSAL") && !(db.prepare(`SELECT 1 FROM central_envio_tipos WHERE escritorio_id = ? AND nome = 'Folha Mensal'`).get(user.escritorioId))) {
      db.prepare(`INSERT INTO central_envio_tipos (escritorio_id, setor, nome, palavras_json, exige_todas, agrupar, ordem) VALUES (?, 'dprh', 'Folha Mensal', ?, 1, 1, -1)`).run(user.escritorioId, JSON.stringify(["FOLHA MENSAL"]));
      rows = db.prepare(`SELECT * FROM central_envio_tipos WHERE escritorio_id = ? ORDER BY setor, ordem, id`).all(user.escritorioId) as any[];
    }
    res.json({ itens: rows.map((r) => ({ id: r.id, setor: r.setor, nome: r.nome, palavras: JSON.parse(r.palavras_json || "[]"), exigeTodas: !!r.exige_todas, agrupar: !!r.agrupar, textoWhatsapp: r.texto_whatsapp || "", ativo: !!r.ativo })) });
  });
  const salvarTipo = (req: express.Request, res: express.Response, id?: number) => {
    const user = (req as any).user;
    const b = req.body || {};
    const setor = setorValido(b.setor);
    const nome = String(b.nome || "").trim();
    const palavras = (Array.isArray(b.palavras) ? b.palavras : String(b.palavras || "").split("\n")).map((p: any) => String(p).trim()).filter(Boolean);
    if (!setor || !nome || !palavras.length) return res.status(400).json({ error: "Informe o setor, o nome do tipo e pelo menos uma palavra que identifica o documento." });
    if (!setorDoUsuario(user, setor)) return semAcesso(res);
    if (id) db.prepare(`UPDATE central_envio_tipos SET setor=?, nome=?, palavras_json=?, exige_todas=?, texto_whatsapp=?, ativo=?, agrupar=? WHERE id=? AND escritorio_id=?`).run(setor, nome, JSON.stringify(palavras), b.exigeTodas === false ? 0 : 1, String(b.textoWhatsapp || "").trim() || null, b.ativo === false ? 0 : 1, b.agrupar ? 1 : 0, id, user.escritorioId);
    else db.prepare(`INSERT INTO central_envio_tipos (escritorio_id, setor, nome, palavras_json, exige_todas, texto_whatsapp, agrupar, ordem) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(user.escritorioId, setor, nome, JSON.stringify(palavras), b.exigeTodas === false ? 0 : 1, String(b.textoWhatsapp || "").trim() || null, b.agrupar ? 1 : 0, Date.now() % 100000);
    res.json({ ok: true });
  };
  app.post("/api/central-envio/tipos", d.blockCliente, gerir, (req, res) => salvarTipo(req, res));
  app.put("/api/central-envio/tipos/:id", d.blockCliente, gerir, (req, res) => salvarTipo(req, res, Number(req.params.id)));
  app.delete("/api/central-envio/tipos/:id", d.blockCliente, gerir, (req, res) => {
    db.prepare(`DELETE FROM central_envio_tipos WHERE id = ? AND escritorio_id = ?`).run(Number(req.params.id), (req as any).user.escritorioId);
    res.json({ ok: true });
  });
  // Testa uma amostra: vê que tipo/empresa/colaborador o site tiraria de um PDF enviado (sem gravar nada).
  // "Por que meu arquivo não apareceu?": arquivos que a leitura viu e não pôde usar (pasta não lida, erro, grande demais).
  app.get("/api/central-envio/diagnostico", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    if (!SETORES_CENTRAL.some((s) => d.hasPermissao(user, s, "visualizar"))) return semAcesso(res);
    const cred = credDe(user.escritorioId);
    const c = db.prepare(`SELECT ultima_varredura, ultimo_erro FROM central_envio_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
    const pastas = db.prepare(`SELECT setor, pasta_nome FROM central_envio_pastas WHERE escritorio_id = ?`).all(user.escritorioId) as any[];
    const itens = db.prepare(`SELECT nome, pasta, motivo, criado_em FROM central_envio_log WHERE escritorio_id = ? ORDER BY id DESC LIMIT 40`).all(user.escritorioId) as any[];
    // O que a conta de serviço realmente enxerga DENTRO de cada pasta lida (os 12 arquivos mais recentes) e o que foi feito com cada um.
    const visao: any[] = [];
    if (cred) {
      for (const r of db.prepare(`SELECT pasta_id, pasta_nome, setor FROM central_envio_pastas WHERE escritorio_id = ?`).all(user.escritorioId) as any[]) {
        try {
          const j = await driveGet(user.escritorioId, cred, "files", { q: `'${r.pasta_id}' in parents and trashed=false`, orderBy: "createdTime desc", pageSize: "12", fields: "files(id,name,mimeType,createdTime,modifiedTime)" });
          for (const f of j.files || []) {
            const docs = db.prepare(`SELECT status, titulo FROM central_envio_docs WHERE escritorio_id = ? AND drive_file_id = ? ORDER BY id DESC`).all(user.escritorioId, f.id) as any[];
            visao.push({ pasta: r.pasta_nome, nome: f.name, tipo: f.mimeType, criadoEm: f.createdTime, situacao: !/pdf|folder/.test(f.mimeType) ? "Não é PDF — ignorado" : /folder/.test(f.mimeType) ? "Subpasta" : docs.length ? `Lido: ${docs.map((x) => x.status).join(", ")}` : "PDF visível, AINDA NÃO lido" });
          }
        } catch (e: any) { visao.push({ pasta: r.pasta_nome, nome: "—", tipo: "", criadoEm: null, situacao: `Erro ao listar a pasta: ${e.message}` }); }
      }
    }
    res.json({ conectado: !!cred, ultimaVarredura: c?.ultima_varredura || null, ultimoErro: c?.ultimo_erro || null, pastasLidas: pastas.map((p) => `${p.pasta_nome} (${p.setor})`), itens, visao });
  });
  app.post("/api/central-envio/varrer", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    if (!SETORES_CENTRAL.some((s) => d.hasPermissao(user, s, "visualizar"))) return semAcesso(res);
    // A leitura pode demorar (baixa e lê cada PDF): roda em segundo plano e a tela acompanha pela lista/status.
    if (emVarredura.has(user.escritorioId)) return res.json({ ok: true, lendo: true });
    void varrer(user.escritorioId, { dias: Math.min(365, Math.max(1, Number(req.body?.dias) || 30)) });
    res.json({ ok: true, iniciado: true });
  });

  // ------------------------------------------------------------ rotas: pendentes / enviados / envio
  const visiveis = (user: any, setor: any): string[] | null => {
    if (setor && setorValido(setor)) return d.hasPermissao(user, setor, "visualizar") ? (setor === "crm" ? [...SETORES_CENTRAL] : [setor]) : null;
    return null;
  };
  app.get("/api/central-envio/docs", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const setores = visiveis(user, req.query.setor);
    if (!setores) return semAcesso(res);
    const esc = user.escritorioId;
    const busca = `%${String(req.query.busca || "").toLowerCase().replace(/[%_]/g, "")}%`;
    const marcas = setores.map(() => "?").join(",");
    if (req.query.aba === "enviados") {
      const rows = db.prepare(
        `SELECT * FROM central_envio_enviados WHERE escritorio_id = ? AND setor IN (${marcas}) AND (LOWER(COALESCE(empresa_nome,'')) LIKE ? OR LOWER(COALESCE(titulo,'')) LIKE ?)
         ORDER BY id DESC LIMIT 300`
      ).all(esc, ...setores, busca, busca) as any[];
      const refs = [...new Set(rows.map((r) => r.entrega_ref || r.id))];
      const st = refs.length ? (db.prepare(`SELECT origem_id, status FROM whatsapp_mensagens WHERE origem_tabela = 'central_envio_enviados' AND origem_id IN (${refs.map(() => "?").join(",")})`).all(...refs) as any[]) : [];
      const mapa = new Map(st.map((s) => [s.origem_id, s.status]));
      return res.json({ itens: rows.map((r) => ({ ...r, entrega: r.canal === "whatsapp" ? mapa.get(r.entrega_ref || r.id) || null : null })) });
    }
    if (req.query.aba === "agendados") {
      const rows = db.prepare(
        `SELECT a.*, x.titulo, x.setor, x.tipo_nome, e.nome as empresa_nome FROM central_envio_agendados a JOIN central_envio_docs x ON x.id = a.doc_id LEFT JOIN empresas e ON e.id = x.empresa_id
         WHERE a.escritorio_id = ? AND x.setor IN (${marcas}) AND (a.status = 'agendado' OR (a.status = 'erro' AND a.executado_em > datetime('now', '-7 days')))
           AND (LOWER(x.titulo) LIKE ? OR LOWER(COALESCE(e.nome,'')) LIKE ?) ORDER BY a.agendado_para, a.id LIMIT 300`
      ).all(esc, ...setores, busca, busca) as any[];
      return res.json({ itens: rows.map((r) => ({ id: r.id, extras: (JSON.parse(r.extras_json || "[]") as number[]).length, titulo: r.titulo, tipoNome: r.tipo_nome, empresaNome: r.empresa_nome, setor: r.setor, quando: r.agendado_para, status: r.status, erro: r.erro, telefones: JSON.parse(r.telefones_json || "[]"), emails: JSON.parse(r.emails_json || "[]"), por: r.criado_por_nome })) });
    }
    const statusLista = req.query.aba === "dispensados" ? "ignorado" : "pendente";
    const rows = db.prepare(
      `SELECT x.*, e.nome as empresa_nome FROM central_envio_docs x LEFT JOIN empresas e ON e.id = x.empresa_id
       WHERE x.escritorio_id = ? AND x.setor IN (${marcas}) AND x.status = '${statusLista}' AND (LOWER(x.titulo) LIKE ? OR LOWER(COALESCE(e.nome,'')) LIKE ?)
       ORDER BY x.id DESC LIMIT 500`
    ).all(esc, ...setores, busca, busca) as any[];
    res.json({ itens: rows.map((r) => ({ id: r.id, setor: r.setor, titulo: r.titulo, tipoId: r.tipo_id, tipoNome: r.tipo_nome, empresaId: r.empresa_id, empresaNome: r.empresa_nome, colaborador: r.colaborador_nome, cpf: r.cpf, competencia: r.competencia, arquivo: r.nome_arquivo, grupo: !!r.e_grupo, nArquivos: r.n_arquivos, versao: r.versao, modificadoEm: r.modificado_em, criadoEm: r.criado_em })) });
  });
  // Monitor (painel do CRM e página 2 da TV): por setor, pendentes / agendados / enviados (hoje, mês) e as listas por trás de cada número.
  app.get("/api/central-envio/painel", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const setores = SETORES_CENTRAL.filter((st) => st !== "crm" && (user.painelTv || d.hasPermissao(user, "crm", "visualizar") || d.hasPermissao(user, st, "visualizar")));
    if (!user.painelTv && !setores.length) return semAcesso(res);
    const esc = user.escritorioId;
    const hojeIni = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) + "T00:00:00-03:00").toISOString().replace("T", " ").slice(0, 19);
    const mesIni = new Date(new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }).slice(0, 7) + "-01T00:00:00-03:00").toISOString().replace("T", " ").slice(0, 19);
    const marcas = setores.map(() => "?").join(",");
    const pend = db.prepare(`SELECT x.id, x.setor, x.titulo, x.tipo_nome, x.criado_em as quando, e.nome as empresa FROM central_envio_docs x LEFT JOIN empresas e ON e.id = x.empresa_id WHERE x.escritorio_id = ? AND x.status = 'pendente' AND x.setor IN (${marcas}) ORDER BY x.id DESC LIMIT 300`).all(esc, ...setores) as any[];
    const agend = db.prepare(`SELECT a.id, x.setor, x.titulo, x.tipo_nome, a.agendado_para as quando, e.nome as empresa FROM central_envio_agendados a JOIN central_envio_docs x ON x.id = a.doc_id LEFT JOIN empresas e ON e.id = x.empresa_id WHERE a.escritorio_id = ? AND a.status = 'agendado' AND x.setor IN (${marcas}) ORDER BY a.agendado_para LIMIT 300`).all(esc, ...setores) as any[];
    // "Documentos enviados" = documentos distintos com pelo menos um envio ok (um documento pode ter vários destinatários/canais)
    const env = db.prepare(`SELECT MIN(id) as id, setor, titulo, tipo_nome, empresa_nome as empresa, MIN(enviado_em) as quando, GROUP_CONCAT(DISTINCT canal) as canais FROM central_envio_enviados WHERE escritorio_id = ? AND status = 'ok' AND enviado_em >= ? AND setor IN (${marcas}) GROUP BY COALESCE(doc_id, -id), date(enviado_em) ORDER BY MIN(id) DESC LIMIT 500`).all(esc, mesIni, ...setores) as any[];
    const porSetor = setores.map((st) => ({
      setor: st,
      pendentes: pend.filter((x) => x.setor === st).length, agendados: agend.filter((x) => x.setor === st).length,
      enviadosHoje: env.filter((x) => x.setor === st && x.quando >= hojeIni).length, enviadosMes: env.filter((x) => x.setor === st).length,
    }));
    res.json({ setores: porSetor, pendentes: pend, agendados: agend, enviados: env.map((x) => ({ ...x, hoje: x.quando >= hojeIni })) });
  });
  app.get("/api/central-envio/resumo", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const setores = visiveis(user, req.query.setor);
    if (!setores) return semAcesso(res);
    const n = (db.prepare(`SELECT COUNT(*) n FROM central_envio_docs WHERE escritorio_id = ? AND status = 'pendente' AND setor IN (${setores.map(() => "?").join(",")})`).get(user.escritorioId, ...setores) as any).n;
    const c = db.prepare(`SELECT ultima_varredura, ultimo_erro, sa_json_cifrado IS NOT NULL as ok FROM central_envio_config WHERE escritorio_id = ?`).get(user.escritorioId) as any;
    const pastas = (db.prepare(`SELECT id, setor, user_id, pasta_nome FROM central_envio_pastas WHERE escritorio_id = ? AND setor IN (${setores.map(() => "?").join(",")})`).all(user.escritorioId, ...setores) as any[]);
    const nAg = (db.prepare(`SELECT COUNT(*) n FROM central_envio_agendados a JOIN central_envio_docs x ON x.id = a.doc_id WHERE a.escritorio_id = ? AND a.status = 'agendado' AND x.setor IN (${setores.map(() => "?").join(",")})`).get(user.escritorioId, ...setores) as any).n;
    res.json({ lendo: varreduraManual.has(user.escritorioId), agendados: nAg, pendentes: n, conectado: !!c?.ok, ultimaVarredura: c?.ultima_varredura || null, ultimoErro: c?.ultimo_erro || null, minhasPastas: pastas.filter((p) => p.user_id === user.id), pastasDoSetor: pastas.length });
  });
  const docDoUsuario = (req: express.Request, res: express.Response): any | null => {
    const user = (req as any).user;
    const doc = db.prepare(`SELECT * FROM central_envio_docs WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!doc || !(d.hasPermissao(user, doc.setor, "visualizar") || d.hasPermissao(user, "crm", "visualizar"))) { res.status(404).json({ error: "Documento não encontrado." }); return null; }
    return doc;
  };
  // Relatório (PDF) da aba Enviados com os mesmos filtros da tela — pra conferência interna.
  app.get("/api/central-envio/enviados/relatorio.pdf", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    const setores = visiveis(user, req.query.setor);
    if (!setores) return semAcesso(res);
    const esc = user.escritorioId;
    const busca = `%${String(req.query.busca || "").toLowerCase().replace(/[%_]/g, "")}%`;
    const marcas = setores.map(() => "?").join(",");
    const dataDe = typeof req.query.dataDe === "string" && req.query.dataDe ? req.query.dataDe : null;
    const dataAte = typeof req.query.dataAte === "string" && req.query.dataAte ? req.query.dataAte : null;
    const situacao = typeof req.query.situacao === "string" ? req.query.situacao : "";
    const rows = db.prepare(
      `SELECT * FROM central_envio_enviados WHERE escritorio_id = ? AND setor IN (${marcas}) AND (LOWER(COALESCE(empresa_nome,'')) LIKE ? OR LOWER(COALESCE(titulo,'')) LIKE ?)
       ORDER BY empresa_nome, enviado_em, id`
    ).all(esc, ...setores, busca, busca) as any[];
    const refs = [...new Set(rows.map((r) => r.entrega_ref || r.id))];
    const st = refs.length ? (db.prepare(`SELECT origem_id, status FROM whatsapp_mensagens WHERE origem_tabela = 'central_envio_enviados' AND origem_id IN (${refs.map(() => "?").join(",")})`).all(...refs) as any[]) : [];
    const mapa = new Map(st.map((s) => [s.origem_id, s.status]));
    const classificar = (r: any): string => {
      if (r.status !== "ok") return "erro";
      const entrega = r.canal === "whatsapp" ? mapa.get(r.entrega_ref || r.id) : null;
      if (entrega === "delivered") return "entregue";
      if (entrega === "read") return "lido";
      if (entrega === "failed") return "falhou_entrega";
      return "enviado";
    };
    const filtrados = rows.filter((r) => {
      const dia = String(r.enviado_em || "").slice(0, 10);
      if (dataDe && dia < dataDe) return false;
      if (dataAte && dia > dataAte) return false;
      if (situacao && classificar(r) !== situacao) return false;
      return true;
    });
    const rotuloSituacao: Record<string, string> = { enviado: "Enviado", entregue: "Enviado · entregue", lido: "Enviado · lido ✓✓", falhou_entrega: "Falhou na entrega", erro: "Erro" };
    const cor: Record<string, string> = { enviado: "#DFF7EC", entregue: "#DFF7EC", lido: "#DFF7EC", falhou_entrega: "#fde2e2", erro: "#fde2e2" };
    const fmtData = (iso: string | null) => {
      if (!iso) return "—";
      const dt = new Date(String(iso).includes("T") || String(iso).includes("Z") ? iso : String(iso).replace(" ", "T") + "Z");
      return isNaN(dt.getTime()) ? "—" : dt.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    };
    const h = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const grupos = new Map<string, any[]>();
    for (const r of filtrados) {
      const k = r.empresa_nome || "Sem empresa";
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push(r);
    }
    const contagem = (c: string) => filtrados.filter((r) => classificar(r) === c).length;
    const periodo = dataDe || dataAte ? `${dataDe ? dataDe.split("-").reverse().join("/") : "…"} até ${dataAte ? dataAte.split("-").reverse().join("/") : "…"}` : "todo o período";
    const blocos = [...grupos.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"))
      .map(([nome, lista]) => `
        <div class="forn-head"><span class="forn-nome">${h(nome)}</span><span class="forn-cnpj">${lista.length} envio(s)</span></div>
        <table class="rep">
          <colgroup><col style="width:15%"><col style="width:33%"><col style="width:15%"><col style="width:20%"><col style="width:17%"></colgroup>
          <thead><tr><th>Quando</th><th>Documento</th><th>Canal</th><th>Destino</th><th>Situação</th></tr></thead>
          <tbody>${lista
            .map((r) => {
              const c = classificar(r);
              return `<tr><td>${h(fmtData(r.enviado_em))}</td><td><b>${h(r.titulo || "")}</b>${r.tipo_nome ? `<div class="sub">${h(r.tipo_nome)}</div>` : ""}</td><td>${r.canal === "whatsapp" ? "WhatsApp" : "E-mail"}</td><td>${h(r.destino || "—")}</td><td><span class="sit" style="background:${cor[c]}">${h(rotuloSituacao[c])}</span>${r.erro && c === "erro" ? `<div class="sub" style="color:#9b1c1c;">${h(r.erro)}</div>` : ""}</td></tr>`;
            })
            .join("")}</tbody>
        </table>`)
      .join("");
    const html = `<style>
      body { font-family: 'Helvetica Neue', Arial, sans-serif; font-size: 9px; color:#2b2b2b; }
      .cab { border-bottom: 2.5px solid #159873; padding-bottom: 7px; margin-bottom: 10px; }
      h1 { font-size: 16px; margin: 0 0 3px; color:#0E6B52; }
      .cab p { margin: 1px 0; color:#555; font-size: 9.5px; }
      .resumo { display:inline-block; background:#DFF7EC; border-radius:6px; padding:5px 10px; margin-right:6px; font-weight:700; color:#0E6B52; font-size:9.5px; }
      .forn-head { background:#DFF7EC; border-left:4px solid #159873; border-radius:3px; padding:5px 8px; margin:12px 0 4px; display:flex; justify-content:space-between; }
      .forn-nome { font-size: 10.5px; font-weight:700; color:#0E6B52; }
      .forn-cnpj { font-size: 8.5px; color:#3b8268; }
      table.rep { border-collapse: collapse; width: 100%; table-layout: fixed; margin: 0 0 6px; }
      table.rep th, table.rep td { border: 1px solid #cdeee1; padding: 3px 5px; overflow-wrap: break-word; vertical-align: top; }
      table.rep th { background:#DFF7EC; color:#0E6B52; text-align:left; font-size: 7.8px; text-transform:uppercase; letter-spacing:.2px; }
      table.rep tbody tr:nth-child(even) td { background:#F5FCFA; }
      .sub { font-size: 8px; color:#666; margin-top:2px; }
      .sit { display:inline-block; border-radius:4px; padding:1px 5px; font-size:8px; font-weight:700; color:#2b2b2b; }
    </style>
    <div class="cab">
      <h1>Relatório de documentos enviados</h1>
      <p><b>Período:</b> ${h(periodo)} · <b>Gerado em:</b> ${h(fmtData(new Date().toISOString().replace("T", " ").slice(0, 19)))}</p>
      <p><span class="resumo">${filtrados.length} envio(s)</span><span class="resumo">${contagem("enviado") + contagem("entregue") + contagem("lido")} enviados</span><span class="resumo">${contagem("falhou_entrega") + contagem("erro")} com erro</span></p>
    </div>
    ${blocos || '<p style="color:#666;">Nenhum envio no filtro escolhido.</p>'}`;
    const pdf = await gerarPdfDeHtml(html, "Relatório de documentos enviados", { landscape: true });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Documentos enviados.pdf"`);
    res.send(pdf);
  });
  app.get("/api/central-envio/docs/:id/pdf", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!fs.existsSync(doc.arquivo_path)) return res.status(404).json({ error: "Arquivo não encontrado no servidor." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(nomeArquivoSeguro(doc.titulo) + ".pdf")}`);
    res.sendFile(path.resolve(doc.arquivo_path));
  });
  app.get("/api/central-envio/enviados/:id/pdf", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const e = db.prepare(`SELECT * FROM central_envio_enviados WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!e || !e.arquivo_path || !d.hasPermissao(user, e.setor, "visualizar")) return res.status(404).json({ error: "Arquivo não encontrado." });
    if (!fs.existsSync(e.arquivo_path)) return res.status(404).json({ error: "Arquivo não encontrado no servidor." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(nomeArquivoSeguro(e.titulo) + ".pdf")}`);
    res.sendFile(path.resolve(e.arquivo_path));
  });
  // Correção manual do que o site leu (tipo, empresa, colaborador, competência) — o título é refeito.
  app.put("/api/central-envio/docs/:id", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    const user = (req as any).user;
    if (!d.hasPermissao(user, doc.setor, "postar")) return semAcesso(res);
    if (doc.e_grupo) return res.status(409).json({ error: "Este PDF junta vários arquivos da mesma empresa e não tem colaborador único — só dá para enviar ou dispensar." });
    const b = req.body || {};
    const tipo = b.tipoId ? (db.prepare(`SELECT id, nome FROM central_envio_tipos WHERE id = ? AND escritorio_id = ?`).get(Number(b.tipoId), user.escritorioId) as any) : null;
    const emp = b.empresaId ? (db.prepare(`SELECT id, nome FROM empresas WHERE id = ? AND escritorio_id = ?`).get(Number(b.empresaId), user.escritorioId) as any) : null;
    const colab = b.colaborador !== undefined ? String(b.colaborador || "").trim() || null : doc.colaborador_nome;
    const comp = b.competencia !== undefined ? String(b.competencia || "").trim() || null : doc.competencia;
    const tipoNome = b.tipoId !== undefined ? tipo?.nome || null : doc.tipo_nome;
    const empId = b.empresaId !== undefined ? emp?.id ?? null : doc.empresa_id;
    const empNome = empId ? (emp?.nome || (db.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(empId) as any)?.nome) : null;
    const titulo = [tipoNome || String(doc.nome_arquivo).replace(/\.pdf$/i, ""), colab, empNome, comp].filter(Boolean).join(" - ");
    db.prepare(`UPDATE central_envio_docs SET tipo_id=?, tipo_nome=?, empresa_id=?, colaborador_nome=?, competencia=?, titulo=? WHERE id=?`).run(b.tipoId !== undefined ? tipo?.id ?? null : doc.tipo_id, tipoNome, empId, colab, comp, titulo, doc.id);
    res.json({ ok: true, titulo });
  });
  // O que o site leu do PDF (pra afinar tipos e regras) e releitura de um documento já lido com as regras atuais.
  app.get("/api/central-envio/docs/:id/texto", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    res.json({ texto: doc.texto_amostra || "(sem texto guardado — releia o PDF)" });
  });
  app.post("/api/central-envio/docs/:id/reler", d.blockCliente, async (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!d.hasPermissao((req as any).user, doc.setor, "postar")) return semAcesso(res);
    if (doc.status !== "pendente") return res.status(409).json({ error: "Só documentos pendentes podem ser relidos." });
    if (doc.e_grupo) return res.status(409).json({ error: "Este PDF junta vários arquivos da mesma empresa. Solte de novo os arquivos na pasta se precisar reler algum." });
    if (!fs.existsSync(doc.arquivo_path)) return res.status(404).json({ error: "O arquivo não está mais no servidor." });
    const a = await analisarPdf(doc.escritorio_id, doc.setor, fs.readFileSync(doc.arquivo_path), doc.nome_arquivo);
    db.prepare(`UPDATE central_envio_docs SET tipo_id=?, tipo_nome=?, empresa_id=?, cnpj=?, colaborador_nome=?, cpf=?, competencia=?, titulo=?, texto_amostra=? WHERE id=?`)
      .run(a.tipoId, a.tipoNome, a.empresaId, a.cnpj, a.colaborador, a.cpf, a.competencia, a.titulo, a.texto.slice(0, 8000), doc.id);
    // Tipo que junta arquivos (Folha Mensal): ao reler, se agora dá pra saber empresa e competência, entra no PDF único.
    if (a.agrupar && a.empresaId && a.competencia && /^\d{2}\/\d{4}$/.test(a.competencia)) await agruparNoPendente(doc.escritorio_id, doc.id, a, { setor: doc.setor, userId: doc.user_id, pastaId: doc.pasta_id });
    res.json({ ok: true, titulo: a.titulo });
  });
  app.post("/api/central-envio/docs/:id/ignorar", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!d.hasPermissao((req as any).user, doc.setor, "postar")) return semAcesso(res);
    db.prepare(`UPDATE central_envio_docs SET status = 'ignorado' WHERE id = ?`).run(doc.id);
    res.json({ ok: true });
  });
  app.post("/api/central-envio/docs/:id/restaurar", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!d.hasPermissao((req as any).user, doc.setor, "postar")) return semAcesso(res);
    if (doc.status !== "ignorado") return res.status(409).json({ error: "Esse documento não está dispensado." });
    db.prepare(`UPDATE central_envio_docs SET status = 'pendente' WHERE id = ?`).run(doc.id);
    res.json({ ok: true });
  });
  app.get("/api/central-envio/docs/:id/contatos", d.blockCliente, (req, res) => {
    const doc = docDoUsuario(req, res); if (!doc) return;
    res.json(contatosDaEmpresa(doc.empresa_id));
  });
  // Envio (usado pelo "Enviar" dos pendentes e pelo "Reenviar" do histórico): manda o PDF guardado aos contatos marcados da empresa
  // e grava UMA LINHA NOVA em Enviados por destinatário — nada do que já foi enviado é alterado.
  async function executarEnvio(user: any, doc: any, body: any): Promise<{ status?: number; erro?: string; resultados?: { canal: string; destino: string; ok: boolean; erro?: string }[] }> {
    if (!doc.empresa_id) return { status: 400, erro: "Escolha a empresa deste documento antes de enviar." };
    if (!doc.arquivo_path || !fs.existsSync(doc.arquivo_path)) return { status: 404, erro: "O arquivo não está mais no servidor." };
    const canais: string[] = Array.isArray(body?.canais) ? body.canais : [];
    const telefones: string[] = (Array.isArray(body?.telefones) ? body.telefones : []).map(String);
    const emails: string[] = (Array.isArray(body?.emails) ? body.emails : []).map(String);
    if (!canais.length) return { status: 400, erro: "Escolha WhatsApp e/ou e-mail." };
    const empresa = db.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(doc.empresa_id) as any;
    const permitidos = db.prepare(`SELECT email, telefone FROM empresa_contatos WHERE empresa_id = ?`).all(doc.empresa_id) as any[];
    const pdf = fs.readFileSync(doc.arquivo_path);
    const nomePdf = `${nomeArquivoSeguro(doc.titulo)}.pdf`;
    const tipo = (doc.tipo_id ? db.prepare(`SELECT texto_whatsapp FROM central_envio_tipos WHERE id = ?`).get(doc.tipo_id) : doc.tipo_nome ? db.prepare(`SELECT texto_whatsapp FROM central_envio_tipos WHERE escritorio_id = ? AND nome = ? LIMIT 1`).get(doc.escritorio_id, doc.tipo_nome) : null) as any;
    const resultados: { canal: string; destino: string; ok: boolean; erro?: string }[] = [];
    const registrar = (canal: string, destino: string, ok: boolean, erro?: string) => {
      const info = db.prepare(
        `INSERT INTO central_envio_enviados (doc_id, escritorio_id, empresa_id, empresa_nome, setor, tipo_nome, titulo, colaborador_nome, competencia, canal, destino, enviado_por, enviado_por_nome, status, erro, arquivo_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(doc.id ?? doc.doc_id ?? null, doc.escritorio_id, doc.empresa_id, empresa?.nome || null, doc.setor, doc.tipo_nome, doc.titulo, doc.colaborador_nome, doc.competencia, canal, destino, user.id, user.nome, ok ? "ok" : "erro", erro || null, doc.arquivo_path);
      resultados.push({ canal, destino, ok, erro });
      return Number(info.lastInsertRowid);
    };
    if (canais.includes("whatsapp")) {
      for (const tel of telefones.filter((t) => permitidos.some((p) => p.telefone === t))) {
        try {
          const enviadoId = registrar("whatsapp", tel, true);
          try {
            await d.enviarWhatsapp(doc.escritorio_id, tel, [{ nome: "empresa_nome", valor: empresa?.nome || "" }, { nome: "descricao", valor: tipo?.texto_whatsapp || doc.titulo }], { nome: nomePdf, tipo: "application/pdf", buffer: pdf }, { tabela: "central_envio_enviados", id: enviadoId }, body?.canalWhatsapp);
          } catch (e: any) {
            db.prepare(`UPDATE central_envio_enviados SET status = 'erro', erro = ? WHERE id = ?`).run(String(e.message).slice(0, 300), enviadoId);
            resultados[resultados.length - 1] = { canal: "whatsapp", destino: tel, ok: false, erro: e.message };
          }
        } catch (e: any) { resultados.push({ canal: "whatsapp", destino: tel, ok: false, erro: e.message }); }
      }
    }
    if (canais.includes("email")) {
      const lista = emails.filter((e) => permitidos.some((p) => p.email === e));
      if (lista.length) {
        try {
          await d.enviarEmail(doc.escritorio_id, { to: lista, subject: doc.titulo, text: `Olá!\n\nSegue em anexo: ${doc.titulo}.\n\nQualquer dúvida, é só responder este e-mail.\n\nSimples Contábeis`, attachments: [{ filename: nomePdf, content: pdf }] });
          for (const e of lista) registrar("email", e, true);
        } catch (e: any) { for (const x of lista) registrar("email", x, false, String(e.message).slice(0, 300)); }
      }
    }
    if (!resultados.length) return { status: 400, erro: "Nenhum destinatário válido selecionado (só valem contatos cadastrados na empresa)." };
    return { resultados };
  }
  // Uma mensagem por empresa: e-mail único com TODOS os PDFs anexados; WhatsApp com um PDF único (os arquivos juntos, na ordem).
  // Cada documento continua com a sua linha em Enviados (histórico por documento).
  async function executarEnvioConsolidado(user: any, docs: any[], body: any): Promise<{ status?: number; erro?: string; resultados?: { canal: string; destino: string; ok: boolean; erro?: string }[] }> {
    if (docs.length === 1) return executarEnvio(user, docs[0], body);
    const base = docs[0];
    if (docs.some((x) => x.empresa_id !== base.empresa_id)) return { status: 400, erro: "Os documentos precisam ser da mesma empresa." };
    if (docs.some((x) => !fs.existsSync(x.arquivo_path))) return { status: 404, erro: "Algum arquivo não está mais no servidor." };
    const canais: string[] = Array.isArray(body?.canais) ? body.canais : [];
    const empresa = db.prepare(`SELECT nome FROM empresas WHERE id = ?`).get(base.empresa_id) as any;
    const permitidos = db.prepare(`SELECT email, telefone FROM empresa_contatos WHERE empresa_id = ?`).all(base.empresa_id) as any[];
    const telefones: string[] = (Array.isArray(body?.telefones) ? body.telefones : []).map(String).filter((t: string) => permitidos.some((p) => p.telefone === t));
    const emails: string[] = (Array.isArray(body?.emails) ? body.emails : []).map(String).filter((e: string) => permitidos.some((p) => p.email === e));
    const resultados: { canal: string; destino: string; ok: boolean; erro?: string }[] = [];
    const registrarTodos = (canal: string, destino: string, ok: boolean, erro?: string, viaWhats = false) => {
      let primeiro: number | null = null;
      for (const doc of docs) {
        const info: any = db.prepare(
          `INSERT INTO central_envio_enviados (doc_id, escritorio_id, empresa_id, empresa_nome, setor, tipo_nome, titulo, colaborador_nome, competencia, canal, destino, enviado_por, enviado_por_nome, status, erro, arquivo_path, entrega_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(doc.id, doc.escritorio_id, doc.empresa_id, empresa?.nome || null, doc.setor, doc.tipo_nome, doc.titulo, doc.colaborador_nome, doc.competencia, canal, destino, user.id, user.nome, ok ? "ok" : "erro", erro || null, doc.arquivo_path, viaWhats ? primeiro : null);
        if (primeiro === null) primeiro = Number(info.lastInsertRowid);
      }
      resultados.push({ canal, destino, ok, erro });
      return primeiro!;
    };
    const titulos = docs.map((x) => x.titulo);
    if (canais.includes("whatsapp") && telefones.length) {
      const juntar = await mesclarPdfs(docs.map((x) => x.arquivo_path));
      const nomePdf = `${nomeArquivoSeguro(`${empresa?.nome || "Documentos"} - ${docs.length} documentos`)}.pdf`;
      for (const tel of telefones) {
        try {
          const refId = registrarTodos("whatsapp", tel, true, undefined, true);
          try {
            await d.enviarWhatsapp(base.escritorio_id, tel, [{ nome: "empresa_nome", valor: empresa?.nome || "" }, { nome: "descricao", valor: `${docs.length} documentos em um só arquivo` }], { nome: nomePdf, tipo: "application/pdf", buffer: juntar }, { tabela: "central_envio_enviados", id: refId }, body?.canalWhatsapp);
          } catch (e: any) {
            db.prepare(`UPDATE central_envio_enviados SET status = 'erro', erro = ? WHERE id = ? OR entrega_ref = ?`).run(String(e.message).slice(0, 300), refId, refId);
            resultados[resultados.length - 1] = { canal: "whatsapp", destino: tel, ok: false, erro: e.message };
          }
        } catch (e: any) { resultados.push({ canal: "whatsapp", destino: tel, ok: false, erro: e.message }); }
      }
    }
    if (canais.includes("email") && emails.length) {
      try {
        await d.enviarEmail(base.escritorio_id, {
          to: emails, subject: `${empresa?.nome || "Documentos"} — ${docs.length} documentos`,
          text: `Olá!\n\nSegue(m) em anexo ${docs.length} documento(s):\n\n${titulos.map((t) => `• ${t}`).join("\n")}\n\nQualquer dúvida, é só responder este e-mail.\n\nSimples Contábeis`,
          attachments: docs.map((x) => ({ filename: `${nomeArquivoSeguro(x.titulo)}.pdf`, content: fs.readFileSync(x.arquivo_path) })),
        });
        for (const e of emails) registrarTodos("email", e, true);
      } catch (e: any) { for (const x of emails) registrarTodos("email", x, false, String(e.message).slice(0, 300)); }
    }
    if (!resultados.length) return { status: 400, erro: "Nenhum destinatário válido (só valem contatos cadastrados na empresa)." };
    return { resultados };
  }
  // Se a empresa tiver dois contatos cadastrados com o mesmo telefone/e-mail (cadastro duplicado por engano),
  // sem isso o mesmo documento sairia repetido pra mesma pessoa — 1 envio por telefone/e-mail, nunca mais.
  const semRepetido = <T,>(lista: T[], chave: (x: T) => string) => { const vistos = new Set<string>(); return lista.filter((x) => { const k = chave(x); if (vistos.has(k)) return false; vistos.add(k); return true; }); };
  const contatosDaEmpresa = (empresaId: number | null) => {
    if (!empresaId) return { whatsapp: [], email: [] };
    const c = db.prepare(`SELECT nome, email, telefone, receber_emails, receber_whatsapp FROM empresa_contatos WHERE empresa_id = ?`).all(empresaId) as any[];
    return {
      whatsapp: semRepetido(c.filter((x) => x.telefone && x.receber_whatsapp).map((x) => ({ nome: x.nome, telefone: x.telefone })), (x) => x.telefone.replace(/\D/g, "")),
      email: semRepetido(c.filter((x) => x.email && x.receber_emails).map((x) => ({ nome: x.nome, email: x.email })), (x) => x.email.trim().toLowerCase()),
    };
  };
  // ------------------------------------------------------------ envio AGENDADO (ex.: preparar à noite, disparar às 08:00)
  async function rodarAgendado(a: any) {
    // "enviando" evita disparo duplo se duas voltas do relógio se cruzarem
    if (!Number(db.prepare(`UPDATE central_envio_agendados SET status = 'enviando' WHERE id = ? AND status = 'agendado'`).run(a.id).changes)) return;
    const ids: number[] = [a.doc_id, ...(JSON.parse(a.extras_json || "[]") as number[])];
    const docs = ids.map((id) => db.prepare(`SELECT * FROM central_envio_docs WHERE id = ?`).get(id) as any).filter((x) => x && x.status === "agendado");
    const voltar = () => { for (const x of docs) db.prepare(`UPDATE central_envio_docs SET status = 'pendente' WHERE id = ?`).run(x.id); };
    if (!docs.length) { db.prepare(`UPDATE central_envio_agendados SET status = 'cancelado', executado_em = datetime('now') WHERE id = ?`).run(a.id); return; }
    try {
      const r = await executarEnvioConsolidado({ id: a.criado_por, nome: a.criado_por_nome }, docs, { canais: JSON.parse(a.canais_json), telefones: JSON.parse(a.telefones_json), emails: JSON.parse(a.emails_json), canalWhatsapp: a.canal_whatsapp });
      if (r.erro || !r.resultados!.some((x) => x.ok)) {
        db.prepare(`UPDATE central_envio_agendados SET status = 'erro', erro = ?, executado_em = datetime('now') WHERE id = ?`).run((r.erro || r.resultados!.map((x) => x.erro).filter(Boolean)[0] || "Falha no envio").slice(0, 300), a.id);
        voltar(); // volta pra Pendentes pra você ver e decidir
      } else {
        db.prepare(`UPDATE central_envio_agendados SET status = 'enviado', executado_em = datetime('now') WHERE id = ?`).run(a.id);
        for (const x of docs) db.prepare(`UPDATE central_envio_docs SET status = 'enviado' WHERE id = ?`).run(x.id);
      }
    } catch (e: any) {
      db.prepare(`UPDATE central_envio_agendados SET status = 'erro', erro = ?, executado_em = datetime('now') WHERE id = ?`).run(String(e.message).slice(0, 300), a.id);
      voltar();
    }
  }
  setInterval(async () => {
    const vencidos = db.prepare(`SELECT * FROM central_envio_agendados WHERE status = 'agendado' AND agendado_para <= ? ORDER BY agendado_para, id LIMIT 40`).all(new Date().toISOString()) as any[];
    for (const a of vencidos) { await rodarAgendado(a).catch((e) => console.error("[central-envio] agendado:", e.message)); await new Promise((r) => setTimeout(r, 300)); } // pausa curta: envio em massa sem estourar o limite do WhatsApp
  }, 15_000).unref();
  // ------------------------------------------------------------ EM LOTE: vários documentos (de várias empresas) de uma vez
  // Cada documento vai para os contatos ativos DA PRÓPRIA empresa. "Agora" também passa pelo agendador (dispara em segundos, em segundo plano).
  const idsDoLote = (v: any): number[] => (Array.isArray(v) ? v : String(v || "").split(",")).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 300);
  app.get("/api/central-envio/lote/previa", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const ids = idsDoLote(req.query.ids);
    if (!ids.length) return res.json({ itens: [] });
    const rows = db.prepare(`SELECT x.*, e.nome as empresa_nome FROM central_envio_docs x LEFT JOIN empresas e ON e.id = x.empresa_id WHERE x.escritorio_id = ? AND x.id IN (${ids.map(() => "?").join(",")})`).all(user.escritorioId, ...ids) as any[];
    res.json({ itens: rows.map((r) => {
      const c = contatosDaEmpresa(r.empresa_id);
      const problema = r.status !== "pendente" ? "Já foi enviado, agendado ou dispensado" : !d.hasPermissao(user, r.setor, "postar") ? "Sem permissão neste setor" : !r.empresa_id ? "Sem empresa — corrija antes" : !fs.existsSync(r.arquivo_path) ? "Arquivo não está no servidor" : !c.whatsapp.length && !c.email.length ? "Empresa sem contato de WhatsApp/e-mail ativo" : null;
      return { id: r.id, titulo: r.titulo, empresaNome: r.empresa_nome, whatsapp: c.whatsapp, email: c.email, problema };
    }) });
  });
  app.post("/api/central-envio/lote", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const ids = idsDoLote(req.body?.ids);
    const canais: string[] = (Array.isArray(req.body?.canais) ? req.body.canais : []).filter((c: string) => c === "whatsapp" || c === "email");
    if (!ids.length || !canais.length) return res.status(400).json({ error: "Escolha os documentos e pelo menos um canal (WhatsApp ou e-mail)." });
    let quando = new Date(Date.now() - 1000); // agora
    if (req.body?.quando) {
      quando = new Date(String(req.body.quando));
      if (isNaN(quando.getTime()) || quando.getTime() < Date.now() + 30_000) return res.status(400).json({ error: "Escolha um dia e horário no futuro." });
    }
    const ok: number[] = [];
    const validos: { doc: any; telefones: string[]; emails: string[] }[] = [];
    const ignorados: { id: number; titulo: string; motivo: string }[] = [];
    for (const id of ids) {
      const doc = db.prepare(`SELECT * FROM central_envio_docs WHERE id = ? AND escritorio_id = ?`).get(id, user.escritorioId) as any;
      if (!doc) continue;
      const motivo = doc.status !== "pendente" ? "já foi enviado, agendado ou dispensado" : !d.hasPermissao(user, doc.setor, "postar") ? "sem permissão neste setor" : !doc.empresa_id ? "sem empresa" : !fs.existsSync(doc.arquivo_path) ? "arquivo não está no servidor" : null;
      const c = contatosDaEmpresa(doc.empresa_id);
      const telefones = canais.includes("whatsapp") ? c.whatsapp.map((w: any) => w.telefone) : [];
      const emails = canais.includes("email") ? c.email.map((m: any) => m.email) : [];
      const m2 = motivo || (!telefones.length && !emails.length ? "empresa sem contato ativo nos canais escolhidos" : null);
      if (m2) { ignorados.push({ id, titulo: doc.titulo, motivo: m2 }); continue; }
      validos.push({ doc, telefones, emails });
      ok.push(id);
    }
    // "Uma mensagem por empresa": os documentos da mesma empresa saem juntos (e-mail com todos os anexos; WhatsApp com um PDF único).
    const grupos = new Map<string, { doc: any; telefones: string[]; emails: string[]; extras: number[] }>();
    for (const v of validos) {
      const chave = req.body?.porEmpresa ? `e${v.doc.empresa_id}` : `d${v.doc.id}`;
      const g = grupos.get(chave);
      if (g) g.extras.push(v.doc.id); else grupos.set(chave, { ...v, extras: [] });
    }
    const canalWhatsapp = req.body?.canalWhatsapp === "meta" ? "meta" : "conversa";
    for (const g of grupos.values()) {
      db.prepare(`INSERT INTO central_envio_agendados (escritorio_id, doc_id, agendado_para, canais_json, telefones_json, emails_json, criado_por, criado_por_nome, extras_json, canal_whatsapp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(g.doc.escritorio_id, g.doc.id, quando.toISOString(), JSON.stringify(canais), JSON.stringify(g.telefones), JSON.stringify(g.emails), user.id, user.nome, JSON.stringify(g.extras), canalWhatsapp);
      for (const id of [g.doc.id, ...g.extras]) db.prepare(`UPDATE central_envio_docs SET status = 'agendado' WHERE id = ?`).run(id);
    }
    res.json({ ok: true, agendados: ok.length, envios: grupos.size, ignorados, imediato: !req.body?.quando });
  });
  app.post("/api/central-envio/docs/:id/agendar", d.blockCliente, (req, res) => {
    const user = (req as any).user;
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!d.hasPermissao(user, doc.setor, "postar")) return semAcesso(res);
    if (doc.status !== "pendente") return res.status(409).json({ error: "Esse documento já foi enviado, agendado ou dispensado." });
    if (!doc.empresa_id) return res.status(400).json({ error: "Escolha a empresa deste documento antes de agendar." });
    const quando = new Date(String(req.body?.quando || ""));
    if (isNaN(quando.getTime()) || quando.getTime() < Date.now() + 30_000) return res.status(400).json({ error: "Escolha um dia e horário no futuro." });
    const canais: string[] = (Array.isArray(req.body?.canais) ? req.body.canais : []).filter((c: string) => c === "whatsapp" || c === "email");
    const c = contatosDaEmpresa(doc.empresa_id);
    const telefones = (Array.isArray(req.body?.telefones) ? req.body.telefones : []).map(String).filter((t: string) => c.whatsapp.some((w: any) => w.telefone === t));
    const emails = (Array.isArray(req.body?.emails) ? req.body.emails : []).map(String).filter((e: string) => c.email.some((m: any) => m.email === e));
    if (!canais.length || (!telefones.length && !emails.length)) return res.status(400).json({ error: "Marque pelo menos um destinatário (contatos cadastrados na empresa)." });
    const canalWhatsapp = req.body?.canalWhatsapp === "meta" ? "meta" : "conversa";
    db.prepare(`INSERT INTO central_envio_agendados (escritorio_id, doc_id, agendado_para, canais_json, telefones_json, emails_json, criado_por, criado_por_nome, canal_whatsapp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(doc.escritorio_id, doc.id, quando.toISOString(), JSON.stringify(canais), JSON.stringify(telefones), JSON.stringify(emails), user.id, user.nome, canalWhatsapp);
    db.prepare(`UPDATE central_envio_docs SET status = 'agendado' WHERE id = ?`).run(doc.id);
    res.json({ ok: true, quando: quando.toISOString() });
  });
  const agendadoDoUsuario = (req: express.Request, res: express.Response): any | null => {
    const user = (req as any).user;
    const a = db.prepare(`SELECT a.*, x.setor as setor FROM central_envio_agendados a JOIN central_envio_docs x ON x.id = a.doc_id WHERE a.id = ? AND a.escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!a || !d.hasPermissao(user, a.setor, "postar")) { res.status(404).json({ error: "Agendamento não encontrado." }); return null; }
    return a;
  };
  app.post("/api/central-envio/agendados/:id/cancelar", d.blockCliente, (req, res) => {
    const a = agendadoDoUsuario(req, res); if (!a) return;
    if (a.status !== "agendado" && a.status !== "erro") return res.status(409).json({ error: "Esse agendamento já foi executado." });
    db.prepare(`UPDATE central_envio_agendados SET status = 'cancelado', executado_em = datetime('now') WHERE id = ?`).run(a.id);
    db.prepare(`UPDATE central_envio_docs SET status = 'pendente' WHERE id = ? AND status = 'agendado'`).run(a.doc_id);
    res.json({ ok: true });
  });
  app.put("/api/central-envio/agendados/:id", d.blockCliente, (req, res) => {
    const a = agendadoDoUsuario(req, res); if (!a) return;
    const quando = new Date(String(req.body?.quando || ""));
    if (a.status !== "agendado") return res.status(409).json({ error: "Só dá para mudar o horário de um agendamento pendente." });
    if (isNaN(quando.getTime()) || quando.getTime() < Date.now() + 30_000) return res.status(400).json({ error: "Escolha um dia e horário no futuro." });
    db.prepare(`UPDATE central_envio_agendados SET agendado_para = ? WHERE id = ?`).run(quando.toISOString(), a.id);
    res.json({ ok: true });
  });
  app.post("/api/central-envio/agendados/:id/enviar-agora", d.blockCliente, async (req, res) => {
    const a = agendadoDoUsuario(req, res); if (!a) return;
    if (a.status !== "agendado") return res.status(409).json({ error: "Esse agendamento não está mais aguardando." });
    await rodarAgendado(a);
    const depois = db.prepare(`SELECT status, erro FROM central_envio_agendados WHERE id = ?`).get(a.id) as any;
    if (depois.status === "erro") return res.status(502).json({ error: depois.erro || "Falha no envio." });
    res.json({ ok: true });
  });
  app.post("/api/central-envio/docs/:id/enviar", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    const doc = docDoUsuario(req, res); if (!doc) return;
    if (!d.hasPermissao(user, doc.setor, "postar")) return semAcesso(res);
    if (doc.status !== "pendente") return res.status(409).json({ error: "Esse documento já foi enviado ou dispensado." });
    const r = await executarEnvio(user, doc, req.body);
    if (r.erro) return res.status(r.status || 400).json({ error: r.erro });
    if (r.resultados!.some((x) => x.ok)) db.prepare(`UPDATE central_envio_docs SET status = 'enviado' WHERE id = ?`).run(doc.id);
    res.json({ ok: r.resultados!.some((x) => x.ok), resultados: r.resultados });
  });
  // Reenviar um documento do histórico (mesmo PDF guardado): escolhe de novo os contatos e grava novos registros em Enviados.
  const envioDoHistorico = (req: express.Request, res: express.Response): any | null => {
    const user = (req as any).user;
    const e = db.prepare(`SELECT * FROM central_envio_enviados WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!e || !(d.hasPermissao(user, e.setor, "visualizar") || d.hasPermissao(user, "crm", "visualizar"))) { res.status(404).json({ error: "Envio não encontrado." }); return null; }
    return e;
  };
  app.get("/api/central-envio/enviados/:id/contatos", d.blockCliente, (req, res) => {
    const e = envioDoHistorico(req, res); if (!e) return;
    res.json({ ...contatosDaEmpresa(e.empresa_id), titulo: e.titulo, empresaNome: e.empresa_nome });
  });
  app.post("/api/central-envio/enviados/:id/reenviar", d.blockCliente, async (req, res) => {
    const user = (req as any).user;
    const e = envioDoHistorico(req, res); if (!e) return;
    if (!d.hasPermissao(user, e.setor, "postar")) return semAcesso(res);
    const r = await executarEnvio(user, { ...e, id: e.doc_id }, req.body);
    if (r.erro) return res.status(r.status || 400).json({ error: r.erro });
    res.json({ ok: r.resultados!.some((x) => x.ok), resultados: r.resultados });
  });
}
