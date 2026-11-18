/**
 * Integração com o Google Drive (OAuth2 Authorization Code) — sobe os XML buscados direto da nuvem
 * pra uma pasta do Google Drive da conta do ESCRITÓRIO, sem depender de nenhum agente local.
 *
 * Espelha onedrive.ts, mas contra o Google. Conta Google COMUM (Gmail) — por isso OAuth de usuário
 * (os arquivos ficam na cota do próprio escritório), e NÃO conta de serviço (service account não tem
 * cota em Gmail comum, só grava em Drive Compartilhado do Workspace).
 *
 * Escopo `drive.file`: o app só enxerga/mexe nos arquivos e pastas que ELE MESMO cria. Por isso o
 * app cria a árvore de pastas ("Notas Fiscais - Clientes" / "...Serviços Prestados" na raiz do Meu
 * Drive, e por baixo "código-apelido/competência"). É um escopo "sensível", não "restrito" — não
 * exige a verificação paga do Google; basta publicar o app como "Em produção" pra o refresh_token
 * não expirar em 7 dias (modo Testing expira).
 *
 * `access_type=offline` + `prompt=consent`: obrigatórios pra ganhar um refresh_token (sem isso a
 * sessão morre em ~1h). O Google só devolve refresh_token no 1º consentimento — nas renovações
 * seguintes não vem de novo, então guarda-se o da 1ª troca.
 */

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
export const ESCOPOS = "https://www.googleapis.com/auth/drive.file openid email profile";

export function montarUrlAutorizacao(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: ESCOPOS,
    access_type: "offline",
    prompt: "consent", // força o refresh_token mesmo que o usuário já tenha autorizado antes
    include_granted_scopes: "true",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface RespostaToken {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}
async function chamarTokenEndpoint(corpo: Record<string, string>): Promise<RespostaToken> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(corpo).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const bruto = await r.text();
  let json: any;
  try {
    json = JSON.parse(bruto);
  } catch {
    throw new Error(`Resposta inesperada do Google (HTTP ${r.status}): ${bruto.slice(0, 300)}`);
  }
  if (!r.ok) throw new Error(json.error_description || json.error || `HTTP ${r.status}: ${bruto.slice(0, 300)}`);
  return { accessToken: json.access_token, refreshToken: json.refresh_token || null, expiresIn: json.expires_in || 3600 };
}
export function trocarCodePorToken(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<RespostaToken> {
  return chamarTokenEndpoint({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code" });
}
export function renovarAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<RespostaToken> {
  return chamarTokenEndpoint({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" });
}

export async function obterPerfil(accessToken: string): Promise<{ nome: string | null; email: string | null }> {
  const r = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ao ler o perfil do Google.`);
  const j: any = await r.json();
  return { nome: j.name || null, email: j.email || null };
}

async function driveGetJson(accessToken: string, caminho: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`${DRIVE_API}/${caminho}${qs ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
  const txt = await r.text();
  let j: any = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* não-JSON */ }
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}: ${txt.slice(0, 200)}`);
  return j;
}

// Escapa aspas simples e barras invertidas pro valor entrar na query `q` do Drive sem quebrar.
function escQ(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// Acha (ou cria) uma subpasta pelo nome dentro de um pai. parentId "root" = raiz do Meu Drive.
export async function acharOuCriarPasta(accessToken: string, nome: string, parentId: string): Promise<string> {
  const q = `name='${escQ(nome)}' and '${escQ(parentId)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const achado = await driveGetJson(accessToken, "files", { q, fields: "files(id,name)", spaces: "drive", pageSize: "1" });
  if (achado.files && achado.files[0]) return achado.files[0].id;
  const r = await fetch(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: nome, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
    signal: AbortSignal.timeout(30_000),
  });
  const j: any = await r.json();
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status} ao criar a pasta "${nome}".`);
  return j.id;
}

async function acharArquivoNaPasta(accessToken: string, nome: string, parentId: string): Promise<string | null> {
  const q = `name='${escQ(nome)}' and '${escQ(parentId)}' in parents and trashed=false`;
  const j = await driveGetJson(accessToken, "files", { q, fields: "files(id,name)", spaces: "drive", pageSize: "1" });
  return j.files && j.files[0] ? j.files[0].id : null;
}

// Sobe um arquivo pra dentro de parentId. Se já existir um com o mesmo nome, SOBRESCREVE o conteúdo
// (igual ao PUT do OneDrive) — assim reexecutar não duplica. XML é pequeno, upload simples (multipart).
export async function enviarArquivo(accessToken: string, parentId: string, nome: string, conteudo: Buffer): Promise<void> {
  const existenteId = await acharArquivoNaPasta(accessToken, nome, parentId);
  if (existenteId) {
    const r = await fetch(`${DRIVE_UPLOAD}/files/${encodeURIComponent(existenteId)}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "text/xml" },
      body: new Uint8Array(conteudo),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status} ao atualizar "${nome}": ${t.slice(0, 200)}`); }
    return;
  }
  const boundary = "sc_" + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({ name: nome, parents: [parentId] });
  const corpo = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, "utf8"),
    Buffer.from(`--${boundary}\r\nContent-Type: text/xml\r\n\r\n`, "utf8"),
    conteudo,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  const r = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body: new Uint8Array(corpo),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status} ao enviar "${nome}": ${t.slice(0, 200)}`); }
}

// Link direto pra abrir a pasta no navegador (mostrado ao usuário depois de conectar/criar).
export function linkPasta(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
