// Proposta comercial da PLATAFORMA inteira para outro escritório contábil (Contratos › Propostas, tipo
// "Escritório contábil"). Preço = mensalidade base da plataforma + módulos do catálogo de escritório
// (modulos_escritorio_catalogo, com valor editável na proposta) + assento por colaborador; desconto e
// implantação editáveis. A economia vem de premissas editáveis (horas poupadas por cliente/mês, custo
// do colaborador, sistemas substituídos e receita de revenda de módulos aos clientes do escritório).
// PDF no papel timbrado, mesmo visual da proposta de Reforma (src/propostas.ts).

export interface ModuloProposta { chave: string; nome: string; valor: number; incluido: boolean; descontoPct: number; isento: boolean }
// Cada cobrança (base, módulo, usuários, implantação) tem desconto próprio (%) e pode ser isenta; o
// desconto geral (descontoPct) entra por cima do subtotal já com os descontos de cada item.
export interface ConfigEscritorio {
  escritorio: { nome: string; cnpj: string; cidade: string; uf: string; responsavel: string; cpfResponsavel: string; email: string; telefone: string };
  clientes: number; colaboradores: number;
  baseMensal: number; baseDescontoPct: number; baseIsento: boolean;
  assentoValor: number; assentoDescontoPct: number; assentoIsento: boolean; modulos: ModuloProposta[];
  descontoPct: number; implantacao: number; implantacaoDescontoPct: number; implantacaoIsenta: boolean; implantacaoParcelas: number; validadeDias: number; observacoes: string;
  salarioColaborador: number; horasPorCliente: number; gastoSistemasAtual: number; adesaoRevendaPct: number; ticketRevenda: number;
}

export const BASE_MENSAL_PADRAO = 990;
export const SALARIO_COLABORADOR_PADRAO = 2800;
export const FATOR_ENCARGOS = 1.625, BENEFICIOS = 600, HORAS_MES = 176;
// Horas poupadas por cliente/mês: a base (obrigações, envio, solicitações, Integra Contador…) e cada
// módulo opcional somam a sua parte. É premissa — sai explicada no PDF e é editável na proposta.
const HORAS_BASE = 1;
const HORAS_MODULO: Record<string, number> = { busca_xml_nfe: 0.6, envio_whatsapp: 0.3, envio_email_automatico: 0.2, atendimento_whatsapp: 0.3, nfse_automatico: 0.2, reforma: 0.3 };
export const PRECO_REFORMA_PADRAO = 690;

// O que vai na base da plataforma (sempre incluso) — texto do PDF e do contrato.
export const FUNCIONALIDADES_BASE: { titulo: string; texto: string }[] = [
  { titulo: "Painel do escritório e Painel de TV", texto: "Visão do dia: pendências, vencimentos, filas de atendimento e indicadores da equipe, inclusive em tela cheia na TV do escritório." },
  { titulo: "Empresas e portal do cliente", texto: "Cadastro completo dos clientes, com contatos, regime, CNAEs e documentos. O cliente tem acesso próprio para consultar e baixar o que é dele." },
  { titulo: "Obrigações do mês por setor", texto: "Quadros do Fiscal, DP/RH e Contabilidade com cada obrigação de cada empresa: o que foi feito, transmitido e enviado, com prazos e responsáveis." },
  { titulo: "Solicitação e envio de documentos", texto: "Pede documentos ao cliente e envia guias e relatórios com protocolo de entrega, sem procurar arquivo em pasta nem anexar à mão." },
  { titulo: "Integra Contador (SERPRO)", texto: "DAS, parcelamentos, caixa postal do e-CAC e mensagens do Regularize monitorados automaticamente para todas as empresas." },
  { titulo: "Certificados digitais e licenças", texto: "Controle de vencimento dos certificados e das licenças e alvarás, com aviso antes de vencer." },
  { titulo: "Contratos com assinatura eletrônica", texto: "Modelos próprios, contrato, aditivo e distrato gerados com os dados da empresa e enviados para assinatura eletrônica." },
  { titulo: "Financeiro e cobrança de honorários", texto: "Honorários, cobranças por Pix/boleto/cartão e acompanhamento de inadimplência." },
  { titulo: "DP/RH", texto: "Programação de férias, controle de vencidas e rotinas de FGTS Digital." },
  { titulo: "Contabilidade e conciliação bancária", texto: "Rotinas contábeis e conciliação dos extratos (Open Finance/OFX)." },
  { titulo: "Relatórios, usuários e permissões", texto: "Relatórios gerenciais, controle de acesso por módulo e por empresa, e registro de quem fez o quê." },
];
export const DESCRICAO_MODULO: Record<string, string> = {
  busca_xml_nfe: "Captura automática de NF-e, NFC-e, NFS-e e CT-e de todos os clientes, pronta para importar na escrita fiscal.",
  envio_email_automatico: "Guias e documentos enviados sozinhos por e-mail ao cliente, com registro de entrega.",
  envio_whatsapp: "Guias e documentos enviados sozinhos por WhatsApp, com trava contra reenvio e confirmação de entrega.",
  atendimento_whatsapp: "CRM de atendimento pelo WhatsApp do escritório: filas por setor, robô de triagem, histórico e indicadores.",
  nfse_automatico: "Emissão automática das NFS-e recorrentes dos clientes no Sistema Nacional NFS-e.",
  reforma: "Auditoria do IBS/CBS nas notas de entrada e saída dos clientes, notificação aos fornecedores e diagnóstico do melhor regime pós-reforma.",
};

