// Módulo "Certificados": assinatura digital de PDF com UM certificado A1 do escritório, com uma
// "chave" de acesso por colaborador autorizado — pra rastrear quem disparou cada assinatura.
//
// Aviso importante (confirmado em pesquisa jurídica antes de construir isto): a "chave por
// colaborador" é controle de acesso e trilha de auditoria DO SISTEMA — não é uma segunda identidade
// perante a ICP-Brasil. O certificado tem um único titular legal (quem está no campo "titular" aqui),
// e a assinatura digital em si é sempre presumida como sendo dele. A chave serve pra o escritório
// provar, se precisar, QUEM no sistema pediu aquela assinatura — não muda a responsabilidade legal do
// certificado. Ver aba "Configuração" no front, que mostra esse aviso pro usuário.
//
// Desenho priorizando "não pode falhar/travar" (pedido explícito): certificado A1 roda 100% no
// servidor (sem extensão de navegador, sem token/smartcard — elimina essa classe inteira de falha);
// confirmação da própria senha de login antes de assinar (reaproveita o login, não inventa segundo
// mecanismo); falha visível com mensagem clara, nunca retry automático; checagem de revogação (OCSP)
// com timeout curto e FAIL-OPEN — se o respondedor estiver fora do ar, assina mesmo assim e só registra
// no log, em vez de travar a operação (mesmo padrão documentado em plataformas de assinatura).
import type express from "express";
import multer from "multer";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";
import signpdf from "@signpdf/signpdf";
import { P12Signer } from "@signpdf/signer-p12";
import { pdflibAddPlaceholder } from "@signpdf/placeholder-pdf-lib";
import { SUBFILTER_ETSI_CADES_DETACHED } from "@signpdf/utils";
import { getCertStatus } from "easy-ocsp";

type CertificadoInfo = { privateKeyPem: string; certPem: string; titular: string | null; cnpjCertificado: string | null; validadeAte: Date | null };

type Deps = {
  sqlite: any;
  blockCliente: express.RequestHandler;
  requireAdmin: express.RequestHandler;
  requirePermissao: (modulo: "certificados", acao: "visualizar" | "postar" | "editar") => express.RequestHandler;
  verifyPassword: (password: string, stored: string) => boolean;
  cifrarTexto: (s: string) => string;
  decifrarTexto: (hex: string) => string;
  lerCertificadoPfx: (buf: Buffer, senha: string) => CertificadoInfo;
  salvarCertificadoCifrado: (buf: Buffer, nome: string) => string;
  lerCertificadoCifradoDoDisco: (p: string) => Buffer;
  excluirCertificadoDoDisco: (p: string) => void;
  uploadsDir: string;
};

