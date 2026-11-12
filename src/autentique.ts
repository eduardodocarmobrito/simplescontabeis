// Integração com a Autentique (api.autentique.com.br/v2/graphql) — assinatura eletrônica dos
// contratos. API é só GraphQL; upload de arquivo segue o graphql-multipart-request-spec
// (operations + map + arquivo em campos separados do multipart), documentado em
// docs.autentique.com.br/api/mutations/criando-um-documento.md.
const ENDPOINT = "https://api.autentique.com.br/v2/graphql";

export interface AutentiqueSigner {
  nome?: string;
  email?: string;
  telefone?: string; // formato E.164, ex: +5594999999999 — obrigatório ter email OU telefone
  comoAssina?: "SIGN" | "SIGN_AS_A_WITNESS" | "APPROVE" | "RECOGNIZE";
  // Onde o carimbo da assinatura aparece no PDF: x/y = centro do campo em % da página, z = página (1ª = 1).
  posicoes?: { x: string; y: string; z: number; element: "SIGNATURE" | "NAME" | "DATE" | "CPF" }[];
  // CPF (só dígitos) que a Autentique exige do signatário: só quem informar exatamente esse CPF assina
  // (signers[].configs.cpf — docs "Criando um documento", Additional Validations).
  cpf?: string;
  // true = não manda e-mail/WhatsApp automático (delivery_method LINK) — só gera o link de assinatura,
  // pra quem enviou copiar e mandar manualmente (ex.: colar no WhatsApp de quem não tem e-mail aberto
  // no momento). Achado real (2026-11-12): a Autentique só permite UM canal automático por
  // signatário — não dá pra mandar e-mail E WhatsApp pro mesmo signatário ao mesmo tempo.
  somenteLink?: boolean;
}

async function chamarApi(token: string, body: FormData | string, extraHeaders: Record<string, string> = {}) {
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`Autentique respondeu ${resp.status}${json ? "" : " (resposta não é JSON)"}`);
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  return json.data;
}

export async function criarDocumento(opts: {
  token: string;
  nomeDocumento: string;
  pdf: Buffer;
  signers: AutentiqueSigner[];
  sandbox: boolean;
}): Promise<{ id: string; signatures: any[] }> {
  const query = `mutation CriarDocumento($document: DocumentInput!, $signers: [SignerInput!]!, $file: Upload!, $sandbox: Boolean) {
    createDocument(document: $document, signers: $signers, file: $file, sandbox: $sandbox) {
      id name created_at
      signatures { public_id name email action { name } link { short_link } }
    }
  }`;
  // A Autentique rejeita um signatário com email E telefone juntos ("only_one_allowed:email,
  // phone") — prioriza email (canal mais confiável) e só usa telefone/WhatsApp quando não há email.
  // (regra concentrada em signerPayload, reaproveitada por adicionarSignatario mais abaixo)
  const signersPayload = opts.signers.map(signerPayload);
  // footer RIGHT = faixa na lateral DIREITA de TODAS as páginas com a marca de assinatura eletrônica e o
  // código/link de verificação do documento (estilo dos documentos assinados na Junta Comercial). A
  // página de auditoria (rastreio: IP, data/hora, e-mail de cada assinatura) já vem por padrão no final.
  const variables = { document: { name: opts.nomeDocumento, footer: "RIGHT", footer_type: "STANDARD" }, signers: signersPayload, file: null, sandbox: opts.sandbox };
  const form = new FormData();
  form.append("operations", JSON.stringify({ query, variables }));
  form.append("map", JSON.stringify({ file: ["variables.file"] }));
  form.append("file", new Blob([new Uint8Array(opts.pdf)], { type: "application/pdf" }), "contrato.pdf");
  const data = await chamarApi(opts.token, form);
  return data.createDocument;
}

export interface AutentiqueStatusSignatario {
  publicId: string | null; // id do signatário na Autentique — usado pra reenviar só pra ele
  nome: string | null;
  email: string | null;
  acao: string | null;
  visualizadoEm: string | null;
  assinadoEm: string | null;
  rejeitadoEm: string | null;
  // Só vem preenchido pra signatário enviado com somenteLink (delivery_method LINK) — link direto
  // pra página de assinatura, pra copiar e mandar manualmente (WhatsApp, e-mail, etc.).
  link: string | null;
}

export async function consultarDocumento(token: string, id: string): Promise<{
  id: string;
  signatarios: AutentiqueStatusSignatario[];
  todosAssinaram: boolean;
  algumRejeitou: boolean;
  pdfAssinadoUrl: string | null;
}> {
  const query = `query ConsultarDocumento($id: UUID!) {
    document(id: $id) {
      id name
      signatures { public_id name email action { name } viewed { created_at } signed { created_at } rejected { created_at } link { short_link } }
      files { signed pades }
    }
  }`;
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { id } }),
    signal: AbortSignal.timeout(20_000),
  });
  const json: any = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`Autentique respondeu ${resp.status}`);
  if (json.errors?.length) throw new Error(json.errors.map((e: any) => e.message).join("; "));
  const doc = json.data.document;
  const signatarios: AutentiqueStatusSignatario[] = (doc.signatures || []).map((s: any) => ({
    publicId: s.public_id || null,
    nome: s.name,
    email: s.email,
    acao: s.action?.name || null,
    visualizadoEm: s.viewed?.created_at || null,
    assinadoEm: s.signed?.created_at || null,
    rejeitadoEm: s.rejected?.created_at || null,
    link: s.link?.short_link || null,
  }));
  return {
    id: doc.id,
    signatarios,
    todosAssinaram: signatarios.length > 0 && signatarios.every((s) => !!s.assinadoEm),
    algumRejeitou: signatarios.some((s) => !!s.rejeitadoEm),
    pdfAssinadoUrl: doc.files?.signed || doc.files?.pades || null,
  };
}