const r2 = (v: number) => Math.round(v * 100) / 100;

// Funcionalidades do sistema (menu do escritório) que também podem entrar na proposta, item a item.
// Chave "func:<modulo>" — nascem DESMARCADAS e sem preço; marcada, a funcionalidade é liberada pro
// escritório quando o acesso é criado (escritorio_funcionalidades). Fora: os essenciais (sempre ligados),
// a Reforma (já é módulo do catálogo) e o IRPF Rural (desligado).
export const FUNCIONALIDADES_PROPOSTA: { modulo: string; nome: string; descricao: string }[] = [
  { modulo: "solicitacoes", nome: "Solicitações de Documentos", descricao: "Pedido de documentos aos clientes com prazo, lembrete e recebimento pelo portal." },
  { modulo: "envio", nome: "Envio de Documentos (central, envio manual)", descricao: "Central de envio de guias e documentos aos clientes, com protocolo de entrega. Já vem junto com os envios automáticos por e-mail/WhatsApp." },
  { modulo: "nfse", nome: "NFS-e (emissão manual)", descricao: "Emissão avulsa de NFS-e no Sistema Nacional pelo escritório e pelos clientes. Já vem junto com a Emissão automática de NFS-e." },
  { modulo: "open_finance", nome: "Conciliação Bancária", descricao: "Extratos bancários dos clientes via Open Finance/OFX para conciliação." },
  { modulo: "integracontador", nome: "Integra Contador", descricao: "Integração com a Receita Federal: DAS, PGDAS-D, situação fiscal e caixas postais." },
  { modulo: "webdfe", nome: "Emissor NF-e", descricao: "Emissão de NF-e pelo próprio sistema." },
  { modulo: "licencas", nome: "Licenças", descricao: "Controle de vencimento de licenças e alvarás dos clientes." },
  { modulo: "certificados", nome: "Certificados", descricao: "Controle dos certificados digitais dos clientes e alerta de vencimento." },
  { modulo: "financeiro", nome: "Financeiro", descricao: "Contas a pagar e a receber, honorários e cobrança do escritório." },
  { modulo: "contratos", nome: "Contratos", descricao: "Propostas, contratos e assinatura eletrônica." },
  { modulo: "relatorios", nome: "Relatórios", descricao: "Relatórios gerenciais e fiscais dos clientes." },
  { modulo: "dprh", nome: "DP/RH", descricao: "Rotinas de departamento pessoal: folha, férias e obrigações." },
  { modulo: "contabil", nome: "Contabilidade", descricao: "Rotinas contábeis e fechamento dos clientes." },
  { modulo: "fiscal", nome: "Fiscal", descricao: "Rotinas fiscais, apurações e fechamento fiscal dos clientes." },
  { modulo: "email", nome: "E-mail", descricao: "Caixa de e-mail integrada e importação automática de documentos." },
  { modulo: "obrigacoes", nome: "Obrigações do Mês", descricao: "Quadro de obrigações por empresa e competência, com prazo e responsável." },
];
export const ehFuncionalidade = (chave: string) => chave.startsWith("func:");
// Página do sistema que cada módulo pago precisa pra funcionar — liberada junto quando o módulo entra
// na proposta (por isso "Busca de XML" e "CRM" não aparecem como item separado: seriam cobrança dupla).
export const PAGINAS_DO_MODULO: Record<string, string[]> = {
  busca_xml_nfe: ["nfe-busca"],
  atendimento_whatsapp: ["crm"],
  nfse_automatico: ["nfse"],
  envio_email_automatico: ["envio"],
  envio_whatsapp: ["envio"],
  reforma: ["reforma"],
};

