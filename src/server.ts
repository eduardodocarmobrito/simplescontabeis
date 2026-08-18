import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import multer from "multer";
import nodemailer from "nodemailer";
import { DatabaseSync } from "node:sqlite";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

// ========================= BANCO DO SITE (SQLite, num volume persistente) =========================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const sqlite = new DatabaseSync(path.join(DATA_DIR, "simplescontabeis.db"));
sqlite.exec(`PRAGMA journal_mode = WAL;`);
sqlite.exec(`PRAGMA busy_timeout = 8000;`);
sqlite.exec(`PRAGMA foreign_keys = ON;`);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cnpj TEXT,
    codigo_dominio TEXT,
    ativo INTEGER NOT NULL DEFAULT 1,
    visivel_relatorios INTEGER NOT NULL DEFAULT 1,
    origem TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS empresa_contatos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    nome TEXT NOT NULL,
    email TEXT NOT NULL,
    receber_emails INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    perfil TEXT NOT NULL, -- 'Administrador' | 'Colaborador' | 'Cliente'
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE CASCADE, -- só para perfil = Cliente
    acesso_todas_empresas INTEGER NOT NULL DEFAULT 1, -- só relevante para Colaborador
    password_hash TEXT NOT NULL,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- Empresas que um Colaborador com acesso_todas_empresas=0 pode enxergar
  CREATE TABLE IF NOT EXISTS colaborador_empresas (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, empresa_id)
  );

  -- Permissão por módulo para Colaboradores (Administrador sempre tem tudo liberado)
  CREATE TABLE IF NOT EXISTS colaborador_permissoes (
    user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    modulo TEXT NOT NULL,
    pode_visualizar INTEGER NOT NULL DEFAULT 0,
    pode_postar INTEGER NOT NULL DEFAULT 0,
    pode_editar INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, modulo)
  );

  -- ---- Solicitações de documentos (checklist) ----
  CREATE TABLE IF NOT EXISTS checklist_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    descricao TEXT,
    periodicidade TEXT NOT NULL DEFAULT 'mensal', -- 'mensal' | 'anual' | 'avulso'
    itens_json TEXT NOT NULL, -- [{chave,label,accept:['ofx','pdf','zip','xml','imagem','qualquer'],obrigatorio}]
    notificar_email INTEGER NOT NULL DEFAULT 0,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checklist_atribuicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES checklist_templates(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(template_id, empresa_id)
  );

  CREATE TABLE IF NOT EXISTS checklist_periodos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atribuicao_id INTEGER NOT NULL REFERENCES checklist_atribuicoes(id) ON DELETE CASCADE,
    ano INTEGER NOT NULL,
    mes INTEGER, -- NULL para periodicidade 'anual' ou 'avulso'
    rotulo TEXT, -- usado em 'avulso', ex.: "Extrato de Financiamento nº 4521"
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(atribuicao_id, ano, mes, rotulo)
  );

  CREATE TABLE IF NOT EXISTS checklist_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES checklist_periodos(id) ON DELETE CASCADE,
    item_chave TEXT NOT NULL,
    versao INTEGER NOT NULL DEFAULT 1,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    status TEXT NOT NULL DEFAULT 'salvo', -- 'salvo' | 'substituido'
    uploaded_by INTEGER REFERENCES app_users(id),
    uploaded_at TEXT DEFAULT (datetime('now')),
    reaberto_por INTEGER REFERENCES app_users(id),
    reaberto_em TEXT,
    reaberto_motivo TEXT
  );

  -- Fica marcado no período quando o admin reabre uma pendência, liberando novo upload
  CREATE TABLE IF NOT EXISTS checklist_reaberturas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES checklist_periodos(id) ON DELETE CASCADE,
    item_chave TEXT NOT NULL,
    motivo TEXT,
    reaberto_por INTEGER REFERENCES app_users(id),
    reaberto_em TEXT DEFAULT (datetime('now')),
    resolvido INTEGER NOT NULL DEFAULT 0
  );

  -- ---- Envio de Documentos (sentido contrário de Solicitações: o escritório posta e o cliente recebe) ----
  CREATE TABLE IF NOT EXISTS envio_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL, -- "DARF PIS", "FGTS", "Retenções de Notas Fiscais"...
    descricao TEXT,
    periodicidade TEXT NOT NULL DEFAULT 'mensal', -- 'mensal' | 'anual' | 'avulso'
    accept_json TEXT NOT NULL DEFAULT '["pdf"]',
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS envio_atribuicoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    template_id INTEGER NOT NULL REFERENCES envio_templates(id) ON DELETE CASCADE,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    ativo INTEGER NOT NULL DEFAULT 1,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(template_id, empresa_id)
  );

  CREATE TABLE IF NOT EXISTS envio_periodos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    atribuicao_id INTEGER NOT NULL REFERENCES envio_atribuicoes(id) ON DELETE CASCADE,
    ano INTEGER NOT NULL,
    mes INTEGER,
    rotulo TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(atribuicao_id, ano, mes, rotulo)
  );

  -- Um documento por período (a guia em si) — sem trava: o administrador pode substituir/excluir
  -- se anexou o arquivo errado (quem precisa ficar travado é o anexo que o CLIENTE manda, não o
  -- que o escritório envia — ver memory.md).
  -- Mais de um documento pode existir no mesmo período (ex.: guia original + guia recalculada
  -- porque o cliente não pagou no prazo) — por isso não há UNIQUE(periodo_id) aqui.
  CREATE TABLE IF NOT EXISTS envio_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    periodo_id INTEGER NOT NULL REFERENCES envio_periodos(id) ON DELETE CASCADE,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime TEXT,
    size_bytes INTEGER,
    observacao TEXT, -- ex.: "Guia recalculada — juros/multa atualizados"
    vencimento TEXT, -- 'YYYY-MM-DD', detectado automaticamente do conteúdo do arquivo (editável)
    vencimento_origem TEXT, -- 'automatico' | 'manual'
    enviado_por INTEGER REFERENCES app_users(id),
    enviado_em TEXT DEFAULT (datetime('now')),
    email_enviado INTEGER NOT NULL DEFAULT 0,
    email_erro TEXT
  );

  -- ---- Financeiro (honorários) ----
  CREATE TABLE IF NOT EXISTS honorarios (
    empresa_id INTEGER PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
    valor REAL NOT NULL DEFAULT 0,
    dia_vencimento INTEGER NOT NULL DEFAULT 10,
    ativo INTEGER NOT NULL DEFAULT 1,
    observacao TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS honorarios_lancamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    competencia TEXT NOT NULL, -- 'YYYY-MM'
    valor REAL NOT NULL,
    vencimento TEXT NOT NULL, -- 'YYYY-MM-DD'
    status TEXT NOT NULL DEFAULT 'pendente', -- 'pendente' | 'pago' | 'atrasado' | 'cancelado'
    data_pagamento TEXT,
    forma_pagamento TEXT,
    observacao TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(empresa_id, competencia)
  );

  -- ---- Painel (cards de indicadores configuráveis) ----
  CREATE TABLE IF NOT EXISTS dashboard_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    titulo TEXT NOT NULL,
    valor TEXT NOT NULL,
    subtitulo TEXT,
    cor TEXT DEFAULT 'brass',
    ordem INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  -- ---- Relatórios: cache alimentado pela sincronização com o Domínio Web (ainda não conectado) ----
  CREATE TABLE IF NOT EXISTS dominio_dados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL, -- 'balanco' | 'balancete' | 'dre' | 'faturamento' | 'folha'
    competencia TEXT,
    dados_json TEXT NOT NULL,
    sincronizado_em TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dominio_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    executado_em TEXT DEFAULT (datetime('now')),
    origem TEXT NOT NULL, -- 'importacao-csv' | 'agente'
    empresas_novas INTEGER DEFAULT 0,
    empresas_atualizadas INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ok',
    detalhe TEXT
  );

  CREATE TABLE IF NOT EXISTS agent_heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_seen_at TEXT,
    version TEXT
  );

  -- Configuração de acesso do agente do Domínio Web, editável pela tela Configurações (o agente
  -- busca isso na nuvem a cada ciclo — não precisa mais editar o .env dele na mão).
  CREATE TABLE IF NOT EXISTS dominio_config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    source TEXT NOT NULL DEFAULT '', -- 'db' | 'http' | ''
    db_driver TEXT,        -- 'mssql' | 'oracle'
    db_host TEXT,
    db_port INTEGER,
    db_name TEXT,
    db_user TEXT,
    db_password TEXT,
    db_connect_string TEXT, -- usado no modo oracle (easy connect: host:porta/servico)
    query_clientes TEXT,
    col_codigo TEXT DEFAULT 'CODIGO',
    col_nome TEXT DEFAULT 'NOME',
    col_cnpj TEXT DEFAULT 'CNPJ',
    col_status TEXT DEFAULT 'STATUS',
    api_url TEXT,
    api_token TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS dominio_test_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'ok' | 'erro'
    resultado_json TEXT,
    erro TEXT,
    criado_por INTEGER REFERENCES app_users(id),
    criado_em TEXT DEFAULT (datetime('now')),
    resolvido_em TEXT
  );

  -- ---- E-mail corporativo ----
  -- Documentos (CNPJ/CPF) usados para identificar automaticamente qual cliente é dono de um
  -- arquivo (PDF/OFX/XML) enviado — um cliente pode ter mais de um (ex.: CNPJ da empresa + CPF
  -- de um sócio que aparece em algum extrato).
  CREATE TABLE IF NOT EXISTS empresa_documentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
    documento TEXT NOT NULL, -- só dígitos
    tipo TEXT NOT NULL, -- 'cnpj' | 'cpf'
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(documento)
  );

  CREATE TABLE IF NOT EXISTS emails_enviados (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id INTEGER REFERENCES empresas(id) ON DELETE SET NULL,
    destinatarios TEXT NOT NULL,
    assunto TEXT NOT NULL,
    corpo TEXT,
    anexos_json TEXT,
    enviado_por INTEGER REFERENCES app_users(id),
    enviado_em TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL DEFAULT 'ok',
    erro TEXT
  );

  CREATE TABLE IF NOT EXISTS kv (
    key_name TEXT PRIMARY KEY,
    value_data TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_checklist_periodos_atrib ON checklist_periodos(atribuicao_id);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_checklist_uploads_periodo ON checklist_uploads(periodo_id, item_chave);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_envio_periodos_atrib ON envio_periodos(atribuicao_id);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_honorarios_lanc_competencia ON honorarios_lancamentos(competencia);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_dominio_dados_empresa ON dominio_dados(empresa_id, tipo, competencia);`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_envio_documentos_periodo ON envio_documentos(periodo_id);`);

