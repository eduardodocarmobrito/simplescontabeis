/**
 * Sincronização de clientes via login web do Onvio (Domínio Web) — lê a lista de clientes
 * reaproveitando uma sessão de navegador já autenticada (ver `npm run onvio-login`), porque o
 * login do Onvio exige verificação em duas etapas (SMS/e-mail) que não dá pra resolver sozinho.
 *
 * Extraído de dominio-agent.ts pra ser reaproveitado também pelo próprio servidor: o container do
 * Railway já roda com Playwright/Chromium instalados (imagem oficial do Playwright, ver
 * Dockerfile — hoje usada pra gerar PDF de DANFSe/NF-e simplificada/contratos), então o servidor
 * consegue rodar essa sincronização sozinho, sem depender de nenhuma máquina local ligada. O
 * agente local (dominio-agent.ts) continua existindo pros modos "banco de dados"/"API HTTP" (que
 * exigem rede local do escritório) e pra exportação de XML pra pasta local.
 */

export type EmpresaNormalizadaOnvio = {
  codigo: string;
  nome: string;
  cnpj: string | null;
  email?: string | null;
  telefone?: string | null;
  endereco?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
  inscricaoMunicipal?: string | null;
  inscricaoEstadual?: string | null;
  nomeRepresentanteLegal?: string | null;
  cpfRepresentanteLegal?: string | null;
};

function extrairContato(item: any) {
  const c = item?.primaryContactExpanded || {};
  const email = (c.emailAddresses || []).find((e: any) => e.isPrimary)?.emailAddress || (c.emailAddresses || [])[0]?.emailAddress || null;
  const telefone = (c.phoneNumbers || []).find((p: any) => p.isPrimary)?.phoneNumber || (c.phoneNumbers || [])[0]?.phoneNumber || null;
  const end = (c.addresses || []).find((a: any) => a.isPrimary) || (c.addresses || [])[0];
  const endereco = end ? [end.addressLine1, end.addressLine3].filter(Boolean).join(", ").trim() || null : null;
  const cidade = end?.city || null;
  const uf = end?.stateProvince?.id ? String(end.stateProvince.id).replace("BR-", "") : null;
  const cep = end?.postalCode || null;
  return { email, telefone, endereco, cidade, uf, cep };
}
function extrairDocumento(item: any): string | null {
  const nats = item?.primaryContactExpanded?.nationalIdentitiesExpanded || [];
  const cnpj = nats.find((n: any) => n.kind?.id === "BR-CNPJ" && n.identity);
  const cpf = nats.find((n: any) => n.kind?.id === "BR-CPF" && n.identity);
  return cnpj?.identity || cpf?.identity || null;
}
// Nem toda empresa tem isso preenchido no Onvio (na prática, poucas) — quando não tem, o campo
// fica em branco e é preenchido manualmente na tela (usado pra emissão de NFS-e).
function extrairInscricaoMunicipal(item: any): string | null {
  const nats = item?.primaryContactExpanded?.nationalIdentitiesExpanded || [];
  const im = nats.find((n: any) => n.kind?.id === "BR-IM" && n.identity);
  return im?.identity || null;
}
// Mesmo padrão da Inscrição Municipal acima — "BR-IE" é o código do Onvio pra Inscrição Estadual
// (obrigatória só pra empresas que vendem mercadoria/circulam ICMS; a maioria dos prestadores de
// serviço não tem, então costuma ficar em branco).
function extrairInscricaoEstadual(item: any): string | null {
  const nats = item?.primaryContactExpanded?.nationalIdentitiesExpanded || [];
  const ie = nats.find((n: any) => n.kind?.id === "BR-IE" && n.identity);
  return ie?.identity || null;
}
// O contato principal do cliente no Onvio normalmente É o representante legal/sócio-administrador
// (quem o escritório cadastra como responsável pela empresa) — nome vem do próprio contato, CPF
// vem junto com o CNPJ na mesma lista de documentos (o CNPJ já é usado em extrairDocumento; aqui só
// pega o CPF que sobra, que nem sempre existe — nesse caso fica em branco pra preencher na mão).
function extrairNomeRepresentante(item: any): string | null {
  const nome = item?.primaryContactExpanded?.name;
  return nome ? String(nome).trim() : null;
}
function extrairCpfRepresentante(item: any): string | null {
  const nats = item?.primaryContactExpanded?.nationalIdentitiesExpanded || [];
  const cpf = nats.find((n: any) => n.kind?.id === "BR-CPF" && n.identity);
  return cpf?.identity || null;
}

export async function buscarViaOnvio(sessionPath: string): Promise<EmpresaNormalizadaOnvio[]> {
  const fs = require("fs");
  if (!fs.existsSync(sessionPath)) {
    throw new Error(`Sessão do Onvio não encontrada em "${sessionPath}". Faça o login (npm run onvio-login) e envie o arquivo em Configurações › Domínio Web.`);
  }
  const { chromium } = require("playwright");

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ storageState: sessionPath });
    const page = await context.newPage();

    let authHeader: string | null = null;
    let companyId: string | null = null;
    page.on("request", (req: any) => {
      const m = req.url().match(/\/api\/core\/v3\/companies\/([A-Z0-9]+)\/clients\/search/);
      if (m && !companyId) {
        companyId = m[1];
        authHeader = req.headers()["authorization"] || null;
      }
    });

    await page.goto("https://onvio.com.br/br-api-integration/#/enable-clients", { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(2500);

    if (/\/login|auth\.thomsonreuters\.com/.test(page.url())) {
      throw new Error('A sessão do Onvio expirou ou foi desconectada. Faça o login de novo (npm run onvio-login) e envie o novo arquivo em Configurações › Domínio Web.');
    }
    if (!authHeader || !companyId) {
      throw new Error("Não consegui identificar a empresa/token do Onvio nesta sessão — tente fazer o login de novo.");
    }

    const resp = await page.request.post(`https://onvio.com.br/api/core/v3/companies/${companyId}/clients/search`, {
      headers: { authorization: authHeader },
      data: {
        pagingDataRequest: { startIndex: 1, pageIndex: 1, itemsPerPage: 500 },
        expand: "primaryContactExpanded,primaryContactExpanded.nationalIdentitiesExpanded",
        filterSearchSort: {},
      },
    });
    if (!resp.ok()) throw new Error(`Onvio API -> HTTP ${resp.status()}`);
    const json = await resp.json();
    const items = (json.items || []) as any[];

    return items
      .filter((it) => it.code && it.code !== "FIRM" && !/^EMPRESA EXEMPLO/i.test(it.name || ""))
      .map((it) => {
        const contato = extrairContato(it);
        return {
          codigo: String(it.code),
          nome: String(it.name || "").trim(),
          cnpj: extrairDocumento(it),
          inscricaoMunicipal: extrairInscricaoMunicipal(it),
          inscricaoEstadual: extrairInscricaoEstadual(it),
          nomeRepresentanteLegal: extrairNomeRepresentante(it),
          cpfRepresentanteLegal: extrairCpfRepresentante(it),
          ...contato,
          // situação (ativo/inativo) não vem nessa API — a sincronização automática não mexe
          // nisso pra não reativar/desativar empresa por engano.
        };
      });
  } finally {
    await browser.close();
  }
}