export function catalogoParaModulos(catalogo: { chave: string; nome: string; valor_mensal: number; ativo: number }[]): { modulos: ModuloProposta[]; assentoValor: number; baseMensal: number } {
  const assento = catalogo.find((m) => m.chave === "assento_colaborador");
  const base = catalogo.find((m) => m.chave === "plataforma_base");
  const modulos = catalogo
    .filter((m) => m.chave !== "assento_colaborador" && m.chave !== "plataforma_base" && (m.ativo || m.chave === "reforma"))
    .map((m) => ({ chave: m.chave, nome: m.nome, valor: m.chave === "reforma" && !m.valor_mensal ? PRECO_REFORMA_PADRAO : r2(m.valor_mensal || 0), incluido: true, descontoPct: 0, isento: false }));
  for (const f of FUNCIONALIDADES_PROPOSTA) modulos.push({ chave: "func:" + f.modulo, nome: f.nome, valor: 0, incluido: false, descontoPct: 0, isento: false });
  return { modulos, assentoValor: r2(assento?.valor_mensal || 0), baseMensal: r2(base?.valor_mensal || BASE_MENSAL_PADRAO) };
}
export function horasSugeridas(modulos: ModuloProposta[]) {
  return r2(HORAS_BASE + modulos.filter((m) => m.incluido).reduce((a, m) => a + (HORAS_MODULO[m.chave] || 0), 0));
}
export function implantacaoSugerida(clientes: number) {
  return Math.round((1500 + 10 * Math.max(0, clientes)) / 50) * 50;
}
export function configPadrao(catalogo: any[], ticketRevenda: number): ConfigEscritorio {
  const { modulos, assentoValor, baseMensal } = catalogoParaModulos(catalogo);
  return {
    escritorio: { nome: "", cnpj: "", cidade: "", uf: "", responsavel: "", cpfResponsavel: "", email: "", telefone: "" },
    clientes: 100, colaboradores: 5, baseMensal, baseDescontoPct: 0, baseIsento: false, assentoValor, assentoDescontoPct: 0, assentoIsento: false, modulos,
    descontoPct: 0, implantacao: implantacaoSugerida(100), implantacaoDescontoPct: 0, implantacaoIsenta: false, implantacaoParcelas: 1, validadeDias: 30, observacoes: "",
    salarioColaborador: SALARIO_COLABORADOR_PADRAO, horasPorCliente: horasSugeridas(modulos), gastoSistemasAtual: 0, adesaoRevendaPct: 10, ticketRevenda: r2(ticketRevenda || 49.99),
  };
}
export function normalizarConfig(c: any, base: ConfigEscritorio): ConfigEscritorio {
  const n = (v: any, d: number, min = 0, max = 1e9) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d; };
  const s = (v: any, d: string, max = 200) => (v === undefined || v === null ? d : String(v).trim().slice(0, max));
  const e = c?.escritorio || {};
  const modsBase = new Map(base.modulos.map((m) => [m.chave, m]));
  const modulos = Array.isArray(c?.modulos)
    ? c.modulos.filter((m: any) => modsBase.has(String(m?.chave))).map((m: any) => { const b = modsBase.get(String(m.chave))!; return { chave: b.chave, nome: b.nome, valor: r2(n(m.valor, b.valor)), incluido: !!m.incluido, descontoPct: r2(n(m.descontoPct, b.descontoPct || 0, 0, 100)), isento: m.isento !== undefined ? !!m.isento : !!b.isento }; })
    : base.modulos;
  for (const m of base.modulos) if (!modulos.some((x: ModuloProposta) => x.chave === m.chave)) modulos.push(m);
  return {
    escritorio: {
      nome: s(e.nome, base.escritorio.nome, 150), cnpj: s(e.cnpj, base.escritorio.cnpj, 20).replace(/\D/g, ""), cidade: s(e.cidade, base.escritorio.cidade, 80), uf: s(e.uf, base.escritorio.uf, 2).toUpperCase(),
      responsavel: s(e.responsavel, base.escritorio.responsavel, 120), cpfResponsavel: s(e.cpfResponsavel, base.escritorio.cpfResponsavel, 14).replace(/\D/g, ""),
      email: s(e.email, base.escritorio.email, 150), telefone: s(e.telefone, base.escritorio.telefone, 30),
    },
    clientes: Math.round(n(c?.clientes, base.clientes, 0, 100000)), colaboradores: Math.round(n(c?.colaboradores, base.colaboradores, 0, 10000)),
    baseMensal: r2(n(c?.baseMensal, base.baseMensal)), baseDescontoPct: r2(n(c?.baseDescontoPct, base.baseDescontoPct || 0, 0, 100)), baseIsento: c?.baseIsento !== undefined ? !!c.baseIsento : !!base.baseIsento,
    assentoValor: r2(n(c?.assentoValor, base.assentoValor)), assentoDescontoPct: r2(n(c?.assentoDescontoPct, base.assentoDescontoPct || 0, 0, 100)), assentoIsento: c?.assentoIsento !== undefined ? !!c.assentoIsento : !!base.assentoIsento, modulos,
    descontoPct: r2(n(c?.descontoPct, base.descontoPct, 0, 100)), implantacao: r2(n(c?.implantacao, base.implantacao)),
    implantacaoDescontoPct: r2(n(c?.implantacaoDescontoPct, base.implantacaoDescontoPct || 0, 0, 100)), implantacaoIsenta: c?.implantacaoIsenta !== undefined ? !!c.implantacaoIsenta : !!base.implantacaoIsenta,
    implantacaoParcelas: Math.round(n(c?.implantacaoParcelas, base.implantacaoParcelas || 1, 1, 48)),
    validadeDias: Math.round(n(c?.validadeDias, base.validadeDias, 1, 365)), observacoes: s(c?.observacoes, base.observacoes, 2000),
    salarioColaborador: r2(n(c?.salarioColaborador, base.salarioColaborador)), horasPorCliente: r2(n(c?.horasPorCliente, base.horasPorCliente, 0, 100)),
    gastoSistemasAtual: r2(n(c?.gastoSistemasAtual, base.gastoSistemasAtual)), adesaoRevendaPct: r2(n(c?.adesaoRevendaPct, base.adesaoRevendaPct, 0, 100)), ticketRevenda: r2(n(c?.ticketRevenda, base.ticketRevenda)),
  };
}
// Itens cobrados por mês, cada um com valor de tabela, desconto próprio e valor final (isento = 0).
export function itensCobranca(c: ConfigEscritorio) {
  const item = (chave: string, nome: string, tabela: number, descontoPct: number, isento: boolean) => ({ chave, nome, tabela: r2(tabela), descontoPct, isento, final: isento ? 0 : r2(tabela * (1 - descontoPct / 100)) });
  const itens = [
    item("plataforma_base", "Plataforma base: todos os itens do item 1", c.baseMensal, c.baseDescontoPct, c.baseIsento),
    ...c.modulos.filter((m) => m.incluido).map((m) => item(m.chave, m.nome, m.valor, m.descontoPct, m.isento)),
  ];
  if (c.colaboradores > 0 && c.assentoValor > 0) itens.push(item("assento_colaborador", `Usuários da equipe: ${c.colaboradores} × ${brl(c.assentoValor)}`, c.assentoValor * c.colaboradores, c.assentoDescontoPct, c.assentoIsento));
  return itens;
}
// Mesma conta da tela (app.html › propEscCalcular) — manter as duas iguais.
export function calcularValores(c: ConfigEscritorio) {
  const itens = itensCobranca(c);
  const mensalBruto = r2(itens.reduce((a, i) => a + i.tabela, 0));
  const subtotal = r2(itens.reduce((a, i) => a + i.final, 0));
  const descontoItens = r2(mensalBruto - subtotal);
  const descontoGeral = r2((subtotal * c.descontoPct) / 100);
  const descontoValor = r2(descontoItens + descontoGeral);
  const mensal = r2(subtotal - descontoGeral);
  const implantacaoFinal = c.implantacaoIsenta ? 0 : r2(c.implantacao * (1 - c.implantacaoDescontoPct / 100));
  const custoHora = (c.salarioColaborador * FATOR_ENCARGOS + BENEFICIOS) / HORAS_MES;
  const horasMes = Math.round(c.horasPorCliente * c.clientes);
  const economiaEquipe = Math.round(horasMes * custoHora * 12);
  const colaboradoresLiberados = Math.round((horasMes / HORAS_MES) * 10) / 10;
  const economiaSistemas = Math.round(c.gastoSistemasAtual * 12);
  const receitaRevenda = Math.round(c.clientes * (c.adesaoRevendaPct / 100) * c.ticketRevenda * 12);
  const ganho = economiaEquipe + economiaSistemas + receitaRevenda;
  const investimentoAno1 = r2(mensal * 12 + implantacaoFinal);
  const liquido = Math.round(ganho - investimentoAno1);
  const roi = investimentoAno1 > 0 ? Math.round((ganho / investimentoAno1) * 10) / 10 : 0;
  const paybackMeses = ganho > 0 ? Math.round((investimentoAno1 / (ganho / 12)) * 10) / 10 : null;
  const custoPorCliente = c.clientes ? r2(mensal / c.clientes) : 0;
  return { itens, mensalBruto, subtotal, descontoItens, descontoGeral, descontoValor, mensal, implantacaoFinal, custoHora: r2(custoHora), horasMes, economiaEquipe, colaboradoresLiberados, economiaSistemas, receitaRevenda, ganho, investimentoAno1, liquido, roi, paybackMeses, custoPorCliente };
}
// Preço mensal efetivo de cada item na plataforma (desconto do item + desconto geral); isento = cortesia.
export function precoEfetivoItens(c: ConfigEscritorio) {
  const g = 1 - c.descontoPct / 100;
  return itensCobranca(c).map((i) => ({ chave: i.chave, isento: i.isento, mensal: i.isento ? 0 : r2(i.final * g), unitarioAssento: i.chave === "assento_colaborador" ? (i.isento ? 0 : r2(c.assentoValor * (1 - i.descontoPct / 100) * g)) : null }));
}