// Reenvia o pedido de assinatura (e-mail/WhatsApp) só pros signatários escolhidos, no MESMO
// documento — quem já assinou continua assinado.
export async function reenviarAssinaturas(token: string, publicIds: string[]): Promise<boolean> {
  const query = `mutation Reenviar($ids: [UUID]) { resendSignatures(public_ids: $ids) }`;
  const data = await chamarApi(token, JSON.stringify({ query, variables: { ids: publicIds } }), { "Content-Type": "application/json" });
  return !!data.resendSignatures;
}

// Monta o payload de 1 signatário igual ao de criarDocumento (mesma regra de email x telefone,
// somenteLink etc.) — extraído pra ser reaproveitado também por adicionarSignatario.
function signerPayload(s: AutentiqueSigner): Record<string, any> {
  const item: Record<string, any> = { action: s.comoAssina || "SIGN" };
  if (s.nome) item.name = s.nome;
  if (s.posicoes?.length) item.positions = s.posicoes;
  const cpf = String(s.cpf || "").replace(/\D/g, "");
  if (cpf.length === 11) item.configs = { cpf };
  if (s.email) {
    item.email = s.email;
  } else if (s.telefone) {
    item.phone = s.telefone;
    item.delivery_method = "DELIVERY_METHOD_WHATSAPP";
  }
  if (s.somenteLink) item.delivery_method = "DELIVERY_METHOD_LINK";
  return item;
}

// Remove um signatário de um documento já criado (ex.: cadastrado com e-mail errado) — a Autentique
// não tem mutation pra EDITAR e-mail de signatário existente (confirmado na doc oficial,
// 2026-11-12: docs.autentique.com.br/api/mutations/editing-a-document.md só cobre config do
// documento, não de signatário). O jeito documentado é excluir e recriar (ver adicionarSignatario).
export async function excluirSignatario(token: string, documentId: string, publicId: string): Promise<boolean> {
  const query = `mutation ExcluirSignatario($publicId: UUID!, $documentId: UUID!) { deleteSigner(public_id: $publicId, document_id: $documentId) }`;
  const data = await chamarApi(token, JSON.stringify({ query, variables: { publicId, documentId } }), { "Content-Type": "application/json" });
  return !!data.deleteSigner;
}

// Adiciona um signatário novo a um documento já existente — usado em conjunto com excluirSignatario
// pra "corrigir" o e-mail de alguém que foi cadastrado errado no envio original.
export async function adicionarSignatario(token: string, documentId: string, signer: AutentiqueSigner): Promise<AutentiqueStatusSignatario> {
  const query = `mutation AdicionarSignatario($documentId: UUID!, $signer: SignerInput) {
    createSigner(document_id: $documentId, signer: $signer) {
      public_id name email action { name } link { short_link }
    }
  }`;
  const data = await chamarApi(
    token,
    JSON.stringify({ query, variables: { documentId, signer: signerPayload(signer) } }),
    { "Content-Type": "application/json" }
  );
  const s = data.createSigner;
  return {
    publicId: s?.public_id || null,
    nome: s?.name || null,
    email: s?.email || null,
    acao: s?.action?.name || null,
    visualizadoEm: null,
    assinadoEm: null,
    rejeitadoEm: null,
    link: s?.link?.short_link || null,
  };
}

// Gera um link pra um signatário JÁ EXISTENTE (criado com e-mail/WhatsApp), sem mandar nada de novo
// nem recriar o documento inteiro — pra quando alguém esqueceu de marcar "só gerar link" no envio
// original e precisa do link avulso pra colar manualmente depois.
export async function criarLinkParaSignatario(token: string, publicId: string): Promise<string | null> {
  const query = `mutation CriarLink($id: UUID!) { createLinkToSignature(public_id: $id) { short_link } }`;
  const data = await chamarApi(token, JSON.stringify({ query, variables: { id: publicId } }), { "Content-Type": "application/json" });
  return data.createLinkToSignature?.short_link || null;
}

// Telefones no cadastro de empresas/testemunhas vêm sem DDI (ex.: "94999999999" ou com máscara
// "(94) 99999-9999") — a Autentique exige E.164 (+55...) pra entrega por WhatsApp.
export function normalizarTelefoneBR(telefone: string | null | undefined): string | undefined {
  if (!telefone) return undefined;
  const digitos = telefone.replace(/\D/g, "");
  if (!digitos) return undefined;
  if (telefone.trim().startsWith("+")) return "+" + digitos;
  if (digitos.length <= 11) return "+55" + digitos; // DDD + número, sem DDI
  return "+" + digitos; // já vem com DDI (ex.: 55...)
}

export async function baixarPdfAssinado(token: string, url: string): Promise<Buffer> {
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  if (!resp.ok) throw new Error(`Falha ao baixar PDF assinado (HTTP ${resp.status})`);
  return Buffer.from(await resp.arrayBuffer());
}