// Migração: bancos criados antes de 2026-08-18 têm envio_documentos com UNIQUE(periodo_id) e sem
// a coluna observacao — reconstrói a tabela preservando os documentos já enviados, sem essa trava
// (o fluxo de "guia recalculada" precisa de mais de um documento no mesmo período).
{
  const def = sqlite.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='envio_documentos'`).get() as any;
  if (def && /UNIQUE\s*\(\s*periodo_id\s*\)/i.test(def.sql)) {
    sqlite.exec(`
      CREATE TABLE envio_documentos_novo (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        periodo_id INTEGER NOT NULL REFERENCES envio_periodos(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime TEXT,
        size_bytes INTEGER,
        observacao TEXT,
        vencimento TEXT,
        vencimento_origem TEXT,
        enviado_por INTEGER REFERENCES app_users(id),
        enviado_em TEXT DEFAULT (datetime('now')),
        email_enviado INTEGER NOT NULL DEFAULT 0,
        email_erro TEXT
      );
      INSERT INTO envio_documentos_novo (id, periodo_id, file_name, file_path, mime, size_bytes, vencimento, vencimento_origem, enviado_por, enviado_em, email_enviado, email_erro)
      SELECT id, periodo_id, file_name, file_path, mime, size_bytes, vencimento, vencimento_origem, enviado_por, enviado_em, email_enviado, email_erro FROM envio_documentos;
      DROP TABLE envio_documentos;
      ALTER TABLE envio_documentos_novo RENAME TO envio_documentos;
      CREATE INDEX IF NOT EXISTS idx_envio_documentos_periodo ON envio_documentos(periodo_id);
    `);
    console.log("Migração aplicada: envio_documentos agora aceita mais de um documento por período.");
  }
}

const MODULOS = ["dashboard", "empresas", "solicitacoes", "envio", "financeiro", "relatorios", "usuarios", "configuracoes"] as const;
type Modulo = (typeof MODULOS)[number];

// ========================= LOGIN (senha com hash + sessão via cookie) =========================
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(check, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const SESSION_DAYS = 7;
function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  sqlite.prepare(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`).run(token, userId, expiresAt);
  return token;
}
function getSessionUser(token: string | undefined) {
  if (!token) return null;
  const row = sqlite
    .prepare(
      `SELECT s.expires_at as expiresAt, u.id, u.nome, u.email, u.perfil, u.empresa_id as empresaId,
              u.acesso_todas_empresas as acessoTodasEmpresas, u.ativo
       FROM sessions s JOIN app_users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as any;
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date() || !row.ativo) {
    sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  return {
    id: row.id,
    nome: row.nome,
    email: row.email,
    perfil: row.perfil as "Administrador" | "Colaborador" | "Cliente",
    empresaId: row.empresaId as number | null,
    acessoTodasEmpresas: !!row.acessoTodasEmpresas,
  };
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = getSessionUser(req.cookies?.sid);
  if (!user) return res.status(401).json({ error: "Sessão expirada. Faça login novamente." });
  (req as any).user = user;
  next();
}
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.perfil !== "Administrador") {
    return res.status(403).json({ error: "Só administradores podem fazer isso." });
  }
  next();
}
// Bloqueia clientes de qualquer rota interna do escritório
function blockCliente(req: express.Request, res: express.Response, next: express.NextFunction) {
  if ((req as any).user?.perfil === "Cliente") return res.status(403).json({ error: "Acesso não permitido para este perfil." });
  next();
}
function hasPermissao(user: any, modulo: Modulo, acao: "visualizar" | "postar" | "editar"): boolean {
  if (user.perfil === "Administrador") return true;
  if (user.perfil === "Cliente") return false;
  const row = sqlite
    .prepare(`SELECT pode_visualizar, pode_postar, pode_editar FROM colaborador_permissoes WHERE user_id = ? AND modulo = ?`)
    .get(user.id, modulo) as any;
  if (!row) return false;
  if (acao === "visualizar") return !!row.pode_visualizar;
  if (acao === "postar") return !!row.pode_postar;
  return !!row.pode_editar;
}
function requirePermissao(modulo: Modulo, acao: "visualizar" | "postar" | "editar") {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!hasPermissao(user, modulo, acao)) {
      return res.status(403).json({ error: "Você não tem permissão para fazer isso." });
    }
    next();
  };
}
// IDs de empresa que este usuário pode enxergar (null = todas)
function empresasVisiveis(user: any): number[] | null {
  if (user.perfil === "Administrador") return null;
  if (user.perfil === "Cliente") return user.empresaId ? [user.empresaId] : [];
  if (user.acessoTodasEmpresas) return null;
  const rows = sqlite.prepare(`SELECT empresa_id FROM colaborador_empresas WHERE user_id = ?`).all(user.id) as any[];
  return rows.map((r) => r.empresa_id);
}
function podeAcessarEmpresa(user: any, empresaId: number): boolean {
  const ids = empresasVisiveis(user);
  return ids === null || ids.includes(empresaId);
}

// Usado pra bloquear exclusão de empresa/atribuição que já tem histórico real de documentos —
// nesse caso o caminho é inativar (não apaga nada), não excluir.
function atribuicaoTemAnexos(atribuicaoId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM checklist_uploads u JOIN checklist_periodos p ON p.id = u.periodo_id
         WHERE p.atribuicao_id = ?
       ) as tem`
    )
    .get(atribuicaoId) as any;
  return !!row.tem;
}
function empresaTemAnexos(empresaId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM checklist_uploads u
         JOIN checklist_periodos p ON p.id = u.periodo_id
         JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id
         WHERE a.empresa_id = ?
       ) as tem`
    )
    .get(empresaId) as any;
  if (row.tem) return true;
  return empresaTemDocumentosEnviados(empresaId);
}
function envioAtribuicaoTemDocumentos(atribuicaoId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id
         WHERE p.atribuicao_id = ?
       ) as tem`
    )
    .get(atribuicaoId) as any;
  return !!row.tem;
}
function empresaTemDocumentosEnviados(empresaId: number): boolean {
  const row = sqlite
    .prepare(
      `SELECT EXISTS(
         SELECT 1 FROM envio_documentos d
         JOIN envio_periodos p ON p.id = d.periodo_id
         JOIN envio_atribuicoes a ON a.id = p.atribuicao_id
         WHERE a.empresa_id = ?
       ) as tem`
    )
    .get(empresaId) as any;
  return !!row.tem;
}

function passwordPolicyError(password: string): string | null {
  const p = String(password || "");
  if (p.length < 10) return "A senha precisa ter pelo menos 10 caracteres.";
  if (!/[a-zA-Z]/.test(p) || !/[0-9]/.test(p)) return "A senha precisa ter letras e números.";
  return null;
}
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de login. Aguarde alguns minutos e tente de novo." },
});

// Bootstrap opcional do primeiro administrador via .env (só roda se não houver nenhum usuário ainda)
function bootstrapAdmin() {
  const count = (sqlite.prepare(`SELECT COUNT(*) as c FROM app_users`).get() as any).c;
  if (count > 0) return;
  const email = process.env.ADMIN_EMAIL, nome = process.env.ADMIN_NOME, password = process.env.ADMIN_PASSWORD;
  if (!email || !nome || !password) {
    console.warn("Nenhum usuário cadastrado ainda. Defina ADMIN_EMAIL, ADMIN_NOME e ADMIN_PASSWORD no .env para criar o primeiro administrador automaticamente.");
    return;
  }
  sqlite
    .prepare(`INSERT INTO app_users (nome, email, perfil, password_hash, acesso_todas_empresas) VALUES (?, ?, 'Administrador', ?, 1)`)
    .run(nome, String(email).trim().toLowerCase(), hashPassword(password));
  console.log(`Administrador inicial criado: ${email}`);
}
bootstrapAdmin();

// ========================= ANEXOS (tipos aceitos por slot do checklist) =========================
const ACCEPT_EXT: Record<string, string[]> = {
  ofx: [".ofx"],
  pdf: [".pdf"],
  zip: [".zip", ".rar", ".7z"],
  xml: [".xml"],
  imagem: [".png", ".jpg", ".jpeg"],
  qualquer: [], // sem restrição
};
function extensaoPermitida(accept: string[], fileName: string): boolean {
  if (!accept || !accept.length || accept.includes("qualquer")) return true;
  const ext = path.extname(fileName).toLowerCase();
  return accept.some((tipo) => (ACCEPT_EXT[tipo] || []).includes(ext));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB por arquivo — extratos/PDFs de bancos não passam disso
});

function empresaSlotDir(empresaId: number, periodoId: number) {
  return path.join(UPLOADS_DIR, String(empresaId), String(periodoId));
}

// ========================= E-MAIL CORPORATIVO =========================
function emailConfigurado(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD);
}
let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!emailConfigurado()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    });
  }
  return transporter;
}
async function enviarEmail(opts: { to: string[]; subject: string; text: string; attachments?: { filename: string; content: Buffer }[] }) {
  const t = getTransporter();
  if (!t) throw new Error("E-mail corporativo não configurado (defina SMTP_HOST/SMTP_USER/SMTP_PASSWORD no .env).");
  const fromName = process.env.SMTP_FROM_NAME || "Simples Contábeis";
  const fromEmail = process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER;
  await t.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to: opts.to.join(", "),
    subject: opts.subject,
    text: opts.text,
    attachments: opts.attachments,
  });
}

// ========================= APP =========================
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "20mb" }));
app.use(cookieParser());
// cacheControl:false — o site é uma página só, ainda em ajuste frequente; sem isso o navegador
// segura uma cópia velha do app.html em cache e mudanças de UI não aparecem sem hard refresh.
app.use(express.static(path.join(__dirname, "..", "public"), { cacheControl: false }));

app.get("/", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "..", "public", "app.html"));
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------- Autenticação ----------
app.post("/api/auth/login", loginRateLimiter, (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "Informe e-mail e senha." });
  const row = sqlite.prepare(`SELECT * FROM app_users WHERE email = ?`).get(String(email).trim().toLowerCase()) as any;
  if (!row || !row.ativo || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: "E-mail ou senha inválidos." });
  }
  const token = createSession(row.id);
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000 });
  res.json({ ok: true, user: { id: row.id, nome: row.nome, email: row.email, perfil: row.perfil, empresaId: row.empresa_id } });
});
app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.sid;
  if (token) sqlite.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
  res.clearCookie("sid");
  res.json({ ok: true });
});
app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req.cookies?.sid);
  if (!user) return res.status(401).json({ error: "Não autenticado." });
  let permissoes: Record<string, { visualizar: boolean; postar: boolean; editar: boolean }> = {};
  if (user.perfil === "Administrador") {
    for (const m of MODULOS) permissoes[m] = { visualizar: true, postar: true, editar: true };
  } else if (user.perfil === "Colaborador") {
    const rows = sqlite.prepare(`SELECT * FROM colaborador_permissoes WHERE user_id = ?`).all(user.id) as any[];
    for (const m of MODULOS) permissoes[m] = { visualizar: false, postar: false, editar: false };
    for (const r of rows) permissoes[r.modulo] = { visualizar: !!r.pode_visualizar, postar: !!r.pode_postar, editar: !!r.pode_editar };
  }
  res.json({ user, permissoes });
});
app.post("/api/auth/change-password", requireAuth, (req, res) => {
  const { senhaAtual, novaSenha } = req.body || {};
  const uid = (req as any).user.id;
  const row = sqlite.prepare(`SELECT * FROM app_users WHERE id = ?`).get(uid) as any;
  if (!row || !verifyPassword(senhaAtual || "", row.password_hash)) {
    return res.status(401).json({ error: "Senha atual incorreta." });
  }
  const pwError = passwordPolicyError(novaSenha);
  if (pwError) return res.status(400).json({ error: pwError });
  sqlite.prepare(`UPDATE app_users SET password_hash = ? WHERE id = ?`).run(hashPassword(novaSenha), uid);
  res.json({ ok: true });
});