function esc(s: any) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
export function fmtDoc(c: string) {
  const d = String(c || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  return c;
}
const brl = (v: number) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const brl0 = (v: number) => "R$ " + Math.round(Number(v || 0)).toLocaleString("pt-BR");
const num = (v: number) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
const dataBR = (iso: string) => iso.slice(0, 10).split("-").reverse().join("/");

// Parcelamento da implantação em N parcelas iguais; a última ajusta o centavo da divisão.
export function parcelasImplantacao(total: number, parcelas: number) {
  const n = Math.max(1, Math.round(parcelas || 1));
  if (n <= 1 || total <= 0) return { n: 1, valor: r2(total), ultima: r2(total), uniforme: true };
  const base = Math.floor((total * 100) / n) / 100;
  const ultima = r2(total - base * (n - 1));
  return { n, valor: r2(base), ultima, uniforme: Math.abs(base - ultima) < 0.005 };
}
export function parcelasTexto(total: number, parcelas: number) {
  const p = parcelasImplantacao(total, parcelas);
  if (p.n <= 1) return "";
  return p.uniforme ? `${p.n}× de ${brl(p.valor)}` : `${p.n}×: ${p.n - 1}× de ${brl(p.valor)} e 1× de ${brl(p.ultima)}`;
}

export function htmlPropostaEscritorio(c: ConfigEscritorio, meta: { numero: string; data: string }, timbrado: string | null) {
  const v = calcularValores(c);
  const e = c.escritorio;
  const inclusos = c.modulos.filter((m) => m.incluido), fora = c.modulos.filter((m) => !m.incluido && !ehFuncionalidade(m.chave));
  const validade = (() => { const d = new Date(meta.data + "T12:00:00"); d.setDate(d.getDate() + c.validadeDias); return d.toISOString().slice(0, 10); })();
  const ganhos = [
    v.economiaEquipe ? { t: "Horas da equipe devolvidas ao escritório", x: `Cerca de <b>${num(v.horasMes)} horas por mês</b> deixam de ir para tarefa repetitiva (${num(c.horasPorCliente)} h por cliente × ${num(c.clientes)} clientes). Isso equivale a <b>${num(v.colaboradoresLiberados)} colaborador(es)</b> em tempo integral, que podem atender mais clientes sem novas contratações.`, val: brl0(v.economiaEquipe), rot: "por ano", q: true } : null,
    v.economiaSistemas ? { t: "Sistemas que deixam de ser pagos", x: `A plataforma substitui ferramentas que hoje custam ${brl(c.gastoSistemasAtual)} por mês ao escritório.`, val: brl0(v.economiaSistemas), rot: "por ano", q: true } : null,
    v.receitaRevenda ? { t: "Nova receita: revenda de módulos aos clientes", x: `O escritório pode oferecer aos próprios clientes módulos como emissão de NFS-e, financeiro e auditoria da Reforma, com cobrança automática pela plataforma. Com ${num(c.adesaoRevendaPct)}% de adesão a ${brl(c.ticketRevenda)}/mês, a receita é de <b>${brl0(v.receitaRevenda / 12)} por mês</b>.`, val: brl0(v.receitaRevenda), rot: "por ano", q: true } : null,
    { t: "Menos multa por obrigação perdida", x: "Cada obrigação de cada empresa fica num quadro com prazo e responsável. O que está atrasado aparece antes de virar multa paga pelo escritório.", val: "multa evitada", rot: "por prazo controlado", q: false },
    { t: "Cliente melhor atendido, menos cancelamento", x: "Documento enviado na hora e com protocolo, portal do cliente e atendimento pelo WhatsApp com fila e histórico. Cliente bem atendido não troca de contador.", val: "retenção", rot: "da carteira", q: false },
    { t: "Escritório preparado para a Reforma Tributária", x: "Auditoria do IBS/CBS e diagnóstico de regime prontos para oferecer aos clientes, em vez de montar planilha caso a caso.", val: "novo serviço", rot: "consultivo", q: false },
    { t: "Processo que não depende de uma pessoa", x: "Rotina registrada no sistema, com permissões e histórico. Férias e troca de colaborador deixam de parar o setor.", val: "continuidade", rot: "da operação", q: false },
  ].filter(Boolean) as any[];
  const corpo = `
<span class="capa-tag">Proposta comercial nº ${esc(meta.numero)} · Confidencial</span>
<h1>Plataforma Simples Contábeis para o seu escritório</h1>
<p class="sub"><b>${esc(e.nome || "Escritório contábil")}</b>${e.cnpj ? ` · CNPJ ${fmtDoc(e.cnpj)}` : ""}${e.cidade ? ` · ${esc(e.cidade)}${e.uf ? "-" + esc(e.uf) : ""}` : ""}${e.responsavel ? `<br>A/C ${esc(e.responsavel)}` : ""}<br>
Simples Contábeis · Redenção/PA, ${dataBR(meta.data)} · Proposta válida até ${dataBR(validade)}</p>

<p class="txt">A Simples Contábeis é um escritório contábil que construiu a própria plataforma para resolver o dia a dia do escritório: obrigações de cada cliente, documentos, guias, atendimento, notas fiscais, contratos e cobrança, tudo num lugar só e com robôs fazendo o trabalho repetitivo. Esta proposta leva a mesma plataforma que usamos todos os dias para o <b>${esc(e.nome || "seu escritório")}</b>.</p>

<div class="hero">
  <div class="rot">Ganho estimado para ${esc(e.nome || "o escritório")}</div>
  <div class="big">${brl0(v.ganho)} <small>por ano</small></div>
  <div class="txt">${[v.economiaEquipe ? `${brl0(v.economiaEquipe)} em horas da equipe` : "", v.economiaSistemas ? `${brl0(v.economiaSistemas)} em sistemas substituídos` : "", v.receitaRevenda ? `${brl0(v.receitaRevenda)} de receita nova com revenda de módulos` : ""].filter(Boolean).join(" + ") || "Ganhos qualitativos descritos no item 3"}.<br>
  <b style="color:#e9d48a;">Investimento no 1º ano: ${brl0(v.investimentoAno1)}${v.roi ? ` · retorno de cerca de ${num(v.roi)} vezes` : ""}${v.paybackMeses != null ? ` · se paga em ${v.paybackMeses <= 1 ? "menos de 1 mês" : `cerca de ${Math.ceil(v.paybackMeses)} meses`}` : ""}.</b></div>
</div>

<div class="kpis">
  <div class="kpi"><div class="r">Clientes atendidos</div><div class="v">${num(c.clientes)}</div><div class="d">empresas na carteira · ${num(c.colaboradores)} colaborador(es)</div></div>
  <div class="kpi"><div class="r">Horas devolvidas à equipe</div><div class="v">${num(v.horasMes)} h/mês</div><div class="d">≈ ${num(v.colaboradoresLiberados)} colaborador(es) em tempo integral</div></div>
  <div class="kpi"><div class="r">Custo por cliente</div><div class="v">${brl(v.custoPorCliente)}</div><div class="d">por mês, com todos os módulos da proposta</div></div>
</div>

<h2>1. O que vem na plataforma (incluso na mensalidade base)</h2>
<table class="t"><tbody>${FUNCIONALIDADES_BASE.map((f) => `<tr><td style="width:32%"><b>${esc(f.titulo)}</b></td><td>${esc(f.texto)}</td></tr>`).join("")}</tbody></table>

<h2>2. Módulos de automação desta proposta</h2>
${inclusos.length ? `<table class="t"><thead><tr><th style="width:32%">Módulo</th><th>O que faz</th><th class="num" style="width:16%">Mensalidade</th></tr></thead><tbody>${inclusos.map((m) => `<tr><td><b>${esc(m.nome)}</b></td><td>${esc(DESCRICAO_MODULO[m.chave] || FUNCIONALIDADES_PROPOSTA.find((f) => "func:" + f.modulo === m.chave)?.descricao || "")}</td><td class="num">${brl(m.valor)}</td></tr>`).join("")}</tbody></table>` : `<p class="txt">Nenhum módulo opcional nesta proposta: só a plataforma base.</p>`}
${fora.length ? `<p class="small">Podem ser contratados depois, a qualquer momento: ${fora.map((m) => `${esc(m.nome)} (${brl(m.valor)}/mês)`).join("; ")}.</p>` : ""}

<h2>3. Onde o escritório ganha</h2>
${ganhos.map((g: any, i: number) => `<div class="eco${g.q ? "" : " q"}"><div class="n">${i + 1}</div><div><div class="t">${g.t}</div><div class="x">${g.x}</div></div><div class="val">${g.val}<small>${g.rot}</small></div></div>`).join("")}

<h2>4. Investimento</h2>
<div class="preco"><table>
  <tr class="cab"><td><b>Item</b></td><td class="num"><b>Tabela</b></td><td class="num"><b>Desconto</b></td><td class="num"><b>Valor</b></td></tr>
  ${v.itens.map((i) => `<tr><td>${esc(i.nome)}</td><td class="num">${brl(i.tabela)}</td><td class="num ok">${i.isento ? "isento" : i.descontoPct ? `${String(i.descontoPct).replace(".", ",")}%` : "—"}</td><td class="num">${i.isento ? "<b>isento</b>" : brl(i.final)}</td></tr>`).join("")}
  ${v.descontoGeral ? `<tr><td colspan="3">Subtotal</td><td class="num">${brl(v.subtotal)}</td></tr><tr><td colspan="3"><b>Desconto especial (${String(c.descontoPct).replace(".", ",")}%)</b></td><td class="num ok">− ${brl(v.descontoGeral)}</td></tr>` : ""}
  <tr class="total"><td colspan="3">Mensalidade${v.descontoValor ? ` <span style="font-size:9px; font-weight:600; color:#1f6e43;">(economia de ${brl(v.descontoValor)}/mês sobre a tabela de ${brl(v.mensalBruto)})</span>` : ""}</td><td class="num">${brl(v.mensal)}/mês</td></tr>
  <tr><td>Implantação, cobrada uma vez: configuração do escritório, importação das empresas e contatos, configuração dos robôs e dos envios, e treinamento da equipe${c.implantacaoParcelas > 1 && v.implantacaoFinal ? ` <b>— parcelada em ${parcelasTexto(v.implantacaoFinal, c.implantacaoParcelas)}</b>` : ""}</td><td class="num">${brl(c.implantacao)}</td><td class="num ok">${c.implantacaoIsenta ? "isenta" : c.implantacaoDescontoPct ? `${String(c.implantacaoDescontoPct).replace(".", ",")}%` : "—"}</td><td class="num">${v.implantacaoFinal ? brl(v.implantacaoFinal) : "<b>isenta</b>"}</td></tr>
</table></div>
<table class="t" style="break-inside:avoid">
  <thead><tr><th>Retorno no 1º ano</th><th class="num" style="width:24%">Valor</th></tr></thead>
  <tbody>
    <tr><td>Ganho estimado: horas da equipe${v.economiaSistemas ? " + sistemas substituídos" : ""}${v.receitaRevenda ? " + revenda de módulos" : ""}</td><td class="num ok">${brl0(v.ganho)}</td></tr>
    <tr><td>Investimento: ${v.implantacaoFinal ? "implantação + " : ""}12 mensalidades</td><td class="num no">− ${brl0(v.investimentoAno1)}</td></tr>
    <tr class="tot"><td>Resultado estimado no 1º ano</td><td class="num">${brl0(v.liquido)}</td></tr>
    <tr><td>Retorno sobre o investimento</td><td class="num"><b>≈ ${num(v.roi)} vezes</b></td></tr>
    ${v.paybackMeses != null ? `<tr><td>Prazo para se pagar</td><td class="num"><b>${v.paybackMeses <= 1 ? "menos de 1 mês" : `cerca de ${Math.ceil(v.paybackMeses)} meses`}</b></td></tr>` : ""}
  </tbody>
</table>
${c.observacoes ? `<div class="destaque"><b>Condições:</b> ${esc(c.observacoes).replace(/\n/g, "<br>")}</div>` : ""}

<h2>5. Implantação</h2>
<div class="fluxo2">
  <div><b>1. Cadastro</b>Escritório, usuários, permissões e papel timbrado.</div>
  <div><b>2. Carteira</b>Importação das empresas, contatos e certificados.</div>
  <div><b>3. Robôs</b>Integra Contador, busca de XML e envios automáticos ligados.</div>
  <div><b>4. Treinamento</b>Equipe treinada por setor, de forma remota.</div>
  <div><b>5. Acompanhamento</b>Primeiro fechamento do mês feito junto com a equipe.</div>
</div>
<div class="alerta"><b>Sem fidelidade:</b> contrato mês a mês, cancelável a qualquer tempo sem multa. Os dados são do escritório e podem ser exportados quando quiser. Hospedagem, atualizações, backup diário e suporte em dias úteis estão inclusos.</div>

<h2>6. Premissas e ressalvas</h2>
<div class="rodape-nota">
<b>Horas da equipe:</b> ${num(c.horasPorCliente)} hora(s) poupada(s) por cliente por mês com os módulos desta proposta (busca e organização de XML, envio de guias e documentos, controle de obrigações, consultas no e-CAC, atendimento), ao custo de ${brl(v.custoHora)} por hora: salário de ${brl(c.salarioColaborador)} com encargos e benefícios, 176 horas por mês.${v.economiaSistemas ? ` <b>Sistemas substituídos:</b> ${brl(c.gastoSistemasAtual)} por mês, informado pelo escritório.` : ""}${v.receitaRevenda ? ` <b>Revenda:</b> ${num(c.adesaoRevendaPct)}% dos clientes contratando um módulo de ${brl(c.ticketRevenda)} por mês.` : ""}<br>
Os valores são estimativas para apoiar a decisão e dependem da rotina e da adesão de cada escritório. Não constituem garantia de resultado. Mensalidade reajustada anualmente pelo IPCA. Eventuais custos cobrados diretamente por terceiros (certificados digitais, tarifas de provedores de mensagens ou serviços governamentais pagos por consumo) não integram a mensalidade.
</div>
<div class="aceite">
<h2>7. Aceite da proposta</h2>
<p>Declaro que li esta proposta e <b>aceito as condições comerciais nela descritas</b>, autorizando a Simples Contábeis a emitir o contrato correspondente para assinatura.</p>
<div class="data">Local e data: ____________________________, ____/____/________</div>
<div class="cols">
  <div class="ass"><div class="linha"></div><b>Simples Contábeis</b><br>SIMPLES SERVIÇOS DE CONTABILIDADE, PERÍCIA E AUDITORIA CONTABIL LTDA<br>CNPJ 04.801.040/0001-93<br>Proponente</div>
  <div class="ass"><div class="linha"></div><b>${esc(e.nome || "Escritório contábil")}</b><br>${e.cnpj ? `CNPJ ${fmtDoc(e.cnpj)}` : "CNPJ: ______________________"}<br>${e.responsavel ? esc(e.responsavel) : "Representante: _________________________________"}<br>${e.cpfResponsavel ? `CPF ${fmtDoc(e.cpfResponsavel)}` : "CPF: ______________________"}<br>De acordo (cliente)</div>
</div>
</div>`;
  const bg = timbrado ? `<img class="bg" src="${timbrado}">` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>Proposta ${esc(meta.numero)}</title><style>
@page { size: A4; margin: ${timbrado ? "0" : "16mm 14mm"}; }
html, body { margin: 0; padding: 0; }
body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #2f3b42; font-size: 10px; line-height: 1.45; }
.bg { position: fixed; top: 0; left: 0; width: 210mm; height: 297mm; z-index: -1; }
table.layout { width: ${timbrado ? "210mm" : "100%"}; border-collapse: collapse; }
table.layout > thead td, table.layout > tfoot td, table.layout > tbody > tr > td.corpo { border: none; padding: 0; }
.espaco-topo { height: ${timbrado ? "48mm" : "0"}; } .espaco-rodape { height: ${timbrado ? "44mm" : "0"}; }
td.corpo { padding: 0 ${timbrado ? "20mm" : "0"} !important; vertical-align: top; }
h1 { font-size: 16px; margin: 0 0 3px; color: #2f3b42; }
h2 { font-size: 12.5px; margin: 16px 0 6px; color: #2f3b42; break-after: avoid; padding-bottom: 3px; border-bottom: 1.6px solid #c9a227; }
.sub { font-size: 9.6px; color: #6b7880; margin: 0 0 12px; padding-bottom: 8px; border-bottom: 2.5px solid #c9a227; text-align: justify; }
p.txt { margin: 6px 0 8px; text-align: justify; } p.small { font-size: 9.2px; color: #52616a; text-align: justify; }
table.t { width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 9px; background: rgba(255,255,255,.94); margin: 6px 0 10px; }
table.t th { text-align: left; background: #2f3b42; color: #fff; padding: 5px 6px; border: 1px solid #2f3b42; font-size: 8px; text-transform: uppercase; letter-spacing: .04em; }
table.t td { padding: 5px 6px; border: 1px solid #dde3e6; vertical-align: top; word-wrap: break-word; }
table.t tr { break-inside: avoid; } table.t thead { display: table-header-group; }
tr.tot td { background: #f3eed9; font-weight: 700; } .num { text-align: right; white-space: nowrap; }
.alerta { background: #fdf6e3; border: 1px solid #c9a227; border-left: 4px solid #c9a227; padding: 9px 11px; margin: 12px 0; font-size: 9.4px; text-align: justify; break-inside: avoid; }
.destaque { background: #f0f4f6; border-left: 4px solid #2f3b42; padding: 9px 11px; margin: 10px 0; font-size: 9.4px; break-inside: avoid; }
.rodape-nota { margin-top: 10px; padding: 9px 11px; background: #f7f8f9; border: 1px solid #e2e7ea; font-size: 8.4px; color: #52616a; text-align: justify; break-inside: avoid; }
.aceite { margin-top: 18px; break-inside: avoid; } .aceite p { text-align: justify; margin: 4px 0 6px; }
.aceite .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14mm; margin-top: 22px; }
.aceite .ass { text-align: center; font-size: 9.2px; line-height: 1.5; } .aceite .ass .linha { border-top: 1px solid #2f3b42; margin: 0 4mm 5px; }
.aceite .data { margin-top: 10px; font-size: 9.4px; }
.assin { margin-top: 26px; text-align: center; font-size: 9.4px; break-inside: avoid; } .assin .linha { width: 62mm; border-top: 1px solid #2f3b42; margin: 0 auto 5px; }
.capa-tag { display:inline-block; font-size:8.4px; letter-spacing:.14em; text-transform:uppercase; color:#6b5410; background:#f3eed9; border:1px solid #c9a227; padding:2px 8px; margin-bottom:6px; }
.hero { background:#2f3b42; color:#fff; padding:14px 16px; margin:12px 0 10px; break-inside:avoid; border-bottom:4px solid #c9a227; }
.hero .rot { font-size:8.6px; letter-spacing:.12em; text-transform:uppercase; color:#e9d48a; }
.hero .big { font-size:30px; font-weight:800; margin:2px 0; } .hero .big small { font-size:13px; font-weight:600; color:#e9d48a; } .hero .txt { font-size:9.6px; color:#dfe5e8; }
.kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:7px; margin:8px 0 10px; break-inside:avoid; }
.kpi { border:1px solid #dde3e6; border-top:3px solid #c9a227; background:rgba(255,255,255,.95); padding:7px 9px; }
.kpi .r { font-size:7.6px; letter-spacing:.08em; text-transform:uppercase; color:#6b7880; } .kpi .v { font-size:16px; font-weight:800; margin:2px 0 1px; } .kpi .d { font-size:8.2px; color:#52616a; }
.eco { display:grid; grid-template-columns:30px 1fr 92px; gap:0 9px; align-items:start; border:1px solid #dde3e6; border-left:4px solid #2e8b57; background:rgba(255,255,255,.96); padding:8px 10px; margin:0 0 7px; break-inside:avoid; }
.eco .n { width:24px; height:24px; border-radius:50%; background:#2f3b42; color:#e9d48a; font-weight:800; font-size:11px; display:flex; align-items:center; justify-content:center; }
.eco .t { font-size:10.4px; font-weight:800; margin-bottom:2px; } .eco .x { font-size:9.1px; color:#3c4950; text-align:justify; }
.eco .val { text-align:right; font-size:12.5px; font-weight:800; color:#1f6e43; line-height:1.15; } .eco .val small { display:block; font-size:7.6px; font-weight:600; color:#6b7880; text-transform:uppercase; }
.eco.q { border-left-color:#c9a227; } .eco.q .val { color:#6b5410; font-size:10px; }
.fluxo2 { display:grid; grid-template-columns:repeat(5,1fr); gap:5px; margin:8px 0 12px; break-inside:avoid; }
.fluxo2 div { background:#f0f4f6; border-top:3px solid #2f3b42; padding:7px; font-size:8.4px; text-align:center; } .fluxo2 b { display:block; font-size:9px; margin-bottom:2px; }
.preco { border:2px solid #c9a227; background:#fffdf5; padding:12px 14px; margin:10px 0; break-inside:avoid; }
.preco table { width:100%; border-collapse:collapse; font-size:9.6px; } .preco td { padding:5px 4px; border-bottom:1px dashed #e4d8a8; }
.preco tr.cab td { font-size:8.4px; text-transform:uppercase; letter-spacing:.04em; color:#6b5410; border-bottom:1.5px solid #c9a227; }
.preco tr.total td { font-size:12px; font-weight:800; border-bottom:none; border-top:2px solid #c9a227; padding-top:7px; }
.ok { color:#1f6e43; font-weight:700; } .no { color:#9c3a24; font-weight:700; }
</style></head><body>${bg}<table class="layout"><thead><tr><td class="espaco-topo"></td></tr></thead><tfoot><tr><td class="espaco-rodape"></td></tr></tfoot><tbody><tr><td class="corpo">${corpo}</td></tr></tbody></table></body></html>`;
}

export async function gerarPdfPropostaEscritorio(...args: Parameters<typeof htmlPropostaEscritorio>): Promise<Buffer> {
  const html = htmlPropostaEscritorio(...args);
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route: any) => {
      const url = route.request().url();
      if (url.startsWith("data:") || url === "about:blank") return route.continue();
      return route.abort();
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    return (await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true })) as Buffer;
  } finally {
    await browser.close();
  }
}

// Anexo I do contrato da plataforma (HTML já escapado — entra cru no modelo).
export function anexoModulosHtml(c: ConfigEscritorio) {
  const v = calcularValores(c);
  const f = (x: number) => "R$ " + x.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const linhas = v.itens.map((i) => `<tr><td>${i.chave === "plataforma_base" ? `Plataforma base (${FUNCIONALIDADES_BASE.map((x) => esc(x.titulo)).join("; ")})` : esc(i.nome)}</td><td>${f(i.tabela)}</td><td>${i.isento ? "Isento" : i.descontoPct ? `${String(i.descontoPct).replace(".", ",")}%` : "—"}</td><td>${i.isento ? "Isento" : f(i.final)}</td></tr>`);
  if (v.descontoGeral) linhas.push(`<tr><td colspan="3">Desconto especial sobre o total (${String(c.descontoPct).replace(".", ",")}%)</td><td>− ${f(v.descontoGeral)}</td></tr>`);
  linhas.push(`<tr><td colspan="3"><b>Mensalidade total</b></td><td><b>${f(v.mensal)}</b></td></tr>`);
  linhas.push(`<tr><td>Implantação (valor único)${c.implantacaoParcelas > 1 && v.implantacaoFinal ? ` — parcelada em ${parcelasTexto(v.implantacaoFinal, c.implantacaoParcelas)}` : ""}</td><td>${f(c.implantacao)}</td><td>${c.implantacaoIsenta ? "Isenta" : c.implantacaoDescontoPct ? `${String(c.implantacaoDescontoPct).replace(".", ",")}%` : "—"}</td><td>${v.implantacaoFinal ? f(v.implantacaoFinal) : "Isenta"}</td></tr>`);
  return `<table class="dados"><thead><tr><th>Item contratado</th><th>Valor de tabela</th><th>Desconto</th><th>Valor contratado</th></tr></thead><tbody>${linhas.join("")}</tbody></table>`;
}
