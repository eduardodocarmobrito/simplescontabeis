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
  const signersPayload = opts.signers.map((s) => {
    const item: Record<string, any> = { action: s.comoAssina || "SIGN" };
    if (s.nome) item.name = s.nome;
    if (s.email) {
      item.email = s.email;
    } else if (s.telefone) {
      item.phone = s.telefone;
      item.delivery_method = "DELIVERY_METHOD_WHATSAPP";
    }
    return item;
  });
  const variables = { document: { name: opts.nomeDocumento }, signers: signersPayload, file: null, sandbox: opts.sandbox };
  const form = new FormData();
  form.append("operations", JSON.stringify({ query, variables }));
  form.append("map", JSON.stringify({ file: ["variables.file"] }));
  form.append("file", new Blob([new Uint8Array(opts.pdf)], { type: "application/pdf" }), "contrato.pdf");
  const data = await chamarApi(opts.token, form);
  return data.createDocument;
}

export interface AutentiqueStatusSignatario {
  nome: string | null;
  email: string | null;
  acao: string | null;
  visualizadoEm: string | null;
  assinadoEm: string | null;
  rejeitadoEm: string | null;
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
      signatures { name email action { name } viewed { created_at } signed { created_at } rejected { created_at } }
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
    nome: s.name,
    email: s.email,
    acao: s.action?.name || null,
    visualizadoEm: s.viewed?.created_at || null,
    assinadoEm: s.signed?.created_at || null,
    rejeitadoEm: s.rejected?.created_at || null,
  }));
  return {
    id: doc.id,
    signatarios,
    todosAssinaram: signatarios.length > 0 && signatarios.every((s) => !!s.assinadoEm),
    algumRejeitou: signatarios.some((s) => !!s.rejeitadoEm),
    pdfAssinadoUrl: doc.files?.signed || doc.files?.pades || null,
  };
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