app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/auth/") || req.path === "/health" || req.path.startsWith("/dominio-agent/")) return next();
  requireAuth(req, res, next);
});

// ---------- Usuários (Administrador cadastra Colaboradores e Clientes) ----------
app.get("/api/users", requireAdmin, (_req, res) => {
  const rows = sqlite
    .prepare(
      `SELECT u.id, u.nome, u.email, u.perfil, u.empresa_id as empresaId, e.nome as empresaNome,
              u.acesso_todas_empresas as acessoTodasEmpresas, u.ativo, u.created_at as createdAt
       FROM app_users u LEFT JOIN empresas e ON e.id = u.empresa_id ORDER BY u.perfil, u.nome`
    )
    .all();
  res.json({ items: rows });
});
app.post("/api/users", requireAdmin, (req, res) => {
  const { nome, email, perfil, password, empresaId, acessoTodasEmpresas } = req.body || {};
  if (!nome || !email || !perfil || !password) return res.status(400).json({ error: "Preencha nome, e-mail, perfil e senha." });
  if (!["Administrador", "Colaborador", "Cliente"].includes(perfil)) return res.status(400).json({ error: "Perfil inválido." });
  if (perfil === "Cliente" && !empresaId) return res.status(400).json({ error: "Selecione a empresa do cliente." });
  const pwError = passwordPolicyError(password);
  if (pwError) return res.status(400).json({ error: pwError });
  try {
    const info = sqlite
      .prepare(`INSERT INTO app_users (nome, email, perfil, empresa_id, acesso_todas_empresas, password_hash) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        nome,
        String(email).trim().toLowerCase(),
        perfil,
        perfil === "Cliente" ? Number(empresaId) : null,
        perfil === "Colaborador" ? (acessoTodasEmpresas === false ? 0 : 1) : 1,
        hashPassword(password)
      );
    const userId = Number(info.lastInsertRowid);
    if (perfil === "Colaborador") {
      for (const m of MODULOS) {
        sqlite
          .prepare(`INSERT INTO colaborador_permissoes (user_id, modulo, pode_visualizar, pode_postar, pode_editar) VALUES (?, ?, 0, 0, 0)`)
          .run(userId, m);
      }
    }
    res.json({ id: userId });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um usuário com esse e-mail." });
    res.status(500).json({ error: e.message });
  }
});
app.put("/api/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM app_users WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Usuário não encontrado." });
  const { nome, email, password, ativo, empresaId, acessoTodasEmpresas } = req.body || {};
  if (password) {
    const pwError = passwordPolicyError(password);
    if (pwError) return res.status(400).json({ error: pwError });
  }
  const newHash = password ? hashPassword(password) : existing.password_hash;
  try {
    sqlite
      .prepare(`UPDATE app_users SET nome=?, email=?, password_hash=?, ativo=?, empresa_id=?, acesso_todas_empresas=? WHERE id=?`)
      .run(
        nome ?? existing.nome,
        email ? String(email).trim().toLowerCase() : existing.email,
        newHash,
        ativo === undefined ? existing.ativo : ativo ? 1 : 0,
        existing.perfil === "Cliente" ? (empresaId !== undefined ? Number(empresaId) : existing.empresa_id) : existing.empresa_id,
        acessoTodasEmpresas !== undefined ? (acessoTodasEmpresas ? 1 : 0) : existing.acesso_todas_empresas,
        id
      );
    if (ativo === false) sqlite.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
    res.json({ ok: true });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Já existe um usuário com esse e-mail." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  sqlite.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(id);
  sqlite.prepare(`DELETE FROM app_users WHERE id = ?`).run(id);
  res.json({ id });
});
app.get("/api/users/:id/permissoes", requireAdmin, (req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM colaborador_permissoes WHERE user_id = ?`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.put("/api/users/:id/permissoes", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const permissoes = req.body?.permissoes || {};
  const stmt = sqlite.prepare(
    `INSERT INTO colaborador_permissoes (user_id, modulo, pode_visualizar, pode_postar, pode_editar) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, modulo) DO UPDATE SET pode_visualizar=excluded.pode_visualizar, pode_postar=excluded.pode_postar, pode_editar=excluded.pode_editar`
  );
  for (const m of MODULOS) {
    const p = permissoes[m] || {};
    stmt.run(userId, m, p.visualizar ? 1 : 0, p.postar ? 1 : 0, p.editar ? 1 : 0);
  }
  res.json({ ok: true });
});
app.get("/api/users/:id/empresas", requireAdmin, (req, res) => {
  const rows = sqlite.prepare(`SELECT empresa_id as empresaId FROM colaborador_empresas WHERE user_id = ?`).all(Number(req.params.id)) as any[];
  res.json({ empresaIds: rows.map((r) => r.empresaId) });
});
app.put("/api/users/:id/empresas", requireAdmin, (req, res) => {
  const userId = Number(req.params.id);
  const empresaIds: number[] = Array.isArray(req.body?.empresaIds) ? req.body.empresaIds.map(Number) : [];
  sqlite.prepare(`DELETE FROM colaborador_empresas WHERE user_id = ?`).run(userId);
  const stmt = sqlite.prepare(`INSERT INTO colaborador_empresas (user_id, empresa_id) VALUES (?, ?)`);
  for (const eid of empresaIds) stmt.run(userId, eid);
  res.json({ ok: true });
});

// ---------- Empresas (clientes do escritório) ----------
app.get("/api/empresas", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const visiveis = empresasVisiveis(user);
  let rows = sqlite
    .prepare(`SELECT * FROM empresas ORDER BY nome`)
    .all() as any[];
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.id));
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      nome: r.nome,
      cnpj: r.cnpj,
      codigoDominio: r.codigo_dominio,
      ativo: !!r.ativo,
      visivelRelatorios: !!r.visivel_relatorios,
      origem: r.origem,
      createdAt: r.created_at,
      temAnexos: empresaTemAnexos(r.id),
    })),
  });
});
app.post("/api/empresas", blockCliente, requirePermissao("empresas", "postar"), (req, res) => {
  const { nome, cnpj, codigoDominio } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome da empresa." });
  const info = sqlite
    .prepare(`INSERT INTO empresas (nome, cnpj, codigo_dominio, origem) VALUES (?, ?, ?, 'manual')`)
    .run(nome, cnpj || null, codigoDominio || null);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/empresas/:id", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM empresas WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Empresa não encontrada." });
  const { nome, cnpj, codigoDominio, ativo, visivelRelatorios } = req.body || {};
  sqlite
    .prepare(`UPDATE empresas SET nome=?, cnpj=?, codigo_dominio=?, ativo=?, visivel_relatorios=?, updated_at=datetime('now') WHERE id=?`)
    .run(
      nome ?? existing.nome,
      cnpj !== undefined ? cnpj : existing.cnpj,
      codigoDominio !== undefined ? codigoDominio : existing.codigo_dominio,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      visivelRelatorios === undefined ? existing.visivel_relatorios : visivelRelatorios ? 1 : 0,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/empresas/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (empresaTemAnexos(id)) {
    return res.status(409).json({ error: "Esta empresa já tem documentos anexados e não pode ser excluída. Use \"Inativar\" em vez disso." });
  }
  sqlite.prepare(`DELETE FROM empresas WHERE id = ?`).run(id);
  res.json({ id });
});
app.get("/api/empresas/:id/contatos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM empresa_contatos WHERE empresa_id = ? ORDER BY nome`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.post("/api/empresas/:id/contatos", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  const { nome, email, receberEmails } = req.body || {};
  if (!nome || !email) return res.status(400).json({ error: "Informe nome e e-mail do contato." });
  const info = sqlite
    .prepare(`INSERT INTO empresa_contatos (empresa_id, nome, email, receber_emails) VALUES (?, ?, ?, ?)`)
    .run(empresaId, nome, email, receberEmails === false ? 0 : 1);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.delete("/api/empresas/contatos/:contatoId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  sqlite.prepare(`DELETE FROM empresa_contatos WHERE id = ?`).run(Number(req.params.contatoId));
  res.json({ ok: true });
});

