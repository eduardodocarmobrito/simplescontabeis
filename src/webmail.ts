// Módulo E-mail (webmail): lê e envia pela caixa Gmail do escritório usando a MESMA conta e senha de app já
// configuradas em Configurações › E-mail corporativo (tabela email_extratos_config). IMAP (imap.gmail.com) pra ler,
// SMTP (smtp.gmail.com) pra enviar. Uma conexão IMAP por escritório é reaproveitada e fechada depois de 90 s parada;
// as chamadas são enfileiradas (o Gmail limita conexões simultâneas por conta).
import type express from "express";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

type Deps = {
  blockCliente: express.RequestHandler;
  requirePermissao: (modulo: any, acao: "visualizar" | "postar" | "editar") => express.RequestHandler;
  credenciais: (escritorioId: number) => { email: string; senha: string } | null;
  upload: any; // multer
  corrigirNomeArquivo: (n: string) => string;
  sqlite: any; // node:sqlite (contatos já usados + cadastro das empresas)
};

type Conexao = { client: ImapFlow; fila: Promise<any>; timer: NodeJS.Timeout | null };
const conexoes = new Map<number, Conexao>();

async function comImap<T>(escritorioId: number, cred: { email: string; senha: string }, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  let con = conexoes.get(escritorioId);
  if (!con) {
    con = { client: null as any, fila: Promise.resolve(), timer: null };
    conexoes.set(escritorioId, con);
  }
  const c = con;
  const rodar = async (): Promise<T> => {
    if (c.timer) { clearTimeout(c.timer); c.timer = null; }
    if (!c.client || !c.client.usable) {
      try { c.client?.close(); } catch { /* já fechada */ }
      c.client = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user: cred.email, pass: cred.senha }, logger: false });
      c.client.on("error", () => { /* erro de socket: a próxima chamada reconecta */ });
      await c.client.connect();
    }
    try {
      return await fn(c.client);
    } catch (e) {
      try { c.client.close(); } catch { /* ignora */ }
      throw e;
    } finally {
      c.timer = setTimeout(() => { try { c.client?.logout().catch(() => {}); } catch { /* ignora */ } }, 90_000);
    }
  };
  const p = c.fila.then(rodar, rodar);
  c.fila = p.catch(() => {});
  return p;
}

const ESPECIAIS: Record<string, { chave: string; nome: string; ordem: number }> = {
  "\\Inbox": { chave: "inbox", nome: "Caixa de entrada", ordem: 1 },
  "\\Flagged": { chave: "estrela", nome: "Com estrela", ordem: 2 },
  "\\Sent": { chave: "enviados", nome: "Enviados", ordem: 3 },
  "\\Drafts": { chave: "rascunhos", nome: "Rascunhos", ordem: 4 },
  "\\Junk": { chave: "spam", nome: "Spam", ordem: 5 },
  "\\Trash": { chave: "lixeira", nome: "Lixeira", ordem: 6 },
  "\\All": { chave: "todos", nome: "Todos os e-mails", ordem: 7 },
  "\\Archive": { chave: "todos", nome: "Arquivo", ordem: 7 },
};

async function listarPastas(c: ImapFlow) {
  const lista = await c.list({ statusQuery: { unseen: true, messages: true } });
  const itens = lista
    .filter((p) => !p.flags.has("\\Noselect") && !p.flags.has("\\NonExistent"))
    .map((p) => {
      const esp = (p.specialUse && ESPECIAIS[p.specialUse]) || (p.path.toUpperCase() === "INBOX" ? ESPECIAIS["\\Inbox"] : null);
      return { caminho: p.path, nome: esp ? esp.nome : p.path.split(p.delimiter || "/").join(" › "), especial: esp ? esp.chave : null, ordem: esp ? esp.ordem : 100, naoLidas: p.status?.unseen || 0, total: p.status?.messages || 0 };
    })
    // "Importante" e "Todos os e-mails" do Gmail duplicam a caixa de entrada — só o Todos fica (útil pra achar arquivados).
    .filter((p) => !/\[Gmail\]\/(Important|Importante)/i.test(p.caminho));
  itens.sort((a, b) => a.ordem - b.ordem || a.nome.localeCompare(b.nome, "pt-BR"));
  return itens;
}

function achaPasta(pastas: { caminho: string; especial: string | null }[], especial: string): string | null {
  return pastas.find((p) => p.especial === especial)?.caminho || null;
}

