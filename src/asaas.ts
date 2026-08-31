import https from "https";

/**
 * Integração com a API do Asaas (gateway de pagamento — Pix/cartão/boleto) pra cobrança da
 * licença mensal do módulo NFS-e self-service.
 *
 * IMPORTANTE: construído a partir da documentação pública do Asaas, sem uma API key real em mãos
 * pra testar. Ao contrário do módulo nfse.ts (que foi validado exaustivamente contra o ambiente
 * real do governo), este módulo AINDA NÃO FOI TESTADO contra a API real do Asaas — é bem possível
 * que a URL base, algum nome de campo ou o formato de resposta precise de ajuste no primeiro teste
 * real, do mesmo jeito que aconteceu várias vezes com a integração do NFS-e antes de funcionar.
 * Ajuste ASAAS_BASE_URL/os campos abaixo se o primeiro teste real devolver erro de rota ou schema.
 */

const ASAAS_BASE_URL = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  producao: "https://api.asaas.com/v3",
} as const;
export type AmbienteAsaas = keyof typeof ASAAS_BASE_URL;

function ambienteAtual(): AmbienteAsaas {
  return process.env.ASAAS_AMBIENTE === "producao" ? "producao" : "sandbox";
}
function apiKey(): string {
  const key = process.env.ASAAS_API_KEY || "";
  if (!key) throw new Error('ASAAS_API_KEY não configurada no .env — necessária para cobrar a licença via Asaas.');
  return key;
}

interface RespostaAsaas {
  status: number;
  ok: boolean;
  corpo: any;
}
function chamarAsaas(metodo: "GET" | "POST", caminho: string, corpo?: object): Promise<RespostaAsaas> {
  return new Promise((resolve, reject) => {
    const base = new URL(ASAAS_BASE_URL[ambienteAtual()] + caminho);
    const bodyBuffer = corpo ? Buffer.from(JSON.stringify(corpo), "utf8") : undefined;
    const req = https.request(
      {
        hostname: base.hostname,
        path: base.pathname + base.search,
        method: metodo,
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "SimplesContabeis",
          access_token: apiKey(),
          ...(bodyBuffer ? { "Content-Length": String(bodyBuffer.length) } : {}),
        },
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const texto = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(texto);
          } catch {
            /* resposta não era JSON — json fica null, corpo cru vai em .corpo mesmo assim via texto abaixo */
          }
          resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, corpo: json ?? texto });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao conectar no Asaas.")));
    req.on("error", (e) => reject(e));
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}
function mensagemErroAsaas(resposta: RespostaAsaas): string {
  const lista = resposta.corpo?.errors;
  if (Array.isArray(lista)) return lista.map((e: any) => e.description || e.code || "").filter(Boolean).join(" | ") || `HTTP ${resposta.status}`;
  return typeof resposta.corpo === "string" ? resposta.corpo : `HTTP ${resposta.status}`;
}

// Busca um cliente Asaas já cadastrado pelo CPF/CNPJ; cria um novo se não existir. Devolve o
// customerId do Asaas (formato "cus_xxx"), pra reaproveitar nas cobranças seguintes.
export async function obterOuCriarCliente(params: { cpfCnpj: string; nome: string; email?: string | null; telefone?: string | null }): Promise<string> {
  if (!params.cpfCnpj || !params.cpfCnpj.trim()) throw new Error("CPF/CNPJ não cadastrado — preencha antes de gerar a cobrança.");
  const cpfCnpj = params.cpfCnpj.replace(/\D/g, "");
  const busca = await chamarAsaas("GET", `/customers?cpfCnpj=${cpfCnpj}`);
  if (busca.ok && Array.isArray(busca.corpo?.data) && busca.corpo.data.length) return busca.corpo.data[0].id;
  const criacao = await chamarAsaas("POST", "/customers", {
    name: params.nome,
    cpfCnpj,
    email: params.email || undefined,
    mobilePhone: params.telefone ? params.telefone.replace(/\D/g, "") : undefined,
  });
  if (!criacao.ok) throw new Error(`Não consegui cadastrar o cliente no Asaas: ${mensagemErroAsaas(criacao)}`);
  return criacao.corpo.id;
}

export interface CobrancaAsaas {
  id: string;
  status: string;
  invoiceUrl: string | null;
}
// Cria uma cobrança (billingType UNDEFINED = o próprio Asaas oferece Pix/cartão/boleto na fatura
// hospedada por eles, sem precisarmos lidar com dados de cartão no nosso servidor).
export async function criarCobranca(params: { customerId: string; valor: number; vencimento: string; descricao: string }): Promise<CobrancaAsaas> {
  const r = await chamarAsaas("POST", "/payments", {
    customer: params.customerId,
    billingType: "UNDEFINED",
    value: params.valor,
    dueDate: params.vencimento,
    description: params.descricao,
  });
  if (!r.ok) throw new Error(`Não consegui gerar a cobrança no Asaas: ${mensagemErroAsaas(r)}`);
  return { id: r.corpo.id, status: r.corpo.status, invoiceUrl: r.corpo.invoiceUrl || null };
}

export interface PixQrCode {
  payload: string; // código copia-e-cola
  imagemBase64: string; // PNG em base64, pronto pra <img src="data:image/png;base64,...">
}
export async function obterQrCodePix(paymentId: string): Promise<PixQrCode> {
  const r = await chamarAsaas("GET", `/payments/${paymentId}/pixQrCode`);
  if (!r.ok) throw new Error(`Não consegui obter o QR code Pix: ${mensagemErroAsaas(r)}`);
  return { payload: r.corpo.payload, imagemBase64: r.corpo.encodedImage };
}

export async function consultarCobranca(paymentId: string): Promise<{ status: string }> {
  const r = await chamarAsaas("GET", `/payments/${paymentId}`);
  if (!r.ok) throw new Error(`Não consegui consultar a cobrança no Asaas: ${mensagemErroAsaas(r)}`);
  return { status: r.corpo.status };
}