// CNPJ/CPF cadastrados por empresa — usados para identificar automaticamente o dono de um arquivo enviado
app.get("/api/empresas/:id/documentos", blockCliente, requirePermissao("empresas", "visualizar"), (req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM empresa_documentos WHERE empresa_id = ? ORDER BY tipo, documento`).all(Number(req.params.id));
  res.json({ items: rows });
});
app.post("/api/empresas/:id/documentos", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  const empresaId = Number(req.params.id);
  const digitos = String(req.body?.documento || "").replace(/\D/g, "");
  if (digitos.length !== 11 && digitos.length !== 14) return res.status(400).json({ error: "Informe um CNPJ (14 dígitos) ou CPF (11 dígitos) válido." });
  const tipo = digitos.length === 14 ? "cnpj" : "cpf";
  try {
    const info = sqlite.prepare(`INSERT INTO empresa_documentos (empresa_id, documento, tipo) VALUES (?, ?, ?)`).run(empresaId, digitos, tipo);
    res.json({ id: Number(info.lastInsertRowid), documento: digitos, tipo });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este documento já está cadastrado em outra empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/empresas/documentos/:docId", blockCliente, requirePermissao("empresas", "editar"), (req, res) => {
  sqlite.prepare(`DELETE FROM empresa_documentos WHERE id = ?`).run(Number(req.params.docId));
  res.json({ ok: true });
});

// Importação da lista de clientes exportada do Domínio Web (CSV: codigo;nome;cnpj;status)
app.post("/api/dominio/importar-clientes", requireAdmin, upload.single("arquivo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie o arquivo CSV exportado do Domínio Web." });
  const texto = req.file.buffer.toString("utf8").replace(/\r/g, "");
  const linhas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return res.status(400).json({ error: "Arquivo vazio." });
  const sep = linhas[0].includes(";") ? ";" : ",";
  const header = linhas[0].toLowerCase().split(sep).map((h) => h.trim());
  const idxCodigo = header.findIndex((h) => h.includes("codigo") || h.includes("código"));
  const idxNome = header.findIndex((h) => h.includes("nome") || h.includes("razao") || h.includes("razão"));
  const idxCnpj = header.findIndex((h) => h.includes("cnpj"));
  const idxStatus = header.findIndex((h) => h.includes("status") || h.includes("situacao") || h.includes("situação") || h.includes("ativo"));
  if (idxNome === -1) return res.status(400).json({ error: "Não encontrei a coluna de nome/razão social no CSV." });

  let novas = 0, atualizadas = 0;
  const getByCodigo = sqlite.prepare(`SELECT id FROM empresas WHERE codigo_dominio = ?`);
  const getByNome = sqlite.prepare(`SELECT id FROM empresas WHERE LOWER(nome) = LOWER(?)`);
  const insert = sqlite.prepare(`INSERT INTO empresas (nome, cnpj, codigo_dominio, ativo, origem) VALUES (?, ?, ?, ?, 'dominio')`);
  const update = sqlite.prepare(
    `UPDATE empresas SET nome=?, cnpj=COALESCE(?, cnpj), codigo_dominio=COALESCE(?, codigo_dominio), ativo=?, updated_at=datetime('now') WHERE id=?`
  );

  for (let i = 1; i < linhas.length; i++) {
    const cols = linhas[i].split(sep).map((c) => c.trim());
    const nome = idxNome >= 0 ? cols[idxNome] : "";
    if (!nome) continue;
    const codigo = idxCodigo >= 0 ? cols[idxCodigo] : null;
    const cnpj = idxCnpj >= 0 ? cols[idxCnpj] : null;
    const statusTxt = (idxStatus >= 0 ? cols[idxStatus] : "").toLowerCase();
    const ativo = statusTxt ? (statusTxt.includes("inativ") || statusTxt.includes("encerrad") || statusTxt === "0" || statusTxt === "n" ? 0 : 1) : 1;

    const existente = (codigo ? getByCodigo.get(codigo) : undefined) || getByNome.get(nome);
    if (existente) {
      update.run(nome, cnpj || null, codigo || null, ativo, (existente as any).id);
      atualizadas++;
    } else {
      insert.run(nome, cnpj || null, codigo || null, ativo);
      novas++;
    }
  }
  sqlite
    .prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status) VALUES ('importacao-csv', ?, ?, 'ok')`)
    .run(novas, atualizadas);
  res.json({ ok: true, novas, atualizadas });
});
app.get("/api/dominio/sync-log", requireAdmin, (_req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM dominio_sync_log ORDER BY id DESC LIMIT 30`).all();
  const heartbeat = sqlite.prepare(`SELECT last_seen_at as lastSeenAt, version FROM agent_heartbeat WHERE id = 1`).get() as any;
  res.json({ items: rows, agente: heartbeat || null });
});

// ---------- Configuração de acesso do src/dominio-agent.ts (editável pela tela, sem mexer no .env) ----------
function getDominioConfig(): any {
  return sqlite.prepare(`SELECT * FROM dominio_config WHERE id = 1`).get() || {};
}
app.get("/api/dominio/config", requireAdmin, (_req, res) => {
  const c = getDominioConfig();
  res.json({
    source: c.source || "",
    dbDriver: c.db_driver || "",
    dbHost: c.db_host || "",
    dbPort: c.db_port || "",
    dbName: c.db_name || "",
    dbUser: c.db_user || "",
    temSenhaBanco: !!c.db_password,
    dbConnectString: c.db_connect_string || "",
    queryClientes: c.query_clientes || "",
    colCodigo: c.col_codigo || "CODIGO",
    colNome: c.col_nome || "NOME",
    colCnpj: c.col_cnpj || "CNPJ",
    colStatus: c.col_status || "STATUS",
    apiUrl: c.api_url || "",
    temTokenApi: !!c.api_token,
    updatedAt: c.updated_at || null,
  });
});
app.put("/api/dominio/config", requireAdmin, (req, res) => {
  const b = req.body || {};
  const atual = getDominioConfig();
  sqlite
    .prepare(
      `INSERT INTO dominio_config (id, source, db_driver, db_host, db_port, db_name, db_user, db_password, db_connect_string, query_clientes, col_codigo, col_nome, col_cnpj, col_status, api_url, api_token, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET source=excluded.source, db_driver=excluded.db_driver, db_host=excluded.db_host,
         db_port=excluded.db_port, db_name=excluded.db_name, db_user=excluded.db_user,
         db_password=excluded.db_password, db_connect_string=excluded.db_connect_string,
         query_clientes=excluded.query_clientes, col_codigo=excluded.col_codigo, col_nome=excluded.col_nome,
         col_cnpj=excluded.col_cnpj, col_status=excluded.col_status, api_url=excluded.api_url,
         api_token=excluded.api_token, updated_at=datetime('now')`
    )
    .run(
      b.source || "",
      b.dbDriver || null,
      b.dbHost || null,
      b.dbPort ? Number(b.dbPort) : null,
      b.dbName || null,
      b.dbUser || null,
      b.dbPassword ? String(b.dbPassword) : atual.db_password || null, // vazio = mantém a senha já salva
      b.dbConnectString || null,
      b.queryClientes || null,
      b.colCodigo || "CODIGO",
      b.colNome || "NOME",
      b.colCnpj || "CNPJ",
      b.colStatus || "STATUS",
      b.apiUrl || null,
      b.apiToken ? String(b.apiToken) : atual.api_token || null
    );
  res.json({ ok: true });
});
// Pede pro agente testar a conexão agora (o teste roda na máquina do agente, não na nuvem —
// ela é quem tem acesso à rede do Domínio Web). O front faz polling neste id até status != pending.
app.post("/api/dominio/testar-conexao", requireAdmin, (req, res) => {
  const user = (req as any).user;
  const info = sqlite.prepare(`INSERT INTO dominio_test_jobs (status, criado_por) VALUES ('pending', ?)`).run(user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.get("/api/dominio/testar-conexao/:id", requireAdmin, (req, res) => {
  const row = sqlite.prepare(`SELECT * FROM dominio_test_jobs WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!row) return res.status(404).json({ error: "Teste não encontrado." });
  res.json({ status: row.status, resultado: row.resultado_json ? JSON.parse(row.resultado_json) : null, erro: row.erro });
});