function endereco(a: any) {
  return a ? { nome: a.name || "", email: a.address || "" } : null;
}
function temAnexo(no: any): boolean {
  if (!no) return false;
  if (no.disposition && String(no.disposition).toLowerCase() === "attachment") return true;
  return (no.childNodes || []).some(temAnexo);
}

function nomeSeguro(n: string): string {
  return (n || "arquivo").replace(/[\r\n"\\/]/g, "_");
}

export function registerWebmail(app: express.Express, d: Deps) {
  const ler = [d.blockCliente, d.requirePermissao("email", "visualizar")];

  function cred(req: any, res: express.Response) {
    const c = d.credenciais(req.user.escritorioId);
    if (!c) {
      res.status(400).json({ error: "Configure o e-mail e a senha de app em Configurações › E-mail corporativo antes de usar o módulo E-mail." });
      return null;
    }
    return c;
  }
  const falha = (res: express.Response, e: any) => {
    const msg = String(e?.message || e);
    const auth = /auth|credential|invalid|login/i.test(msg) || e?.authenticationFailed;
    res.status(502).json({ error: auth ? "O Gmail recusou o login. Confira o e-mail e a senha de app em Configurações › E-mail corporativo." : "Falha no e-mail: " + msg });
  };

  app.get("/api/email/status", ...ler, (req, res) => {
    const c = d.credenciais((req as any).user.escritorioId);
    res.json({ configurado: !!c, email: c?.email || null });
  });

  // Contatos a quem já escrevemos (memória própria, alimentada a cada envio e a cada busca na pasta Enviados do Gmail)
  // + e-mails dos cadastros das empresas. Ao digitar 2+ letras a tela sugere e marca quem "já recebeu e-mail daqui".
  d.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS email_contatos (
      escritorio_id INTEGER NOT NULL,
      email TEXT NOT NULL,
      nome TEXT,
      usos INTEGER NOT NULL DEFAULT 1,
      ultimo_uso TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (escritorio_id, email)
    );
  `);
  const guardarContato = (escritorioId: number, email: string, nome?: string) => {
    const e = String(email || "").trim().toLowerCase();
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e)) return;
    d.sqlite
      .prepare(`INSERT INTO email_contatos (escritorio_id, email, nome) VALUES (?, ?, ?)
                ON CONFLICT(escritorio_id, email) DO UPDATE SET usos = usos + 1, ultimo_uso = datetime('now'), nome = COALESCE(NULLIF(excluded.nome, ''), nome)`)
      .run(escritorioId, e, nome || null);
  };
  app.get("/api/email/contatos", ...ler, async (req, res) => {
    const user = (req as any).user;
    const q = String(req.query.q || "").trim().toLowerCase();
    if (q.length < 2) return res.json({ itens: [] });
    const like = `%${q.replace(/[%_]/g, "")}%`;
    const achados = new Map<string, { email: string; nome: string; origem: "enviado" | "recebido" | "cadastro"; empresa?: string }>();
    for (const r of d.sqlite.prepare(`SELECT email, nome FROM email_contatos WHERE escritorio_id = ? AND (email LIKE ? OR LOWER(COALESCE(nome,'')) LIKE ?) ORDER BY usos DESC, ultimo_uso DESC LIMIT 12`).all(user.escritorioId, like, like) as any[])
      achados.set(r.email, { email: r.email, nome: r.nome || "", origem: "enviado" });
    // Se ainda tem pouco, procura na pasta Enviados do Gmail (cobre o que foi enviado antes deste módulo existir).
    const c = d.credenciais(user.escritorioId);
    if (c && achados.size < 6) {
      try {
        const encontrados = await Promise.race([
          comImap(user.escritorioId, c, async (cl) => {
            const pastas = await listarPastas(cl);
            const out: { email: string; nome: string; origem: "enviado" | "recebido" }[] = [];
            // Enviados (para quem já escrevemos) e Caixa de entrada (quem já nos escreveu).
            for (const [pasta, campo, origem] of [[achaPasta(pastas, "enviados"), "to", "enviado"], [achaPasta(pastas, "inbox"), "from", "recebido"]] as const) {
              if (!pasta) continue;
              const lock = await cl.getMailboxLock(pasta, { readOnly: true });
              try {
                const uids = (((await cl.search({ [campo]: q }, { uid: true })) || []) as number[]).sort((a, b) => b - a).slice(0, 40);
                if (uids.length) for await (const m of cl.fetch(uids.join(","), { envelope: true }, { uid: true })) {
                  const lista = origem === "enviado" ? [...(m.envelope?.to || []), ...(m.envelope?.cc || [])] : m.envelope?.from || [];
                  for (const a of lista)
                    if (a.address && (a.address.toLowerCase().includes(q) || (a.name || "").toLowerCase().includes(q))) out.push({ email: a.address, nome: a.name || "", origem });
                }
              } finally { lock.release(); }
            }
            return out;
          }),
          new Promise<{ email: string; nome: string; origem: "enviado" | "recebido" }[]>((r) => setTimeout(() => r([]), 7000)),
        ]);
        for (const e of encontrados) {
          const k = e.email.toLowerCase();
          if (!achados.has(k)) {
            achados.set(k, { email: k, nome: e.nome, origem: e.origem });
            if (e.origem === "enviado") guardarContato(user.escritorioId, k, e.nome);
          }
        }
      } catch { /* sem a busca no Gmail ainda devolve o que tem */ }
    }
    for (const r of d.sqlite.prepare(
      `SELECT ec.email as email, ec.nome as nome, e.nome as empresa FROM empresa_contatos ec JOIN empresas e ON e.id = ec.empresa_id
       WHERE e.escritorio_id = ? AND (LOWER(ec.email) LIKE ? OR LOWER(ec.nome) LIKE ? OR LOWER(e.nome) LIKE ?) LIMIT 10`
    ).all(user.escritorioId, like, like, like) as any[]) {
      const k = String(r.email || "").toLowerCase();
      if (k && !achados.has(k)) achados.set(k, { email: k, nome: r.nome || "", origem: "cadastro", empresa: r.empresa });
    }
    res.json({ itens: [...achados.values()].slice(0, 12) });
  });

  app.get("/api/email/pastas", ...ler, async (req, res) => {
    const c = cred(req, res); if (!c) return;
    try { res.json({ itens: await comImap((req as any).user.escritorioId, c, listarPastas) }); } catch (e) { falha(res, e); }
  });

  // Lista paginada (50 por vez, mais novas primeiro). `busca` procura no assunto, remetente, destinatário e texto.
  app.get("/api/email/mensagens", ...ler, async (req, res) => {
    const c = cred(req, res); if (!c) return;
    const pasta = String(req.query.pasta || "INBOX");
    const pagina = Math.max(1, Number(req.query.pagina) || 1);
    const busca = String(req.query.busca || "").trim();
    const soNaoLidas = req.query.filtro === "nao-lidas";
    const POR = 50;
    try {
      const r = await comImap((req as any).user.escritorioId, c, async (cl) => {
        const lock = await cl.getMailboxLock(pasta, { readOnly: true });
        try {
          const campos = { uid: true, envelope: true, flags: true, internalDate: true, bodyStructure: true } as const;
          let total = 0;
          const itens: any[] = [];
          const montar = (m: any) => ({
            uid: m.uid,
            de: endereco(m.envelope?.from?.[0]),
            para: (m.envelope?.to || []).map(endereco),
            assunto: m.envelope?.subject || "(sem assunto)",
            data: (m.internalDate instanceof Date ? m.internalDate : new Date(m.envelope?.date || Date.now())).toISOString(),
            lida: m.flags?.has("\\Seen") || false,
            estrela: m.flags?.has("\\Flagged") || false,
            anexo: temAnexo(m.bodyStructure),
          });
          if (busca || soNaoLidas) {
            const criterio: any = busca
              ? { or: [{ subject: busca }, { from: busca }, { to: busca }, { body: busca }], ...(soNaoLidas ? { seen: false } : {}) }
              : { seen: false };
            const uids = ((await cl.search(criterio, { uid: true })) || []) as number[];
            uids.sort((a, b) => b - a);
            total = uids.length;
            const fatia = uids.slice((pagina - 1) * POR, pagina * POR);
            if (fatia.length) for await (const m of cl.fetch(fatia.join(","), campos, { uid: true })) itens.push(montar(m));
          } else {
            const exists = (cl.mailbox as any).exists as number;
            total = exists;
            const fim = exists - (pagina - 1) * POR;
            const ini = Math.max(1, fim - POR + 1);
            if (fim >= 1) for await (const m of cl.fetch(`${ini}:${fim}`, campos)) itens.push(montar(m));
          }
          itens.sort((a, b) => (a.data < b.data ? 1 : -1));
          return { total, pagina, porPagina: POR, itens };
        } finally { lock.release(); }
      });
      res.json(r);
    } catch (e) { falha(res, e); }
  });

  // Uma mensagem inteira. Marca como lida. O HTML volta com as imagens embutidas (cid:) já convertidas em data URI.
  app.get("/api/email/mensagem", ...ler, async (req, res) => {
    const c = cred(req, res); if (!c) return;
    const pasta = String(req.query.pasta || "INBOX");
    const uid = Number(req.query.uid);
    if (!uid) return res.status(400).json({ error: "Mensagem inválida." });
    try {
      const r = await comImap((req as any).user.escritorioId, c, async (cl) => {
        const lock = await cl.getMailboxLock(pasta);
        try {
          const m = await cl.fetchOne(String(uid), { source: true, flags: true }, { uid: true });
          if (!m || !m.source) return null;
          if (!m.flags?.has("\\Seen")) await cl.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          return { source: m.source, estrela: m.flags?.has("\\Flagged") || false };
        } finally { lock.release(); }
      });
      if (!r) return res.status(404).json({ error: "Mensagem não encontrada (pode ter sido movida ou excluída)." });
      const p = await simpleParser(r.source);
      let html = typeof p.html === "string" ? p.html : "";
      const anexos = (p.attachments || []).map((a, idx) => ({ idx, nome: a.filename || `anexo-${idx + 1}`, tipo: a.contentType, tamanho: a.size, inline: !!a.related, cid: a.contentId ? a.contentId.replace(/^<|>$/g, "") : null }));
      if (html) {
        for (const a of p.attachments || []) {
          const cid = a.contentId ? a.contentId.replace(/^<|>$/g, "") : null;
          if (cid && /^image\//.test(a.contentType)) html = html.split(`cid:${cid}`).join(`data:${a.contentType};base64,${a.content.toString("base64")}`);
        }
      }
      const lista = (v: any) => (v ? (Array.isArray(v) ? v : [v]).flatMap((x: any) => x.value || []).map((a: any) => ({ nome: a.name || "", email: a.address || "" })) : []);
      res.json({
        uid, assunto: p.subject || "(sem assunto)", de: endereco(p.from?.value?.[0]), para: lista(p.to), cc: lista(p.cc), responderPara: lista(p.replyTo),
        data: p.date ? p.date.toISOString() : null, html, texto: p.text || "", temHtml: !!html,
        anexos: anexos.filter((a) => !(a.inline && a.cid && html.includes("data:" + a.tipo))),
        messageId: p.messageId || null, references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [], estrela: r.estrela,
      });
    } catch (e) { falha(res, e); }
  });

  app.get("/api/email/anexo", ...ler, async (req, res) => {
    const c = cred(req, res); if (!c) return;
    const pasta = String(req.query.pasta || "INBOX");
    const uid = Number(req.query.uid);
    const idx = Number(req.query.idx);
    try {
      const src = await comImap((req as any).user.escritorioId, c, async (cl) => {
        const lock = await cl.getMailboxLock(pasta, { readOnly: true });
        try { return (await cl.fetchOne(String(uid), { source: true }, { uid: true }) as any)?.source as Buffer | undefined; } finally { lock.release(); }
      });
      if (!src) return res.status(404).json({ error: "Mensagem não encontrada." });
      const p = await simpleParser(src);
      const a = (p.attachments || [])[idx];
      if (!a) return res.status(404).json({ error: "Anexo não encontrado." });
      const inline = req.query.inline === "1" && /^(image\/(png|jpe?g|gif|webp)|application\/pdf)$/i.test(a.contentType);
      res.setHeader("Content-Type", inline ? a.contentType : "application/octet-stream");
      res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(nomeSeguro(a.filename || "anexo"))}`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(a.content);
    } catch (e) { falha(res, e); }
  });

  // Ações em uma ou várias mensagens.
  app.post("/api/email/acao", d.blockCliente, d.requirePermissao("email", "editar"), async (req, res) => {
    const c = cred(req, res); if (!c) return;
    const pasta = String(req.body?.pasta || "INBOX");
    const uids: number[] = (Array.isArray(req.body?.uids) ? req.body.uids : []).map(Number).filter(Boolean).slice(0, 200);
    const acao = String(req.body?.acao || "");
    if (!uids.length) return res.status(400).json({ error: "Nenhuma mensagem selecionada." });
    try {
      await comImap((req as any).user.escritorioId, c, async (cl) => {
        const pastas = await listarPastas(cl);
        const conj = uids.join(",");
        const mover = async (destino: string | null) => {
          if (!destino) throw new Error("Pasta de destino não encontrada nesta caixa.");
          await cl.messageMove(conj, destino, { uid: true });
        };
        const lock = await cl.getMailboxLock(pasta);
        try {
          if (acao === "lida") await cl.messageFlagsAdd(conj, ["\\Seen"], { uid: true });
          else if (acao === "nao-lida") await cl.messageFlagsRemove(conj, ["\\Seen"], { uid: true });
          else if (acao === "estrela") await cl.messageFlagsAdd(conj, ["\\Flagged"], { uid: true });
          else if (acao === "tirar-estrela") await cl.messageFlagsRemove(conj, ["\\Flagged"], { uid: true });
          else if (acao === "arquivar") await mover(achaPasta(pastas, "todos"));
          else if (acao === "spam") await mover(achaPasta(pastas, "spam"));
          else if (acao === "nao-spam") await mover(achaPasta(pastas, "inbox"));
          else if (acao === "lixeira") await mover(achaPasta(pastas, "lixeira"));
          else if (acao === "mover") await mover(String(req.body?.destino || ""));
          else if (acao === "excluir") {
            // Só apaga de vez o que já está na Lixeira ou no Spam; de qualquer outro lugar vai pra Lixeira.
            const esp = pastas.find((p) => p.caminho === pasta)?.especial;
            if (esp === "lixeira" || esp === "spam") await cl.messageDelete(conj, { uid: true });
            else await mover(achaPasta(pastas, "lixeira"));
          } else throw new Error("Ação inválida.");
        } finally { lock.release(); }
      });
      res.json({ ok: true });
    } catch (e) { falha(res, e); }
  });

  // Envia (novo, resposta ou encaminhamento). Multipart: campos + arquivos em "anexos".
  app.post("/api/email/enviar", d.blockCliente, d.requirePermissao("email", "postar"), d.upload.array("anexos", 10), async (req, res) => {
    const c = cred(req, res); if (!c) return;
    const b = req.body || {};
    const lista = (v: any) => String(v || "").split(/[;,\n]/).map((s) => s.trim()).filter(Boolean);
    const para = lista(b.para), cc = lista(b.cc), cco = lista(b.cco);
    const valido = (e: string) => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e.replace(/^.*<([^>]+)>\s*$/, "$1"));
    if (!para.length) return res.status(400).json({ error: "Informe pelo menos um destinatário." });
    const ruim = [...para, ...cc, ...cco].find((e) => !valido(e));
    if (ruim) return res.status(400).json({ error: `Endereço inválido: ${ruim}` });
    const html = String(b.html || "");
    const texto = String(b.texto || html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim());
    if (!html.trim() && !texto.trim()) return res.status(400).json({ error: "Escreva a mensagem." });
    try {
      const transporte = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: c.email, pass: c.senha } });
      const arquivos = ((req as any).files || []) as { originalname: string; buffer: Buffer; mimetype: string }[];
      const refs = lista(b.references);
      const info = await transporte.sendMail({
        from: { name: "Simples Contábeis", address: c.email },
        to: para, cc, bcc: cco,
        subject: String(b.assunto || "").trim() || "(sem assunto)",
        text: texto, html: html || undefined,
        ...(b.inReplyTo ? { inReplyTo: String(b.inReplyTo), references: [...refs, String(b.inReplyTo)] } : {}),
        attachments: arquivos.map((a) => ({ filename: d.corrigirNomeArquivo(a.originalname), content: a.buffer, contentType: a.mimetype })),
      });
      for (const e of [...para, ...cc, ...cco]) {
        const m = /^(.*?)\s*<([^>]+)>$/.exec(e);
        guardarContato((req as any).user.escritorioId, m ? m[2] : e, m ? m[1].replace(/^"|"$/g, "") : undefined);
      }
      res.json({ ok: true, messageId: info.messageId });
    } catch (e: any) { falha(res, e); }
  });
}