// Checagem de revogação (OCSP) com timeout curto, nunca lança — qualquer problema (timeout, CA fora do
// padrão, sem suporte a OCSP no certificado) vira "indisponivel" e a assinatura segue normalmente.
async function ocspChecarComTimeout(certPem: string, timeoutMs = 5000): Promise<"ok" | "revogado" | "indisponivel"> {
  try {
    const resultado = await Promise.race([
      getCertStatus(certPem),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    if (!resultado) return "indisponivel";
    if (resultado.status === "revoked") return "revogado";
    if (resultado.status === "good") return "ok";
    return "indisponivel";
  } catch {
    return "indisponivel";
  }
}

export function registerCertificados(app: express.Express, d: Deps) {
  const { sqlite } = d;
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS certificados_config (
      escritorio_id INTEGER PRIMARY KEY,
      arquivo_path TEXT,
      senha_cifrada TEXT,
      titular TEXT,
      cnpj_certificado TEXT,
      validade_ate TEXT,
      ativo INTEGER NOT NULL DEFAULT 0,
      atualizado_em TEXT,
      atualizado_por INTEGER
    );
    CREATE TABLE IF NOT EXISTS certificados_colaboradores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      chave TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      concedido_por INTEGER,
      concedido_em TEXT DEFAULT (datetime('now')),
      revogado_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_certificados_colab_user ON certificados_colaboradores(user_id, ativo);
    -- Log append-only: nenhuma rota de UPDATE/DELETE é exposta pra esta tabela, de propósito.
    CREATE TABLE IF NOT EXISTS certificados_documentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      escritorio_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL REFERENCES app_users(id),
      nome_arquivo TEXT NOT NULL,
      arquivo_path TEXT,
      hash_antes TEXT,
      hash_depois TEXT,
      titular TEXT,
      numero_serie TEXT,
      status TEXT NOT NULL, -- 'assinado' | 'falha'
      erro TEXT,
      ocsp_status TEXT, -- 'ok' | 'revogado' | 'indisponivel'
      criado_em TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_certificados_docs_esc ON certificados_documentos(escritorio_id, criado_em);
    CREATE INDEX IF NOT EXISTS idx_certificados_docs_user ON certificados_documentos(user_id, criado_em);
  `);

  const DIR = path.join(d.uploadsDir, "certificados-assinados");
  fs.mkdirSync(DIR, { recursive: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

  const configDe = (escritorioId: number): any => sqlite.prepare(`SELECT * FROM certificados_config WHERE escritorio_id = ?`).get(escritorioId);
  const chaveAtivaDoUsuario = (userId: number): any => sqlite.prepare(`SELECT * FROM certificados_colaboradores WHERE user_id = ? AND ativo = 1`).get(userId);
  const gerarChave = (): string => "COL-" + crypto.randomBytes(4).toString("hex").toUpperCase();
  const numeroSerieDoCertPem = (certPem: string): string | null => {
    try {
      const forge = require("node-forge");
      const cert = forge.pki.certificateFromPem(certPem);
      return cert.serialNumber || null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------- configuração do certificado
  app.get("/api/certificados/config", d.blockCliente, d.requirePermissao("certificados", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const cfg = configDe(user.escritorioId);
    if (!cfg || !cfg.arquivo_path) return res.json({ configurado: false });
    const validade = cfg.validade_ate ? new Date(cfg.validade_ate) : null;
    const diasRestantes = validade ? Math.ceil((validade.getTime() - Date.now()) / 86400000) : null;
    res.json({
      configurado: true, ativo: !!cfg.ativo, titular: cfg.titular, cnpj: cfg.cnpj_certificado,
      validadeAte: cfg.validade_ate, diasRestantes, vencido: diasRestantes !== null && diasRestantes < 0,
    });
  });
  app.put("/api/certificados/config", d.blockCliente, d.requireAdmin, upload.single("certificado"), (req, res) => {
    const user = (req as any).user;
    const senha = String(req.body?.senha || "");
    if (!req.file) return res.status(400).json({ error: "Envie o arquivo do certificado (.pfx)." });
    if (!senha) return res.status(400).json({ error: "Informe a senha do certificado." });
    let info: CertificadoInfo;
    try {
      info = d.lerCertificadoPfx(req.file.buffer, senha);
    } catch (e: any) {
      return res.status(400).json({ error: e.message });
    }
    const atual = configDe(user.escritorioId);
    if (atual?.arquivo_path) d.excluirCertificadoDoDisco(atual.arquivo_path);
    const arquivoPath = d.salvarCertificadoCifrado(req.file.buffer, req.file.originalname);
    sqlite
      .prepare(
        `INSERT INTO certificados_config (escritorio_id, arquivo_path, senha_cifrada, titular, cnpj_certificado, validade_ate, ativo, atualizado_em, atualizado_por)
         VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), ?)
         ON CONFLICT(escritorio_id) DO UPDATE SET arquivo_path=excluded.arquivo_path, senha_cifrada=excluded.senha_cifrada,
           titular=excluded.titular, cnpj_certificado=excluded.cnpj_certificado, validade_ate=excluded.validade_ate,
           ativo=1, atualizado_em=datetime('now'), atualizado_por=excluded.atualizado_por`
      )
      .run(user.escritorioId, arquivoPath, d.cifrarTexto(senha), info.titular, info.cnpjCertificado, info.validadeAte ? info.validadeAte.toISOString() : null, user.id);
    res.json({ ok: true, titular: info.titular, validadeAte: info.validadeAte });
  });
  app.delete("/api/certificados/config", d.blockCliente, d.requireAdmin, (req, res) => {
    const user = (req as any).user;
    const atual = configDe(user.escritorioId);
    if (atual?.arquivo_path) d.excluirCertificadoDoDisco(atual.arquivo_path);
    sqlite.prepare(`UPDATE certificados_config SET ativo = 0, arquivo_path = NULL, senha_cifrada = NULL WHERE escritorio_id = ?`).run(user.escritorioId);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- chaves por colaborador
  app.get("/api/certificados/colaboradores", d.blockCliente, d.requireAdmin, (req, res) => {
    const user = (req as any).user;
    const rows = sqlite
      .prepare(
        `SELECT u.id as userId, u.nome, u.email,
                c.id as chaveId, c.chave, c.ativo as chaveAtiva, c.concedido_em as concedidoEm
         FROM app_users u
         LEFT JOIN certificados_colaboradores c ON c.user_id = u.id AND c.ativo = 1
         WHERE u.escritorio_id = ? AND u.perfil IN ('Administrador','Colaborador') AND u.ativo = 1
         ORDER BY u.nome`
      )
      .all(user.escritorioId) as any[];
    res.json({ items: rows.map((r) => ({ userId: r.userId, nome: r.nome, email: r.email, chave: r.chave || null, temChaveAtiva: !!r.chaveAtiva, concedidoEm: r.concedidoEm || null })) });
  });
  app.post("/api/certificados/colaboradores/:userId", d.blockCliente, d.requireAdmin, (req, res) => {
    const user = (req as any).user;
    const colaboradorId = Number(req.params.userId);
    const alvo = sqlite.prepare(`SELECT id FROM app_users WHERE id = ? AND escritorio_id = ?`).get(colaboradorId, user.escritorioId) as any;
    if (!alvo) return res.status(404).json({ error: "Colaborador não encontrado." });
    if (chaveAtivaDoUsuario(colaboradorId)) return res.status(409).json({ error: "Este colaborador já tem uma chave ativa." });
    sqlite
      .prepare(`INSERT INTO certificados_colaboradores (escritorio_id, user_id, chave, ativo, concedido_por) VALUES (?, ?, ?, 1, ?)`)
      .run(user.escritorioId, colaboradorId, gerarChave(), user.id);
    res.json({ ok: true });
  });
  app.delete("/api/certificados/colaboradores/:userId", d.blockCliente, d.requireAdmin, (req, res) => {
    const user = (req as any).user;
    const colaboradorId = Number(req.params.userId);
    sqlite
      .prepare(`UPDATE certificados_colaboradores SET ativo = 0, revogado_em = datetime('now') WHERE user_id = ? AND escritorio_id = ? AND ativo = 1`)
      .run(colaboradorId, user.escritorioId);
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- assinatura
  app.post("/api/certificados/assinar", d.blockCliente, d.requirePermissao("certificados", "postar"), upload.single("documento"), async (req, res) => {
    const user = (req as any).user;
    const senha = String(req.body?.senha || "");
    if (!req.file) return res.status(400).json({ error: "Envie o PDF a ser assinado." });
    if (req.file.mimetype !== "application/pdf" && !/\.pdf$/i.test(req.file.originalname || "")) {
      return res.status(400).json({ error: "Só é possível assinar arquivos PDF." });
    }
    if (!senha) return res.status(400).json({ error: "Confirme sua senha de login pra assinar." });
    const linhaUser = sqlite.prepare(`SELECT password_hash FROM app_users WHERE id = ?`).get(user.id) as any;
    if (!linhaUser || !d.verifyPassword(senha, linhaUser.password_hash)) return res.status(401).json({ error: "Senha incorreta." });
    const chave = chaveAtivaDoUsuario(user.id);
    if (!chave) return res.status(403).json({ error: "Você não tem uma chave ativa pra assinar documentos — peça ao administrador em Certificados › Colaboradores." });
    const cfg = configDe(user.escritorioId);
    if (!cfg || !cfg.arquivo_path || !cfg.ativo) return res.status(400).json({ error: "Nenhum certificado configurado. Configure em Certificados › Configuração." });
    const validade = cfg.validade_ate ? new Date(cfg.validade_ate) : null;
    if (!validade || validade.getTime() < Date.now()) return res.status(400).json({ error: "O certificado do escritório está vencido — atualize em Certificados › Configuração antes de assinar." });

    const hashAntes = crypto.createHash("sha256").update(req.file.buffer).digest("hex");
    try {
      const senhaCert = d.decifrarTexto(cfg.senha_cifrada);
      const pfxBuf = d.lerCertificadoCifradoDoDisco(cfg.arquivo_path);
      const info = d.lerCertificadoPfx(pfxBuf, senhaCert); // já validado na config, mas confere de novo (ex.: pfx trocado em disco)

      const pdfDoc = await PDFDocument.load(req.file.buffer);
      pdflibAddPlaceholder({
        pdfDoc,
        reason: "Assinatura digital",
        contactInfo: "",
        name: cfg.titular || "",
        location: "",
        subFilter: SUBFILTER_ETSI_CADES_DETACHED,
      });
      const pdfComPlaceholder = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
      const signer = new P12Signer(pfxBuf, { passphrase: senhaCert });
      const pdfAssinado = await signpdf.sign(pdfComPlaceholder, signer);
      const hashDepois = crypto.createHash("sha256").update(pdfAssinado).digest("hex");

      // Checagem de revogação best-effort — nunca bloqueia (ver ocspChecarComTimeout).
      const ocspStatus = await ocspChecarComTimeout(info.certPem);

      const nomeBase = (req.file.originalname || "documento.pdf").replace(/\.pdf$/i, "");
      const nomeArquivo = `${nomeBase} (assinado).pdf`;
      const destino = path.join(DIR, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.pdf`);
      fs.writeFileSync(destino, pdfAssinado);

      const result = sqlite
        .prepare(
          `INSERT INTO certificados_documentos (escritorio_id, user_id, nome_arquivo, arquivo_path, hash_antes, hash_depois, titular, numero_serie, status, ocsp_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assinado', ?)`
        )
        .run(user.escritorioId, user.id, nomeArquivo, destino, hashAntes, hashDepois, cfg.titular, numeroSerieDoCertPem(info.certPem), ocspStatus);
      res.json({ ok: true, id: Number(result.lastInsertRowid), nomeArquivo, ocspStatus });
    } catch (e: any) {
      sqlite
        .prepare(`INSERT INTO certificados_documentos (escritorio_id, user_id, nome_arquivo, hash_antes, status, erro) VALUES (?, ?, ?, ?, 'falha', ?)`)
        .run(user.escritorioId, user.id, req.file.originalname || "documento.pdf", hashAntes, e.message || String(e));
      res.status(400).json({ error: `Não consegui assinar o documento: ${e.message || e}. Nada foi salvo — tente de novo.` });
    }
  });

  // ---------------------------------------------------------------- histórico / download
  app.get("/api/certificados/documentos", d.blockCliente, d.requirePermissao("certificados", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const { userId, de, ate } = req.query as any;
    let sql = `SELECT cd.*, u.nome as userNome FROM certificados_documentos cd JOIN app_users u ON u.id = cd.user_id WHERE cd.escritorio_id = ?`;
    const params: any[] = [user.escritorioId];
    if (userId) { sql += ` AND cd.user_id = ?`; params.push(Number(userId)); }
    if (de) { sql += ` AND date(cd.criado_em) >= date(?)`; params.push(String(de)); }
    if (ate) { sql += ` AND date(cd.criado_em) <= date(?)`; params.push(String(ate)); }
    sql += ` ORDER BY cd.id DESC LIMIT 500`;
    const rows = sqlite.prepare(sql).all(...params) as any[];
    res.json({
      items: rows.map((r) => ({
        id: r.id, userNome: r.userNome, nomeArquivo: r.nome_arquivo, status: r.status, erro: r.erro,
        ocspStatus: r.ocsp_status, criadoEm: r.criado_em, temArquivo: !!r.arquivo_path,
      })),
    });
  });
  app.get("/api/certificados/documentos/:id/pdf", d.blockCliente, d.requirePermissao("certificados", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const doc = sqlite.prepare(`SELECT * FROM certificados_documentos WHERE id = ? AND escritorio_id = ?`).get(Number(req.params.id), user.escritorioId) as any;
    if (!doc || !doc.arquivo_path || !fs.existsSync(doc.arquivo_path)) return res.status(404).json({ error: "Documento não encontrado." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${(doc.nome_arquivo || "documento.pdf").replace(/["\r\n]/g, "")}"`);
    res.send(fs.readFileSync(doc.arquivo_path));
  });

  // ---------------------------------------------------------------- dashboard
  app.get("/api/certificados/dashboard", d.blockCliente, d.requirePermissao("certificados", "visualizar"), (req, res) => {
    const user = (req as any).user;
    const hojeSp = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const mesSp = hojeSp.slice(0, 7);
    const hoje = sqlite.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) falhas FROM certificados_documentos WHERE escritorio_id = ? AND date(criado_em) = date(?)`).get(user.escritorioId, hojeSp) as any;
    const mes = sqlite.prepare(`SELECT COUNT(*) n, SUM(CASE WHEN status='falha' THEN 1 ELSE 0 END) falhas FROM certificados_documentos WHERE escritorio_id = ? AND strftime('%Y-%m', criado_em) = ?`).get(user.escritorioId, mesSp) as any;
    const porColaborador = sqlite
      .prepare(
        `SELECT u.nome, COUNT(*) n FROM certificados_documentos cd JOIN app_users u ON u.id = cd.user_id
         WHERE cd.escritorio_id = ? AND strftime('%Y-%m', cd.criado_em) = ? AND cd.status = 'assinado' GROUP BY u.id ORDER BY n DESC`
      )
      .all(user.escritorioId, mesSp) as any[];
    const cfg = configDe(user.escritorioId);
    const validade = cfg?.validade_ate ? new Date(cfg.validade_ate) : null;
    const diasRestantes = validade ? Math.ceil((validade.getTime() - Date.now()) / 86400000) : null;
    res.json({
      hoje: { total: hoje?.n || 0, falhas: hoje?.falhas || 0 },
      mes: { total: mes?.n || 0, falhas: mes?.falhas || 0 },
      porColaborador: porColaborador.map((r) => ({ nome: r.nome, total: r.n })),
      certificado: cfg?.arquivo_path ? { titular: cfg.titular, diasRestantes, avisoVencimento: diasRestantes !== null && diasRestantes <= 30 } : null,
    });
  });
}