// ---------- Checklist / Solicitações ----------
app.get("/api/checklist/templates", blockCliente, requirePermissao("solicitacoes", "visualizar"), (_req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM checklist_templates ORDER BY nome`).all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itens_json) })) });
});
app.post("/api/checklist/templates", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const user = (req as any).user;
  const { nome, descricao, periodicidade, itens, notificarEmail } = req.body || {};
  if (!nome || !Array.isArray(itens) || !itens.length) return res.status(400).json({ error: "Informe o nome e ao menos um item para anexar." });
  const itensNormalizados = itens.map((it: any, i: number) => ({
    chave: it.chave || `item${i + 1}`,
    label: it.label || `Item ${i + 1}`,
    accept: Array.isArray(it.accept) && it.accept.length ? it.accept : ["qualquer"],
    obrigatorio: it.obrigatorio !== false,
  }));
  const info = sqlite
    .prepare(`INSERT INTO checklist_templates (nome, descricao, periodicidade, itens_json, notificar_email, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(nome, descricao || null, periodicidade || "mensal", JSON.stringify(itensNormalizados), notificarEmail ? 1 : 0, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/checklist/templates/:id", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM checklist_templates WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const { nome, descricao, itens, notificarEmail, ativo } = req.body || {};
  const itensJson = Array.isArray(itens) ? JSON.stringify(itens) : existing.itens_json;
  sqlite
    .prepare(`UPDATE checklist_templates SET nome=?, descricao=?, itens_json=?, notificar_email=?, ativo=? WHERE id=?`)
    .run(
      nome ?? existing.nome,
      descricao !== undefined ? descricao : existing.descricao,
      itensJson,
      notificarEmail === undefined ? existing.notificar_email : notificarEmail ? 1 : 0,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/checklist/templates/:id", requireAdmin, (req, res) => {
  sqlite.prepare(`DELETE FROM checklist_templates WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/checklist/atribuicoes", blockCliente, requirePermissao("solicitacoes", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  let sql = `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
             FROM checklist_atribuicoes a
             JOIN checklist_templates t ON t.id = a.template_id
             JOIN empresas e ON e.id = a.empresa_id`;
  const params: any[] = [];
  if (empresaId) {
    sql += ` WHERE a.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY e.nome, t.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itensJson), temAnexos: atribuicaoTemAnexos(r.id) })) });
});
// Cliente: lista só as próprias atribuições (a rota acima é bloqueada para este perfil)
app.get("/api/checklist/minhas-atribuicoes", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const rows = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
       FROM checklist_atribuicoes a
       JOIN checklist_templates t ON t.id = a.template_id
       JOIN empresas e ON e.id = a.empresa_id
       WHERE a.empresa_id = ? AND a.ativo = 1 ORDER BY t.nome`
    )
    .all(user.empresaId) as any[];
  res.json({ items: rows.map((r) => ({ ...r, itens: JSON.parse(r.itensJson) })) });
});

app.post("/api/checklist/atribuicoes", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const user = (req as any).user;
  const { templateId, empresaId } = req.body || {};
  if (!templateId || !empresaId) return res.status(400).json({ error: "Selecione o modelo e a empresa." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  try {
    const info = sqlite
      .prepare(`INSERT INTO checklist_atribuicoes (template_id, empresa_id, created_by) VALUES (?, ?, ?)`)
      .run(Number(templateId), Number(empresaId), user.id);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este modelo já está atribuído a esta empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/checklist/atribuicoes/:id", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const id = Number(req.params.id);
  if (atribuicaoTemAnexos(id)) {
    return res.status(409).json({ error: "Já existe documento anexado nesta solicitação — não é possível excluir." });
  }
  sqlite.prepare(`DELETE FROM checklist_atribuicoes WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// Gera os períodos de um ano (12 meses, 1 anual, ou 1 avulso com rótulo customizado)
app.post("/api/checklist/periodos/gerar", blockCliente, requirePermissao("solicitacoes", "postar"), (req, res) => {
  const { atribuicaoId, ano, rotulo } = req.body || {};
  const atrib = sqlite.prepare(`SELECT a.*, t.periodicidade FROM checklist_atribuicoes a JOIN checklist_templates t ON t.id = a.template_id WHERE a.id = ?`).get(Number(atribuicaoId)) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO checklist_periodos (atribuicao_id, ano, mes, rotulo) VALUES (?, ?, ?, ?)`);
  let criados = 0;
  if (atrib.periodicidade === "mensal") {
    for (let mes = 1; mes <= 12; mes++) {
      const info = insert.run(atrib.id, Number(ano), mes, null);
      if (info.changes) criados++;
    }
  } else if (atrib.periodicidade === "anual") {
    const info = insert.run(atrib.id, Number(ano), null, null);
    if (info.changes) criados++;
  } else {
    // avulso: cada chamada cria uma solicitação pontual nova com rótulo próprio (ex.: "Extrato de Financiamento nº 4521")
    const info = insert.run(atrib.id, Number(ano) || new Date().getFullYear(), null, rotulo || `Solicitação avulsa ${Date.now()}`);
    if (info.changes) criados++;
  }
  res.json({ ok: true, criados });
});

// Grade completa (períodos + status de upload de cada item) de uma atribuição — usada tanto pelo admin quanto pelo cliente
app.get("/api/checklist/grade/:atribuicaoId", (req, res) => {
  const user = (req as any).user;
  const atribuicaoId = Number(req.params.atribuicaoId);
  const atrib = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.itens_json as itensJson, e.nome as empresaNome
       FROM checklist_atribuicoes a JOIN checklist_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id WHERE a.id = ?`
    )
    .get(atribuicaoId) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (user.perfil === "Cliente" && user.empresaId !== atrib.empresa_id) return res.status(403).json({ error: "Sem acesso." });
  if (user.perfil === "Colaborador" && !hasPermissao(user, "solicitacoes", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
  if (user.perfil !== "Cliente" && !podeAcessarEmpresa(user, atrib.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const periodos = sqlite.prepare(`SELECT * FROM checklist_periodos WHERE atribuicao_id = ? ORDER BY ano DESC, mes ASC`).all(atribuicaoId) as any[];
  const periodoIds = periodos.map((p) => p.id);
  const uploads = periodoIds.length
    ? (sqlite
        .prepare(
          `SELECT * FROM checklist_uploads WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) AND status = 'salvo' ORDER BY id DESC`
        )
        .all(...periodoIds) as any[])
    : [];
  const reaberturasAbertas = periodoIds.length
    ? (sqlite
        .prepare(`SELECT * FROM checklist_reaberturas WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) AND resolvido = 0`)
        .all(...periodoIds) as any[])
    : [];

  const uploadsPorSlot = new Map<string, any>();
  for (const u of uploads) {
    const key = `${u.periodo_id}:${u.item_chave}`;
    if (!uploadsPorSlot.has(key)) uploadsPorSlot.set(key, u); // primeiro = mais recente, por causa do ORDER BY id DESC
  }
  const reaberturaPorSlot = new Map<string, any>();
  for (const r of reaberturasAbertas) reaberturaPorSlot.set(`${r.periodo_id}:${r.item_chave}`, r);

  const itens = JSON.parse(atrib.itensJson);
  const grade = periodos.map((p) => ({
    periodoId: p.id,
    ano: p.ano,
    mes: p.mes,
    rotulo: p.rotulo,
    slots: itens.map((it: any) => {
      const key = `${p.id}:${it.chave}`;
      const uploadAtual = uploadsPorSlot.get(key);
      const reaberto = reaberturaPorSlot.get(key);
      return {
        chave: it.chave,
        label: it.label,
        accept: it.accept,
        obrigatorio: it.obrigatorio,
        travado: !!uploadAtual && !reaberto,
        reaberto: !!reaberto,
        motivoReabertura: reaberto?.motivo || null,
        upload: uploadAtual
          ? {
              id: uploadAtual.id,
              fileName: uploadAtual.file_name,
              sizeBytes: uploadAtual.size_bytes,
              uploadedAt: uploadAtual.uploaded_at,
            }
          : null,
      };
    }),
  }));

  res.json({
    atribuicao: { id: atrib.id, templateNome: atrib.templateNome, periodicidade: atrib.periodicidade, empresaNome: atrib.empresaNome, empresaId: atrib.empresa_id },
    grade,
  });
});

// Cliente (ou colaborador com permissão) anexa e salva um arquivo num slot — trava automaticamente após salvar
app.post("/api/checklist/periodos/:periodoId/upload", upload.single("arquivo"), (req, res) => {
  const user = (req as any).user;
  const periodoId = Number(req.params.periodoId);
  const itemChave = String(req.body?.itemChave || "");
  if (!req.file || !itemChave) return res.status(400).json({ error: "Selecione o arquivo e o item correspondente." });

  const periodo = sqlite
    .prepare(`SELECT p.*, a.empresa_id as empresaId, t.itens_json as itensJson FROM checklist_periodos p
               JOIN checklist_atribuicoes a ON a.id = p.atribuicao_id JOIN checklist_templates t ON t.id = a.template_id WHERE p.id = ?`)
    .get(periodoId) as any;
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });

  if (user.perfil === "Cliente") {
    // Cliente sempre pode postar na própria empresa — não passa pelo requirePermissao de colaborador.
    if (user.empresaId !== periodo.empresaId) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  } else if (user.perfil === "Colaborador") {
    if (!hasPermissao(user, "solicitacoes", "postar")) return res.status(403).json({ error: "Sem permissão para anexar." });
    if (!podeAcessarEmpresa(user, periodo.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  }

  const itens = JSON.parse(periodo.itensJson);
  const item = itens.find((it: any) => it.chave === itemChave);
  if (!item) return res.status(400).json({ error: "Item inválido." });
  if (!extensaoPermitida(item.accept, req.file.originalname)) {
    return res.status(400).json({ error: `Tipo de arquivo não permitido para "${item.label}". Aceito: ${item.accept.join(", ")}.` });
  }

  const jaSalvo = sqlite
    .prepare(`SELECT * FROM checklist_uploads WHERE periodo_id = ? AND item_chave = ? AND status = 'salvo' ORDER BY id DESC LIMIT 1`)
    .get(periodoId, itemChave) as any;
  const reabertura = sqlite
    .prepare(`SELECT * FROM checklist_reaberturas WHERE periodo_id = ? AND item_chave = ? AND resolvido = 0 ORDER BY id DESC LIMIT 1`)
    .get(periodoId, itemChave) as any;
  if (jaSalvo && !reabertura) {
    return res.status(409).json({ error: "Este documento já foi enviado e está travado. Peça ao administrador para reabrir a solicitação." });
  }

  const versao = jaSalvo ? jaSalvo.versao + 1 : 1;
  const dir = empresaSlotDir(periodo.empresaId, periodoId);
  fs.mkdirSync(dir, { recursive: true });
  const nomeSeguro = `${itemChave}_v${versao}_${Date.now()}${path.extname(req.file.originalname)}`;
  const destino = path.join(dir, nomeSeguro);
  fs.writeFileSync(destino, req.file.buffer);

  if (jaSalvo) sqlite.prepare(`UPDATE checklist_uploads SET status = 'substituido' WHERE id = ?`).run(jaSalvo.id);
  const info = sqlite
    .prepare(
      `INSERT INTO checklist_uploads (periodo_id, item_chave, versao, file_name, file_path, mime, size_bytes, status, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'salvo', ?)`
    )
    .run(periodoId, itemChave, versao, req.file.originalname, destino, req.file.mimetype, req.file.size, user.id);
  if (reabertura) sqlite.prepare(`UPDATE checklist_reaberturas SET resolvido = 1 WHERE id = ?`).run(reabertura.id);

  res.json({ id: Number(info.lastInsertRowid), ok: true });
});

// Reabertura (só administrador ou colaborador com permissão de editar): destrava o slot sem apagar o histórico
app.post("/api/checklist/uploads/:uploadId/reabrir", blockCliente, requirePermissao("solicitacoes", "editar"), (req, res) => {
  const user = (req as any).user;
  const uploadId = Number(req.params.uploadId);
  const { motivo } = req.body || {};
  const uploadRow = sqlite.prepare(`SELECT * FROM checklist_uploads WHERE id = ?`).get(uploadId) as any;
  if (!uploadRow) return res.status(404).json({ error: "Anexo não encontrado." });
  sqlite
    .prepare(`UPDATE checklist_uploads SET reaberto_por = ?, reaberto_em = datetime('now'), reaberto_motivo = ? WHERE id = ?`)
    .run(user.id, motivo || null, uploadId);
  sqlite
    .prepare(`INSERT INTO checklist_reaberturas (periodo_id, item_chave, motivo, reaberto_por) VALUES (?, ?, ?, ?)`)
    .run(uploadRow.periodo_id, uploadRow.item_chave, motivo || null, user.id);
  res.json({ ok: true });
});

// Download (admin/colaborador com permissão) — cliente não tem endpoint de download por design (só o que ele mesmo já vê na tela)
app.get("/api/checklist/uploads/:uploadId/download", blockCliente, requirePermissao("solicitacoes", "visualizar"), (req, res) => {
  const uploadRow = sqlite.prepare(`SELECT * FROM checklist_uploads WHERE id = ?`).get(Number(req.params.uploadId)) as any;
  if (!uploadRow || !fs.existsSync(uploadRow.file_path)) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.download(uploadRow.file_path, uploadRow.file_name);
});

// ---------- Envio de Documentos (o escritório posta e o cliente recebe — sentido contrário de Solicitações) ----------
app.get("/api/envio/templates", blockCliente, requirePermissao("envio", "visualizar"), (_req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM envio_templates ORDER BY nome`).all() as any[];
  res.json({ items: rows.map((r) => ({ ...r, accept: JSON.parse(r.accept_json) })) });
});
app.post("/api/envio/templates", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const user = (req as any).user;
  const { nome, descricao, periodicidade, accept } = req.body || {};
  if (!nome) return res.status(400).json({ error: "Informe o nome (ex.: \"DARF PIS\")." });
  const acceptFinal = Array.isArray(accept) && accept.length ? accept : ["pdf"];
  const info = sqlite
    .prepare(`INSERT INTO envio_templates (nome, descricao, periodicidade, accept_json, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(nome, descricao || null, periodicidade || "mensal", JSON.stringify(acceptFinal), user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/envio/templates/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM envio_templates WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Modelo não encontrado." });
  const { nome, descricao, accept, ativo } = req.body || {};
  sqlite
    .prepare(`UPDATE envio_templates SET nome=?, descricao=?, accept_json=?, ativo=? WHERE id=?`)
    .run(
      nome ?? existing.nome,
      descricao !== undefined ? descricao : existing.descricao,
      Array.isArray(accept) && accept.length ? JSON.stringify(accept) : existing.accept_json,
      ativo === undefined ? existing.ativo : ativo ? 1 : 0,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/envio/templates/:id", requireAdmin, (req, res) => {
  sqlite.prepare(`DELETE FROM envio_templates WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

app.get("/api/envio/atribuicoes", blockCliente, requirePermissao("envio", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (empresaId && !podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  let sql = `SELECT a.*, t.nome as templateNome, t.periodicidade, t.accept_json as acceptJson, e.nome as empresaNome
             FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id`;
  const params: any[] = [];
  if (empresaId) {
    sql += ` WHERE a.empresa_id = ?`;
    params.push(empresaId);
  }
  sql += ` ORDER BY e.nome, t.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows.map((r) => ({ ...r, accept: JSON.parse(r.acceptJson), temDocumentos: envioAtribuicaoTemDocumentos(r.id) })) });
});
app.get("/api/envio/minhas-atribuicoes", (req, res) => {
  const user = (req as any).user;
  if (user.perfil !== "Cliente") return res.status(403).json({ error: "Rota exclusiva para clientes." });
  if (!user.empresaId) return res.json({ items: [] });
  const rows = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.descricao, e.nome as empresaNome
       FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id
       WHERE a.empresa_id = ? AND a.ativo = 1 ORDER BY t.nome`
    )
    .all(user.empresaId) as any[];
  res.json({ items: rows });
});
app.post("/api/envio/atribuicoes", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const user = (req as any).user;
  const { templateId, empresaId } = req.body || {};
  if (!templateId || !empresaId) return res.status(400).json({ error: "Selecione o modelo e a empresa." });
  if (!podeAcessarEmpresa(user, Number(empresaId))) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  try {
    const info = sqlite
      .prepare(`INSERT INTO envio_atribuicoes (template_id, empresa_id, created_by) VALUES (?, ?, ?)`)
      .run(Number(templateId), Number(empresaId), user.id);
    res.json({ id: Number(info.lastInsertRowid) });
  } catch (e: any) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "Este modelo já está atribuído a esta empresa." });
    res.status(500).json({ error: e.message });
  }
});
app.delete("/api/envio/atribuicoes/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const id = Number(req.params.id);
  if (envioAtribuicaoTemDocumentos(id)) {
    return res.status(409).json({ error: "Já existe documento enviado nesta atribuição — não é possível excluir." });
  }
  sqlite.prepare(`DELETE FROM envio_atribuicoes WHERE id = ?`).run(id);
  res.json({ ok: true });
});

app.post("/api/envio/periodos/gerar", blockCliente, requirePermissao("envio", "postar"), (req, res) => {
  const { atribuicaoId, ano, rotulo } = req.body || {};
  const atrib = sqlite
    .prepare(`SELECT a.*, t.periodicidade FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id WHERE a.id = ?`)
    .get(Number(atribuicaoId)) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  const insert = sqlite.prepare(`INSERT OR IGNORE INTO envio_periodos (atribuicao_id, ano, mes, rotulo) VALUES (?, ?, ?, ?)`);
  let criados = 0;
  if (atrib.periodicidade === "mensal") {
    for (let mes = 1; mes <= 12; mes++) {
      const info = insert.run(atrib.id, Number(ano), mes, null);
      if (info.changes) criados++;
    }
  } else if (atrib.periodicidade === "anual") {
    const info = insert.run(atrib.id, Number(ano), null, null);
    if (info.changes) criados++;
  } else {
    const info = insert.run(atrib.id, Number(ano) || new Date().getFullYear(), null, rotulo || `Envio avulso ${Date.now()}`);
    if (info.changes) criados++;
  }
  res.json({ ok: true, criados });
});

app.get("/api/envio/grade/:atribuicaoId", (req, res) => {
  const user = (req as any).user;
  const atribuicaoId = Number(req.params.atribuicaoId);
  const atrib = sqlite
    .prepare(
      `SELECT a.*, t.nome as templateNome, t.periodicidade, t.accept_json as acceptJson, e.nome as empresaNome
       FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id JOIN empresas e ON e.id = a.empresa_id WHERE a.id = ?`
    )
    .get(atribuicaoId) as any;
  if (!atrib) return res.status(404).json({ error: "Atribuição não encontrada." });
  if (user.perfil === "Cliente" && user.empresaId !== atrib.empresa_id) return res.status(403).json({ error: "Sem acesso." });
  if (user.perfil === "Colaborador" && !hasPermissao(user, "envio", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
  if (user.perfil !== "Cliente" && !podeAcessarEmpresa(user, atrib.empresa_id)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const periodos = sqlite.prepare(`SELECT * FROM envio_periodos WHERE atribuicao_id = ? ORDER BY ano DESC, mes ASC`).all(atribuicaoId) as any[];
  const periodoIds = periodos.map((p) => p.id);
  const docs = periodoIds.length
    ? (sqlite
        .prepare(`SELECT * FROM envio_documentos WHERE periodo_id IN (${periodoIds.map(() => "?").join(",")}) ORDER BY enviado_em ASC, id ASC`)
        .all(...periodoIds) as any[])
    : [];
  const docsPorPeriodo = new Map<number, any[]>();
  for (const d of docs) {
    if (!docsPorPeriodo.has(d.periodo_id)) docsPorPeriodo.set(d.periodo_id, []);
    docsPorPeriodo.get(d.periodo_id)!.push({
      id: d.id,
      fileName: d.file_name,
      sizeBytes: d.size_bytes,
      observacao: d.observacao,
      vencimento: d.vencimento,
      vencimentoOrigem: d.vencimento_origem,
      enviadoEm: d.enviado_em,
      emailEnviado: !!d.email_enviado,
      emailErro: d.email_erro,
    });
  }

  const grade = periodos.map((p) => ({
    periodoId: p.id,
    ano: p.ano,
    mes: p.mes,
    rotulo: p.rotulo,
    documentos: docsPorPeriodo.get(p.id) || [],
  }));

  res.json({
    atribuicao: {
      id: atrib.id,
      templateNome: atrib.templateNome,
      periodicidade: atrib.periodicidade,
      empresaNome: atrib.empresaNome,
      empresaId: atrib.empresa_id,
      accept: JSON.parse(atrib.acceptJson),
    },
    grade,
  });
});

app.post("/api/envio/periodos/:periodoId/enviar", blockCliente, requirePermissao("envio", "postar"), upload.single("arquivo"), async (req, res) => {
  const user = (req as any).user;
  const periodoId = Number(req.params.periodoId);
  if (!req.file) return res.status(400).json({ error: "Selecione o arquivo." });

  const periodo = sqlite
    .prepare(
      `SELECT p.*, a.empresa_id as empresaId, t.accept_json as acceptJson, t.nome as templateNome
       FROM envio_periodos p JOIN envio_atribuicoes a ON a.id = p.atribuicao_id JOIN envio_templates t ON t.id = a.template_id WHERE p.id = ?`
    )
    .get(periodoId) as any;
  if (!periodo) return res.status(404).json({ error: "Período não encontrado." });
  if (!podeAcessarEmpresa(user, periodo.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });

  const accept = JSON.parse(periodo.acceptJson);
  if (!extensaoPermitida(accept, req.file.originalname)) {
    return res.status(400).json({ error: `Tipo de arquivo não permitido. Aceito: ${accept.join(", ")}.` });
  }

  const dir = path.join(UPLOADS_DIR, "envio", String(periodo.empresaId), String(periodoId));
  fs.mkdirSync(dir, { recursive: true });
  const nomeSeguro = `doc_${Date.now()}${path.extname(req.file.originalname)}`;
  const destino = path.join(dir, nomeSeguro);
  fs.writeFileSync(destino, req.file.buffer);

  let vencimento: string | null = req.body?.vencimento ? String(req.body.vencimento) : null;
  let vencimentoOrigem: string | null = vencimento ? "manual" : null;
  if (!vencimento) {
    try {
      const texto = await extrairTextoArquivo(req.file);
      const detectado = extrairVencimento(texto);
      if (detectado) {
        vencimento = detectado;
        vencimentoOrigem = "automatico";
      }
    } catch {
      // não é crítico — a data pode ser preenchida/corrigida manualmente depois
    }
  }

  // Não substitui documentos já enviados nesse período — soma (ex.: guia recalculada porque o
  // cliente não pagou no prazo). O histórico das guias anteriores fica visível na grade.
  const observacao = req.body?.observacao ? String(req.body.observacao).trim() : null;
  const info = sqlite
    .prepare(
      `INSERT INTO envio_documentos (periodo_id, file_name, file_path, mime, size_bytes, observacao, vencimento, vencimento_origem, enviado_por)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(periodoId, req.file.originalname, destino, req.file.mimetype, req.file.size, observacao, vencimento, vencimentoOrigem, user.id);
  const docId = Number(info.lastInsertRowid);

  const rotulo = periodo.mes ? `${periodo.mes}/${periodo.ano}` : periodo.rotulo || String(periodo.ano);
  const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(periodo.empresaId) as any[];
  let emailEnviado = false;
  let emailErro: string | null = null;
  if (!contatos.length) {
    emailErro = "Empresa sem contatos de e-mail cadastrados.";
  } else {
    const assunto = `${periodo.templateNome} — ${rotulo}`;
    const corpo = `Segue em anexo: ${periodo.templateNome} (${rotulo}).${vencimento ? `\n\nVencimento: ${vencimento.split("-").reverse().join("/")}` : ""}`;
    try {
      await enviarEmail({ to: contatos.map((c) => c.email), subject: assunto, text: corpo, attachments: [{ filename: req.file.originalname, content: req.file.buffer }] });
      emailEnviado = true;
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
        .run(periodo.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, JSON.stringify([req.file.originalname]), user.id);
    } catch (e: any) {
      emailErro = e.message;
      sqlite
        .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, enviado_por, status, erro) VALUES (?, ?, ?, ?, ?, 'erro', ?)`)
        .run(periodo.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, user.id, e.message);
    }
  }
  sqlite.prepare(`UPDATE envio_documentos SET email_enviado = ?, email_erro = ? WHERE id = ?`).run(emailEnviado ? 1 : 0, emailErro, docId);

  res.json({ id: docId, vencimento, vencimentoOrigem, emailEnviado, emailErro });
});

app.put("/api/envio/documentos/:id/vencimento", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const { vencimento } = req.body || {};
  if (!vencimento) return res.status(400).json({ error: "Informe a data de vencimento." });
  const info = sqlite.prepare(`UPDATE envio_documentos SET vencimento = ?, vencimento_origem = 'manual' WHERE id = ?`).run(vencimento, Number(req.params.id));
  if (!info.changes) return res.status(404).json({ error: "Documento não encontrado." });
  res.json({ ok: true });
});
app.delete("/api/envio/documentos/:id", blockCliente, requirePermissao("envio", "editar"), (req, res) => {
  const doc = sqlite.prepare(`SELECT * FROM envio_documentos WHERE id = ?`).get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  try {
    fs.unlinkSync(doc.file_path);
  } catch {}
  sqlite.prepare(`DELETE FROM envio_documentos WHERE id = ?`).run(doc.id);
  res.json({ ok: true });
});
app.post("/api/envio/documentos/:id/reenviar-email", blockCliente, requirePermissao("envio", "postar"), async (req, res) => {
  const user = (req as any).user;
  const doc = sqlite
    .prepare(
      `SELECT d.*, p.atribuicao_id as atribuicaoId, p.ano, p.mes, p.rotulo FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id WHERE d.id = ?`
    )
    .get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const atrib = sqlite
    .prepare(`SELECT a.empresa_id as empresaId, t.nome as templateNome FROM envio_atribuicoes a JOIN envio_templates t ON t.id = a.template_id WHERE a.id = ?`)
    .get(doc.atribuicaoId) as any;
  const contatos = sqlite.prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`).all(atrib.empresaId) as any[];
  if (!contatos.length) return res.status(400).json({ error: "Esta empresa não tem contatos de e-mail cadastrados." });
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: "Arquivo não encontrado no servidor." });
  const rotulo = doc.mes ? `${doc.mes}/${doc.ano}` : doc.rotulo || String(doc.ano);
  const assunto = `${atrib.templateNome} — ${rotulo}`;
  const corpo = `Segue em anexo: ${atrib.templateNome} (${rotulo}).${doc.vencimento ? `\n\nVencimento: ${String(doc.vencimento).split("-").reverse().join("/")}` : ""}`;
  try {
    await enviarEmail({ to: contatos.map((c) => c.email), subject: assunto, text: corpo, attachments: [{ filename: doc.file_name, content: fs.readFileSync(doc.file_path) }] });
    sqlite.prepare(`UPDATE envio_documentos SET email_enviado = 1, email_erro = NULL WHERE id = ?`).run(doc.id);
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
      .run(atrib.empresaId, contatos.map((c) => c.email).join(", "), assunto, corpo, JSON.stringify([doc.file_name]), user.id);
    res.json({ ok: true });
  } catch (e: any) {
    sqlite.prepare(`UPDATE envio_documentos SET email_erro = ? WHERE id = ?`).run(e.message, doc.id);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/envio/documentos/:id/download", (req, res) => {
  const user = (req as any).user;
  const doc = sqlite
    .prepare(`SELECT d.*, p.atribuicao_id as atribuicaoId FROM envio_documentos d JOIN envio_periodos p ON p.id = d.periodo_id WHERE d.id = ?`)
    .get(Number(req.params.id)) as any;
  if (!doc) return res.status(404).json({ error: "Documento não encontrado." });
  const atrib = sqlite.prepare(`SELECT empresa_id as empresaId FROM envio_atribuicoes WHERE id = ?`).get(doc.atribuicaoId) as any;
  if (user.perfil === "Cliente") {
    if (user.empresaId !== atrib.empresaId) return res.status(403).json({ error: "Sem acesso." });
  } else {
    if (!hasPermissao(user, "envio", "visualizar")) return res.status(403).json({ error: "Sem permissão." });
    if (!podeAcessarEmpresa(user, atrib.empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  }
  if (!fs.existsSync(doc.file_path)) return res.status(404).json({ error: "Arquivo não encontrado." });
  res.download(doc.file_path, doc.file_name);
});

// ---------- Financeiro (honorários) ----------
app.get("/api/financeiro/honorarios", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const user = (req as any).user;
  let rows = sqlite
    .prepare(`SELECT h.*, e.nome as empresaNome FROM honorarios h JOIN empresas e ON e.id = h.empresa_id ORDER BY e.nome`)
    .all() as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows });
});
app.put("/api/financeiro/honorarios/:empresaId", blockCliente, requirePermissao("financeiro", "editar"), (req, res) => {
  const empresaId = Number(req.params.empresaId);
  const { valor, diaVencimento, ativo, observacao } = req.body || {};
  sqlite
    .prepare(
      `INSERT INTO honorarios (empresa_id, valor, dia_vencimento, ativo, observacao, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(empresa_id) DO UPDATE SET valor=excluded.valor, dia_vencimento=excluded.dia_vencimento, ativo=excluded.ativo, observacao=excluded.observacao, updated_at=datetime('now')`
    )
    .run(empresaId, Number(valor) || 0, Number(diaVencimento) || 10, ativo === false ? 0 : 1, observacao || null);
  res.json({ ok: true });
});

app.get("/api/financeiro/lancamentos", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const user = (req as any).user;
  const competencia = req.query.competencia ? String(req.query.competencia) : null;
  let sql = `SELECT l.*, e.nome as empresaNome FROM honorarios_lancamentos l JOIN empresas e ON e.id = l.empresa_id`;
  const params: any[] = [];
  if (competencia) {
    sql += ` WHERE l.competencia = ?`;
    params.push(competencia);
  }
  sql += ` ORDER BY e.nome`;
  let rows = sqlite.prepare(sql).all(...params) as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.empresa_id));
  res.json({ items: rows });
});
// Gera os lançamentos do mês a partir dos honorários ativos (não duplica: UNIQUE empresa+competência)
app.post("/api/financeiro/lancamentos/gerar", blockCliente, requirePermissao("financeiro", "postar"), (req, res) => {
  const { competencia } = req.body || {}; // 'YYYY-MM'
  if (!/^\d{4}-\d{2}$/.test(competencia || "")) return res.status(400).json({ error: "Informe a competência no formato AAAA-MM." });
  const honorariosAtivos = sqlite.prepare(`SELECT * FROM honorarios WHERE ativo = 1`).all() as any[];
  const insert = sqlite.prepare(
    `INSERT OR IGNORE INTO honorarios_lancamentos (empresa_id, competencia, valor, vencimento, status) VALUES (?, ?, ?, ?, 'pendente')`
  );
  let criados = 0;
  const [ano, mes] = competencia.split("-").map(Number);
  for (const h of honorariosAtivos) {
    const ultimoDia = new Date(ano, mes, 0).getDate();
    const dia = Math.min(h.dia_vencimento, ultimoDia);
    const vencimento = `${competencia}-${String(dia).padStart(2, "0")}`;
    const info = insert.run(h.empresa_id, competencia, h.valor, vencimento);
    if (info.changes) criados++;
  }
  res.json({ ok: true, criados });
});
app.put("/api/financeiro/lancamentos/:id", blockCliente, requirePermissao("financeiro", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const { status, dataPagamento, formaPagamento, observacao, valor } = req.body || {};
  const existing = sqlite.prepare(`SELECT * FROM honorarios_lancamentos WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Lançamento não encontrado." });
  sqlite
    .prepare(`UPDATE honorarios_lancamentos SET status=?, data_pagamento=?, forma_pagamento=?, observacao=?, valor=? WHERE id=?`)
    .run(
      status ?? existing.status,
      dataPagamento !== undefined ? dataPagamento : existing.data_pagamento,
      formaPagamento !== undefined ? formaPagamento : existing.forma_pagamento,
      observacao !== undefined ? observacao : existing.observacao,
      valor !== undefined ? Number(valor) : existing.valor,
      id
    );
  res.json({ ok: true });
});
app.get("/api/financeiro/resumo", blockCliente, requirePermissao("financeiro", "visualizar"), (req, res) => {
  const competencia = req.query.competencia ? String(req.query.competencia) : new Date().toISOString().slice(0, 7);
  const rows = sqlite.prepare(`SELECT status, SUM(valor) as total, COUNT(*) as qtd FROM honorarios_lancamentos WHERE competencia = ? GROUP BY status`).all(competencia) as any[];
  const resumo: Record<string, { total: number; qtd: number }> = { pendente: { total: 0, qtd: 0 }, pago: { total: 0, qtd: 0 }, atrasado: { total: 0, qtd: 0 }, cancelado: { total: 0, qtd: 0 } };
  for (const r of rows) resumo[r.status] = { total: r.total || 0, qtd: r.qtd };
  res.json({ competencia, resumo });
});

// ---------- Painel (cards de indicadores) ----------
app.get("/api/dashboard/cards", requirePermissao("dashboard", "visualizar"), (_req, res) => {
  const rows = sqlite.prepare(`SELECT * FROM dashboard_cards ORDER BY ordem, id`).all();
  res.json({ items: rows });
});
app.post("/api/dashboard/cards", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  const user = (req as any).user;
  const { titulo, valor, subtitulo, cor, ordem } = req.body || {};
  if (!titulo || valor === undefined) return res.status(400).json({ error: "Informe título e valor do card." });
  const info = sqlite
    .prepare(`INSERT INTO dashboard_cards (titulo, valor, subtitulo, cor, ordem, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(titulo, String(valor), subtitulo || null, cor || "brass", Number(ordem) || 0, user.id);
  res.json({ id: Number(info.lastInsertRowid) });
});
app.put("/api/dashboard/cards/:id", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  const id = Number(req.params.id);
  const existing = sqlite.prepare(`SELECT * FROM dashboard_cards WHERE id = ?`).get(id) as any;
  if (!existing) return res.status(404).json({ error: "Card não encontrado." });
  const { titulo, valor, subtitulo, cor, ordem } = req.body || {};
  sqlite
    .prepare(`UPDATE dashboard_cards SET titulo=?, valor=?, subtitulo=?, cor=?, ordem=?, updated_at=datetime('now') WHERE id=?`)
    .run(
      titulo ?? existing.titulo,
      valor !== undefined ? String(valor) : existing.valor,
      subtitulo !== undefined ? subtitulo : existing.subtitulo,
      cor ?? existing.cor,
      ordem !== undefined ? Number(ordem) : existing.ordem,
      id
    );
  res.json({ ok: true });
});
app.delete("/api/dashboard/cards/:id", blockCliente, requirePermissao("dashboard", "editar"), (req, res) => {
  sqlite.prepare(`DELETE FROM dashboard_cards WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------- Relatórios ----------
// Lista de empresas para o filtro de cliente nos relatórios (só as marcadas como visíveis em relatórios)
app.get("/api/relatorios/empresas", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const user = (req as any).user;
  let rows = sqlite.prepare(`SELECT id, nome FROM empresas WHERE ativo = 1 AND visivel_relatorios = 1 ORDER BY nome`).all() as any[];
  const visiveis = empresasVisiveis(user);
  if (visiveis !== null) rows = rows.filter((r) => visiveis.includes(r.id));
  res.json({ items: rows });
});
const TIPOS_RELATORIO = ["balanco", "balancete", "dre", "faturamento", "folha"];
app.get("/api/relatorios/:tipo", blockCliente, requirePermissao("relatorios", "visualizar"), (req, res) => {
  const tipo = String(req.params.tipo);
  if (!TIPOS_RELATORIO.includes(tipo)) return res.status(400).json({ error: "Relatório inválido." });
  const empresaId = req.query.empresaId ? Number(req.query.empresaId) : null;
  if (!empresaId) return res.json({ conectado: false, items: [] });
  const user = (req as any).user;
  if (!podeAcessarEmpresa(user, empresaId)) return res.status(403).json({ error: "Sem acesso a esta empresa." });
  const rows = sqlite
    .prepare(`SELECT competencia, dados_json as dadosJson, sincronizado_em as sincronizadoEm FROM dominio_dados WHERE empresa_id = ? AND tipo = ? ORDER BY competencia DESC`)
    .all(empresaId, tipo) as any[];
  res.json({
    conectado: rows.length > 0,
    items: rows.map((r) => ({ competencia: r.competencia, dados: JSON.parse(r.dadosJson), sincronizadoEm: r.sincronizadoEm })),
  });
});

// ---------- E-mail corporativo ----------
app.get("/api/email/status", blockCliente, (req, res) => {
  res.json({ configurado: emailConfigurado(), from: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || null });
});
app.post("/api/email/enviar", blockCliente, requirePermissao("configuracoes", "postar"), upload.array("anexos", 5), async (req, res) => {
  const user = (req as any).user;
  const { empresaId, assunto, corpo } = req.body || {};
  if (!empresaId || !assunto) return res.status(400).json({ error: "Selecione a empresa e informe o assunto." });
  const contatos = sqlite
    .prepare(`SELECT email FROM empresa_contatos WHERE empresa_id = ? AND receber_emails = 1`)
    .all(Number(empresaId)) as any[];
  if (!contatos.length) return res.status(400).json({ error: "Esta empresa não tem contatos de e-mail cadastrados." });
  const anexos = ((req.files as Express.Multer.File[]) || []).map((f) => ({ filename: f.originalname, content: f.buffer }));
  try {
    await enviarEmail({ to: contatos.map((c) => c.email), subject: assunto, text: corpo || "", attachments: anexos });
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, anexos_json, enviado_por, status) VALUES (?, ?, ?, ?, ?, ?, 'ok')`)
      .run(Number(empresaId), contatos.map((c) => c.email).join(", "), assunto, corpo || "", JSON.stringify(anexos.map((a) => a.filename)), user.id);
    res.json({ ok: true, enviadoPara: contatos.map((c) => c.email) });
  } catch (e: any) {
    sqlite
      .prepare(`INSERT INTO emails_enviados (empresa_id, destinatarios, assunto, corpo, enviado_por, status, erro) VALUES (?, ?, ?, ?, ?, 'erro', ?)`)
      .run(Number(empresaId), contatos.map((c) => c.email).join(", "), assunto, corpo || "", user.id, e.message);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/email/log", blockCliente, requirePermissao("configuracoes", "visualizar"), (_req, res) => {
  const rows = sqlite
    .prepare(`SELECT e.*, emp.nome as empresaNome FROM emails_enviados e LEFT JOIN empresas emp ON emp.id = e.empresa_id ORDER BY e.id DESC LIMIT 100`)
    .all();
  res.json({ items: rows });
});

// Identificação automática do cliente a partir de um arquivo (PDF, OFX ou XML): extrai texto,
// procura CNPJ/CPF e confere com o que está cadastrado em cada empresa. É só uma sugestão — quem
// confirma e manda o e-mail continua sendo o administrador, na tela.
async function extrairTextoArquivo(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".pdf" || file.mimetype === "application/pdf") {
    const pdfParse = require("pdf-parse");
    // pdf-parse trata "instanceof Buffer" como um caso especial e acaba lendo o ArrayBuffer
    // inteiro por baixo (ignorando byteOffset/length) — como o buffer do multer normalmente é uma
    // "view" dentro do pool interno de Buffers do Node, isso lê lixo do pool e quebra a leitura
    // do xref. Um Uint8Array "puro" (não Buffer) evita esse caminho com bug.
    const data = await pdfParse(new Uint8Array(file.buffer));
    return data.text || "";
  }
  // OFX, XML, TXT e a maioria dos extratos exportados são texto puro — dá pra ler direto.
  return file.buffer.toString("utf8");
}
function extrairDocumentos(texto: string): { documento: string; tipo: "cnpj" | "cpf" }[] {
  const encontrados: { documento: string; tipo: "cnpj" | "cpf" }[] = [];
  const vistos = new Set<string>();
  const reCnpj = /\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/g;
  let sobra = texto;
  for (const m of texto.matchAll(reCnpj)) {
    const digitos = m[0].replace(/\D/g, "");
    if (digitos.length === 14 && !vistos.has(digitos)) {
      vistos.add(digitos);
      encontrados.push({ documento: digitos, tipo: "cnpj" });
    }
    sobra = sobra.replace(m[0], " "); // remove pra não gerar falso-positivo de CPF dentro do CNPJ
  }
  const reCpf = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;
  for (const m of sobra.matchAll(reCpf)) {
    const digitos = m[0].replace(/\D/g, "");
    if (digitos.length === 11 && !vistos.has(digitos)) {
      vistos.add(digitos);
      encontrados.push({ documento: digitos, tipo: "cpf" });
    }
  }
  return encontrados;
}
// Procura a data de vencimento no texto de uma guia (DARF, FGTS etc.) — primeiro tenta perto da
// palavra "vencimento", senão cai pra primeira data no formato dd/mm/aaaa encontrada no documento.
function extrairVencimento(texto: string): string | null {
  const brParaIso = (d: string) => {
    const [dd, mm, yyyy] = d.split("/");
    return `${yyyy}-${mm}-${dd}`;
  };
  const pertoDaPalavra = texto.match(/venc[a-zçã.]*[^0-9]{0,25}(\d{2}\/\d{2}\/\d{4})/i);
  if (pertoDaPalavra) return brParaIso(pertoDaPalavra[1]);
  const qualquerData = texto.match(/\d{2}\/\d{2}\/\d{4}/);
  if (qualquerData) return brParaIso(qualquerData[0]);
  return null;
}
app.post("/api/email/identificar", blockCliente, requirePermissao("configuracoes", "visualizar"), upload.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Envie um arquivo." });
  let texto = "";
  try {
    texto = await extrairTextoArquivo(req.file);
  } catch (e: any) {
    return res.status(400).json({ error: "Não consegui ler o conteúdo do arquivo: " + e.message });
  }
  const documentos = extrairDocumentos(texto);
  if (!documentos.length) return res.json({ documentosEncontrados: [], matches: [] });
  const placeholders = documentos.map(() => "?").join(",");
  const matches = sqlite
    .prepare(
      `SELECT ed.documento, ed.tipo, e.id as empresaId, e.nome as empresaNome
       FROM empresa_documentos ed JOIN empresas e ON e.id = ed.empresa_id WHERE ed.documento IN (${placeholders})`
    )
    .all(...documentos.map((d) => d.documento));
  res.json({ documentosEncontrados: documentos, matches });
});

// ---------- API do agente do Domínio Web (autenticada por token — ver src/dominio-agent.ts) ----------
const DOMINIO_AGENT_TOKEN = process.env.DOMINIO_AGENT_TOKEN || "";
function requireDominioAgent(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.headers["x-agent-token"];
  if (!DOMINIO_AGENT_TOKEN || token !== DOMINIO_AGENT_TOKEN) return res.status(401).json({ error: "Token de agente inválido." });
  next();
}
app.post("/api/dominio-agent/heartbeat", requireDominioAgent, (req, res) => {
  const version = typeof req.body?.version === "string" ? req.body.version : null;
  sqlite
    .prepare(
      `INSERT INTO agent_heartbeat (id, last_seen_at, version) VALUES (1, datetime('now'), ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = datetime('now'), version = excluded.version`
    )
    .run(version);
  res.json({ ok: true });
});
app.post("/api/dominio-agent/empresas", requireDominioAgent, (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  let novas = 0, atualizadas = 0;
  const getByCodigo = sqlite.prepare(`SELECT id FROM empresas WHERE codigo_dominio = ?`);
  const insert = sqlite.prepare(`INSERT INTO empresas (nome, cnpj, codigo_dominio, ativo, origem) VALUES (?, ?, ?, ?, 'dominio')`);
  const update = sqlite.prepare(`UPDATE empresas SET nome=?, cnpj=COALESCE(?, cnpj), ativo=?, updated_at=datetime('now') WHERE id=?`);
  for (const it of items) {
    if (!it?.codigo || !it?.nome) continue;
    const existente = getByCodigo.get(String(it.codigo)) as any;
    if (existente) {
      update.run(it.nome, it.cnpj || null, it.ativo === false ? 0 : 1, existente.id);
      atualizadas++;
    } else {
      insert.run(it.nome, it.cnpj || null, String(it.codigo), it.ativo === false ? 0 : 1);
      novas++;
    }
  }
  sqlite.prepare(`INSERT INTO dominio_sync_log (origem, empresas_novas, empresas_atualizadas, status) VALUES ('agente', ?, ?, 'ok')`).run(novas, atualizadas);
  res.json({ ok: true, novas, atualizadas });
});
// Config completa (com senha/token em texto puro) — só o agente autenticado por token acessa isso.
app.get("/api/dominio-agent/config", requireDominioAgent, (_req, res) => {
  const c = getDominioConfig();
  res.json({
    source: c.source || "",
    dbDriver: c.db_driver || "",
    dbHost: c.db_host || "",
    dbPort: c.db_port || null,
    dbName: c.db_name || "",
    dbUser: c.db_user || "",
    dbPassword: c.db_password || "",
    dbConnectString: c.db_connect_string || "",
    queryClientes: c.query_clientes || "",
    colCodigo: c.col_codigo || "CODIGO",
    colNome: c.col_nome || "NOME",
    colCnpj: c.col_cnpj || "CNPJ",
    colStatus: c.col_status || "STATUS",
    apiUrl: c.api_url || "",
    apiToken: c.api_token || "",
  });
});
app.get("/api/dominio-agent/work", requireDominioAgent, (_req, res) => {
  const testJobs = sqlite.prepare(`SELECT id FROM dominio_test_jobs WHERE status = 'pending' ORDER BY id ASC LIMIT 5`).all();
  res.json({ testJobs });
});
app.post("/api/dominio-agent/teste-resultado", requireDominioAgent, (req, res) => {
  const { jobId, ok, resultado, erro } = req.body || {};
  const job = sqlite.prepare(`SELECT * FROM dominio_test_jobs WHERE id = ?`).get(Number(jobId)) as any;
  if (!job) return res.status(404).json({ error: "not found" });
  sqlite
    .prepare(`UPDATE dominio_test_jobs SET status=?, resultado_json=?, erro=?, resolvido_em=datetime('now') WHERE id=?`)
    .run(ok ? "ok" : "erro", resultado ? JSON.stringify(resultado) : null, erro || null, job.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Simples Contábeis no ar na porta ${PORT}`);
  console.log(`Banco do site: ${path.join(DATA_DIR, "simplescontabeis.db")}`);
  console.log(emailConfigurado() ? "E-mail corporativo configurado." : "AVISO: e-mail corporativo não configurado (defina SMTP_* no .env).");
  console.log(DOMINIO_AGENT_TOKEN ? "Token do agente do Domínio Web configurado." : "AVISO: DOMINIO_AGENT_TOKEN não definido — o agente do Domínio Web não vai conseguir se conectar.");
});
