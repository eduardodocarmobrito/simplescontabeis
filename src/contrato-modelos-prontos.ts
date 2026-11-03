// Modelos de contrato prontos, oferecidos em Contratos > Modelos > Novo modelo ("Carregar modelo
// pronto"). O escritório carrega, revisa e salva como modelo seu — daí em diante é um modelo comum.
// Convenções do texto (ver contratos.ts): parágrafo que começa com "CLÁUSULA" abre uma cláusula e as
// <ol> dentro dela viram 1.1, 1.2…; o timbrado entra sozinho no PDF. O bloco de assinaturas segue o
// formato que o assinatura-posicoes.ts reconhece (linha pontilhada + bloco com o nome embaixo; "1.___"
// e "2.___" nas testemunhas) pra Autentique carimbar cada assinatura na linha certa.

export interface ModeloContratoPronto {
  id: string;
  nome: string;
  campos: { chave: string; rotulo: string; autoPreencherDe: string | null }[];
  conteudoHtml: string;
}

// Base pesquisada (nov/2026): CC arts. 368-369, 389, 395, 402-404, 408-416, 421-A, 593-609 (605:
// vedação de substituição; 608: aliciamento), 934 (regresso), 1.177-1.178; CTN art. 123; DL 9.295/46;
// Res. CFC 1.590/2020 (conteúdo mínimo do contrato e distrato); NBC PG 01 item 5(c) (transferência
// parcial mantendo a responsabilidade técnica); LGPD arts. 39, 42, 46-49; CPC art. 784, III e §4º;
// Lei 14.063/2020; CLT art. 442-B (autônomo).
const TERCEIRIZACAO_HTML = `
<h1>CONTRATO DE PRESTAÇÃO DE SERVIÇOS CONTÁBEIS TERCEIRIZADOS Nº {{n_contrato_sequencial}}/{{ano}}</h1>
<p>Pelo presente instrumento particular, de um lado, <b>SIMPLES SERVIÇOS DE CONTABILIDADE, PERÍCIA E AUDITORIA CONTABIL LTDA</b>, inscrita no CNPJ sob o nº 04.801.040/0001-93, com sede na Rua Sérgio Luiz de Farias, nº 656, Bairro Morada da Paz, Redenção-PA, CEP 68.550-510, telefones (94) 99222-1064 / (94) 99164-9036, e-mail simplescontabeis@gmail.com, neste ato representada por seus sócios <b>EDUARDO DO CARMO BRITO</b>, contador, CPF 017.055.832-02, CRC 021166/O-9 PA, e <b>ELIMARCER FERNANDES COSTA</b>, contador, CPF 431.133.032-49, CRC 018074/O PA, doravante denominada <b>CONTRATANTE</b>; e, de outro lado, <b>{{contratada_nome}}</b>, inscrita no CNPJ/CPF sob o nº {{CNPJ_CPF_contratada}}, com endereço na {{contratada_endereco}}, {{contratada_cidade}}-{{contratada_uf}}, CEP {{CEP}}, e-mail {{email_contratada}}, telefone {{telefone_contratada}}, neste ato representada por <b>{{nome_representante_legal}}</b>, CPF {{CPF_Representante_Legal}}, tendo como responsável técnico <b>{{responsavel_tecnico}}</b>, registrado no CRC sob o nº {{crc_responsavel_tecnico}}, doravante denominada <b>CONTRATADA</b>; têm entre si justo e contratado o presente Contrato de Prestação de Serviços Contábeis Terceirizados, que se regerá pelas cláusulas e condições seguintes.</p>

<p class="clausula-titulo">CLÁUSULA PRIMEIRA – DO OBJETO</p>
<ol>
<li>O objeto deste contrato é a execução, pela CONTRATADA, por conta e sob a coordenação da CONTRATANTE, dos serviços dos setores <b>Fiscal</b>, <b>Contábil</b> e/ou <b>Departamento Pessoal (Folha)</b> das empresas-clientes da CONTRATANTE relacionadas no <b>Anexo I</b>, conforme os setores marcados para cada empresa.</li>
<li><b>Setor Fiscal:</b> escrituração fiscal de entradas, saídas e serviços; apuração e emissão das guias de ICMS (inclusive ST e DIFAL), ISS, IPI, PIS, COFINS, IRPJ e CSLL; apuração do Simples Nacional (PGDAS-D) e DEFIS; EFD ICMS/IPI, EFD-Contribuições, EFD-Reinf e DCTFWeb (parte fiscal); declarações estaduais e municipais; conferência de notas fiscais e acompanhamento de pendências e malhas fiscais.</li>
<li><b>Setor Contábil:</b> escrituração contábil, conciliações das contas, balancetes mensais, Demonstração do Resultado, Balanço Patrimonial e demais demonstrações exigidas, livros Diário e Razão, ECD e ECF, nos prazos legais e conforme as Normas Brasileiras de Contabilidade.</li>
<li><b>Setor de Departamento Pessoal (Folha):</b> folha de pagamento mensal, pró-labore, adiantamentos, férias, 13º salário, admissões e rescisões; todos os eventos do eSocial; FGTS Digital; DCTFWeb e EFD-Reinf (parte previdenciária); guias de INSS, FGTS e IRRF; informes de rendimentos e demais obrigações trabalhistas e previdenciárias.</li>
<li>Integram o objeto todas as obrigações principais e acessórias exigíveis no período de execução para as empresas e setores do Anexo I, ainda que criadas ou alteradas pela legislação após a assinatura deste contrato.</li>
<li>Os serviços são executados em nome da CONTRATANTE, que permanece responsável técnica perante seus clientes, nos termos da NBC PG 01 (Código de Ética Profissional do Contador), sem prejuízo da responsabilidade integral da CONTRATADA perante a CONTRATANTE prevista neste contrato.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA SEGUNDA – DA NATUREZA DO CONTRATO</p>
<ol>
<li>Este é um contrato civil e empresarial de prestação de serviços (arts. 593 a 609 e 421-A do Código Civil), sem qualquer subordinação, exclusividade ou vínculo empregatício entre a CONTRATANTE e a CONTRATADA, seus sócios, empregados ou colaboradores.</li>
<li>A CONTRATADA organiza livremente seus meios, horários e equipe, responde exclusivamente pelos encargos trabalhistas, previdenciários, fiscais e civis do seu pessoal e é remunerada por empresa e setor executado, e não por jornada.</li>
<li>É vedado à CONTRATADA ceder ou subcontratar, no todo ou em parte, os serviços deste contrato sem autorização prévia e por escrito da CONTRATANTE (art. 605 do Código Civil).</li>
</ol>

<p class="clausula-titulo">CLÁUSULA TERCEIRA – DAS EMPRESAS ATENDIDAS (ANEXO I)</p>
<ol>
<li>As empresas atendidas, com nome, CNPJ, código no sistema Domínio, regime tributário, setores terceirizados e valor mensal de cada setor, constam do Anexo I, que é parte integrante deste contrato.</li>
<li>A inclusão ou exclusão de empresas e setores será feita por comunicação escrita (inclusive e-mail) da CONTRATANTE, com antecedência mínima de 30 (trinta) dias, e consolidada em termo aditivo. No mês de entrada ou saída, o valor será proporcional às competências efetivamente executadas.</li>
<li>Mudanças de regime tributário, enquadramento, atividade ou quadro societário das empresas serão comunicadas pela CONTRATANTE assim que delas tiver ciência, cabendo à CONTRATADA ajustar os procedimentos a partir da competência seguinte.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA QUARTA – DAS OBRIGAÇÕES DA CONTRATANTE</p>
<ol>
<li>Repassar à CONTRATADA os documentos e informações das empresas até as datas do calendário do Anexo II.</li>
<li>Disponibilizar acesso ao sistema Domínio e ao ambiente de trabalho do escritório, com usuários nominais e pessoais.</li>
<li>Obter de seus clientes as Cartas de Responsabilidade da Administração e as autorizações necessárias, inclusive para o tratamento de dados pela CONTRATADA.</li>
<li>Efetuar os pagamentos nas datas pactuadas, ressalvadas as retenções e compensações previstas neste contrato.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA QUINTA – DAS OBRIGAÇÕES DA CONTRATADA</p>
<ol>
<li>Executar os serviços com zelo, diligência e técnica, de acordo com a legislação vigente, as Normas Brasileiras de Contabilidade e o Código de Ética Profissional do Contador.</li>
<li>Cumprir integralmente a agenda fiscal, contábil, trabalhista e previdenciária das empresas do Anexo I, observando os prazos internos do Anexo II, que são anteriores aos vencimentos legais.</li>
<li>Conferir, a cada competência, o regime tributário, o enquadramento (inclusive limites do Simples Nacional e sublimites), as alíquotas, as atividades e os anexos aplicáveis a cada empresa, alertando a CONTRATANTE, por escrito, sobre qualquer risco de desenquadramento, exclusão, regime inadequado ou tributação indevida.</li>
<li>Comunicar à CONTRATANTE, em até 2 (dois) dias úteis do recebimento, qualquer documento ou informação faltante que impeça a execução no prazo, sob pena de assumir a responsabilidade pelo atraso.</li>
<li>Entregar mensalmente, até o dia 10 (dez) do mês seguinte ao da competência, o relatório de entregas por empresa, com os recibos, protocolos e comprovantes de transmissão de cada obrigação.</li>
<li>Manter durante toda a vigência o registro ativo e regular no Conselho Regional de Contabilidade (CRC) da CONTRATADA, de seu responsável técnico e de quem executar os serviços, comunicando imediatamente qualquer suspensão, baixa ou impedimento.</li>
<li>Apresentar, na assinatura e a cada 6 (seis) meses, certidões de regularidade fiscal federal, trabalhista (CNDT), do FGTS e do CRC.</li>
<li>Exigir de seus sócios, empregados e colaboradores que atuem neste contrato a assinatura de termo de confidencialidade e proteção de dados.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA SEXTA – DO SISTEMA, CERTIFICADOS DIGITAIS E PROCURAÇÕES</p>
<ol>
<li>Os serviços serão executados obrigatoriamente no sistema Domínio e no ambiente indicados pela CONTRATANTE, onde permanecem as bases de dados, escriturações, arquivos e históricos, que são de propriedade da CONTRATANTE e de seus clientes.</li>
<li>Certificados digitais, senhas, procurações eletrônicas (inclusive e-CAC) e demais credenciais das empresas e da CONTRATANTE serão usados exclusivamente no ambiente indicado e somente para a execução deste contrato, sendo vedado copiá-los, exportá-los, armazená-los fora desse ambiente, repassá-los ou substabelecê-los.</li>
<li>Os acessos são pessoais, registrados e podem ser suspensos ou revogados pela CONTRATANTE a qualquer tempo.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA SÉTIMA – DA RESPONSABILIDADE E DO DIREITO DE REGRESSO</p>
<ol>
<li>A CONTRATADA responde integralmente por todos os prejuízos decorrentes de atraso, omissão, erro de apuração, de cálculo, de escrituração ou de parametrização, transmissão incorreta, enquadramento ou regime tributário equivocado, ou qualquer outra falha na execução dos serviços, incluindo multas, juros, correção monetária, encargos, autos de infração, glosas, débitos de FGTS, INSS e eSocial, diferenças de tributos pagos a maior ou a menor, indenizações pagas a clientes, custas e honorários advocatícios.</li>
<li>Ainda que, perante o Fisco, os clientes ou o CRC, a responsabilidade recaia sobre a CONTRATANTE ou sobre o cliente (art. 123 do Código Tributário Nacional), fica assegurado à CONTRATANTE o direito de regresso contra a CONTRATADA pela totalidade dos valores pagos ou suportados (arts. 389, 402 e 934 do Código Civil).</li>
<li>A CONTRATADA reembolsará os valores em até 10 (dez) dias da notificação acompanhada do comprovante, sem prejuízo de apresentar defesa, retificação ou recurso às suas custas, e sem que isso suspenda o reembolso.</li>
<li>A CONTRATADA fica isenta somente quando comprovar que o prejuízo decorreu exclusivamente de documento ou informação não repassados pela CONTRATANTE até a data do Anexo II, desde que tenha feito a comunicação prevista no item 5.4.</li>
<li>A responsabilidade prevista nesta cláusula subsiste após o término do contrato, até o fim dos prazos de decadência e prescrição tributários, trabalhistas e previdenciários relativos às competências executadas pela CONTRATADA, contando-se o prazo para o regresso a partir do efetivo pagamento pela CONTRATANTE.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA OITAVA – DA RETENÇÃO, COMPENSAÇÃO E MULTAS</p>
<ol>
<li>A CONTRATANTE poderá reter e compensar dos valores devidos à CONTRATADA, vencidos ou a vencer, qualquer quantia devida pela CONTRATADA com base neste contrato (arts. 368 e 369 do Código Civil), inclusive reter cautelarmente o valor estimado de auto de infração ou cobrança em discussão até sua solução.</li>
<li>Pela entrega de guia ou obrigação após o prazo interno do Anexo II, ainda que dentro do vencimento legal, a CONTRATADA pagará multa de 10% (dez por cento) do valor mensal da respectiva empresa no Anexo I, por ocorrência.</li>
<li>As multas deste contrato são mínimo de indenização e não excluem a cobrança do prejuízo excedente (art. 416, parágrafo único, do Código Civil), nem o reembolso previsto na Cláusula Sétima.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA NONA – DA CARTEIRA DE CLIENTES E DO NÃO ALICIAMENTO</p>
<ol>
<li>As empresas do Anexo I são clientes exclusivos da CONTRATANTE. A CONTRATADA não manterá contato comercial direto com elas sem autorização da CONTRATANTE, limitando-se aos contatos operacionais estritamente necessários e por ela autorizados.</li>
<li>Durante a vigência e por 24 (vinte e quatro) meses após seu término, é vedado à CONTRATADA, a seus sócios, parentes, empregados ou empresas ligadas, direta ou indiretamente, oferecer ou prestar serviços contábeis, fiscais, trabalhistas ou de consultoria às empresas que constem ou tenham constado do Anexo I nos últimos 12 (doze) meses.</li>
<li>A violação sujeita a CONTRATADA à multa de 24 (vinte e quatro) vezes o honorário mensal pago pelo cliente aliciado à CONTRATANTE (ou, se maior, 24 vezes o valor mensal da empresa no Anexo I), por cliente, além das perdas e danos (art. 608 do Código Civil).</li>
<li>É vedado à CONTRATADA contratar empregados ou colaboradores da CONTRATANTE durante a vigência e por 12 (doze) meses após o término.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA – DA CONFIDENCIALIDADE E PROTEÇÃO DE DADOS (LGPD)</p>
<ol>
<li>A CONTRATADA guardará sigilo absoluto sobre dados, documentos, informações e valores das empresas e da CONTRATANTE, obrigação que permanece após o término do contrato, sob pena de multa de 12 (doze) vezes o valor mensal total do Anexo I, sem prejuízo das perdas e danos.</li>
<li>A CONTRATADA atua como suboperadora de dados pessoais (Lei 13.709/2018), tratando-os apenas conforme as instruções da CONTRATANTE e para a execução deste contrato, adotando medidas técnicas e administrativas de segurança e vedado qualquer outro uso.</li>
<li>Qualquer incidente de segurança deverá ser comunicado à CONTRATANTE em até 24 (vinte e quatro) horas de sua ciência. A CONTRATADA cooperará no atendimento aos titulares e à ANPD e responderá pelos danos que causar.</li>
<li>Ao término, a CONTRATADA devolverá e eliminará de seus meios todos os dados e documentos recebidos, ressalvadas as hipóteses legais de guarda.</li>
<li>As partes declaram ciência das obrigações da Lei 9.613/1998 (prevenção à lavagem de dinheiro) e das normas do CFC, comprometendo-se a CONTRATADA a comunicar à CONTRATANTE qualquer operação suspeita que identificar.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA PRIMEIRA – DOS VALORES, PAGAMENTO E REAJUSTE</p>
<ol>
<li>Pelos serviços, a CONTRATANTE pagará à CONTRATADA o valor mensal total de <b>R$ {{valor_honorário}}</b> ({{vlr_extenso}}), correspondente à soma dos valores por empresa e setor do Anexo I.</li>
<li>O pagamento será feito até o dia {{dia_vencimento}} do mês seguinte ao da competência executada, mediante nota fiscal (ou recibo, se pessoa física) e entrega do relatório de entregas do item 5.5, com as retenções legais cabíveis.</li>
<li>Os valores serão reajustados a cada 12 (doze) meses pela variação acumulada do IPCA/IBGE, ou por índice que o substitua.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA SEGUNDA – DA VIGÊNCIA E RESCISÃO</p>
<ol>
<li>Este contrato vigora por 12 (doze) meses a partir de {{data_inicio}}, renovando-se automaticamente por prazo indeterminado se nenhuma das partes se manifestar em contrário.</li>
<li>Qualquer das partes pode rescindi-lo sem justa causa mediante aviso prévio por escrito de 60 (sessenta) dias, durante os quais a CONTRATADA cumprirá integralmente suas obrigações.</li>
<li>A CONTRATANTE poderá rescindir imediatamente, sem aviso prévio e sem ônus, nos casos de: atraso em obrigação legal ou entrega fora do prazo interno por 2 (duas) vezes em 6 (seis) meses; aliciamento de cliente; quebra de sigilo ou de proteção de dados; uso indevido de certificados ou credenciais; suspensão ou baixa do registro no CRC; ou subcontratação não autorizada.</li>
<li>A exclusão de uma ou mais empresas ou setores do Anexo I não implica rescisão do contrato quanto às demais.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA TERCEIRA – DA TRANSIÇÃO AO TÉRMINO</p>
<ol>
<li>No término do contrato, ou na exclusão de empresa do Anexo I, a CONTRATADA entregará em até 10 (dez) dias todos os arquivos, memórias de cálculo, recibos, protocolos e pendências, com relatório da situação de cada empresa, e prestará as informações necessárias à continuidade dos serviços, nos moldes da Resolução CFC 1.590/2020.</li>
<li>Concluída a transição, os acessos da CONTRATADA serão revogados.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA QUARTA – DAS COMUNICAÇÕES</p>
<ol>
<li>As comunicações e notificações serão feitas por escrito, valendo o e-mail como meio oficial. CONTRATANTE: e-mail simplescontabeis@gmail.com, telefones (94) 99222-1064 / (94) 99164-9036. CONTRATADA: e-mail {{email_contratada}}, telefone {{telefone_contratada}}.</li>
<li>A alteração de endereço, e-mail ou telefone deverá ser comunicada à outra parte, sob pena de valerem as comunicações enviadas aos contatos acima.</li>
</ol>

<p class="clausula-titulo">CLÁUSULA DÉCIMA QUINTA – DISPOSIÇÕES GERAIS E FORO</p>
<ol>
<li>A tolerância de uma parte quanto ao descumprimento de qualquer cláusula não implica novação nem renúncia de direitos.</li>
<li>Alterações deste contrato somente serão válidas por termo aditivo assinado pelas partes.</li>
<li>As partes admitem a assinatura eletrônica deste instrumento (Lei 14.063/2020 e MP 2.200-2/2001), que, assinado também por 2 (duas) testemunhas, constitui título executivo extrajudicial (art. 784, III e §4º, do Código de Processo Civil).</li>
<li>Fica eleito o foro da Comarca de Redenção-PA para dirimir quaisquer questões oriundas deste contrato, com renúncia a qualquer outro, por mais privilegiado que seja.</li>
</ol>

<p>E por estarem assim justas e contratadas, as partes firmam o presente instrumento, na presença das 2 (duas) testemunhas abaixo identificadas.</p>
<p class="align-right">Redenção, Pará, {{dia}} de {{mes}} de {{ano}}.</p>

<p class="align-center">.................................................................................................</p>
<p class="align-center">SIMPLES SERVIÇOS DE CONTABILIDADE, PERÍCIA E AUDITORIA CONTABIL LTDA</p>
<p class="align-center">CNPJ: 04.801.040/0001-93</p>
<p class="align-center">EDUARDO DO CARMO BRITO</p>
<p class="align-center">CPF: 017.055.832-02 - CONTADOR CRC 021166/O-9 PA</p>
<p class="align-center">CONTRATANTE</p>
<p class="align-center">.................................................................................................</p>
<p class="align-center">SIMPLES SERVIÇOS DE CONTABILIDADE, PERÍCIA E AUDITORIA CONTABIL LTDA</p>
<p class="align-center">CNPJ: 04.801.040/0001-93</p>
<p class="align-center">ELIMARCER FERNANDES COSTA</p>
<p class="align-center">CPF: 431.133.032-49 - CONTADOR CRC 018074/O PA</p>
<p class="align-center">CONTRATANTE</p>
<p class="align-center">.................................................................................................</p>
<p class="align-center">{{contratada_nome}}</p>
<p class="align-center">CNPJ/CPF: {{CNPJ_CPF_contratada}}</p>
<p class="align-center">{{nome_representante_legal}}</p>
<p class="align-center">CPF: {{CPF_Representante_Legal}}</p>
<p class="align-center">CONTRATADA</p>
<p><b>Testemunhas:</b></p>
<table style="width:100%"><tr><td>1.________________________________</td><td>2.________________________________</td></tr>
<tr><td>Nome: {{testemunha1}}</td><td>Nome: {{testemunha2}}</td></tr>
<tr><td>CPF: {{CPF_testemunha1}}</td><td>CPF: {{CPF_testemunha2}}</td></tr></table>

<h1 style="page-break-before: always;">ANEXO I – EMPRESAS E SETORES TERCEIRIZADOS</h1>
<p>Contrato de Prestação de Serviços Contábeis Terceirizados nº {{n_contrato_sequencial}}/{{ano}} — CONTRATADA: {{contratada_nome}}.</p>
<div>{{anexo_empresas_terceirizadas}}</div>
<p>Valores mensais em reais. Inclusões e exclusões conforme a Cláusula Terceira.</p>

<h1 style="page-break-before: always;">ANEXO II – CALENDÁRIO E PRAZOS INTERNOS</h1>
<table class="dados">
<thead><tr><th>Etapa</th><th>Prazo</th></tr></thead>
<tbody>
<tr><td>Repasse de documentos da competência pela CONTRATANTE</td><td>Até o dia 5 do mês seguinte (ou conforme combinado por empresa)</td></tr>
<tr><td>Aviso de documento faltante pela CONTRATADA</td><td>Até 2 dias úteis após o recebimento</td></tr>
<tr><td>Prévia da folha de pagamento para conferência</td><td>Até 3 dias úteis antes da data de pagamento dos salários</td></tr>
<tr><td>Guias de tributos e encargos (DAS, DARF, ICMS, ISS, INSS, FGTS etc.) entregues à CONTRATANTE</td><td>Até 3 dias úteis antes do vencimento</td></tr>
<tr><td>Obrigações acessórias mensais (EFD, DCTFWeb, EFD-Reinf, eSocial, declarações estaduais/municipais)</td><td>Transmitidas até 2 dias úteis antes do prazo legal</td></tr>
<tr><td>Obrigações anuais (DEFIS, ECD, ECF, informes de rendimentos e demais)</td><td>Transmitidas até 10 dias antes do prazo legal</td></tr>
<tr><td>Balancete mensal (setor Contábil)</td><td>Até o dia 25 do mês seguinte ao da competência</td></tr>
<tr><td>Relatório de entregas com recibos e protocolos</td><td>Até o dia 10 do mês seguinte ao da competência</td></tr>
</tbody>
</table>
`;

export const MODELOS_CONTRATO_PRONTOS: ModeloContratoPronto[] = [
  {
    id: "terceirizacao-setores",
    nome: "Contrato - Prestação de Serviços Terceirizados",
    campos: [
      { chave: "contratada_nome", rotulo: "Contratada (terceiro) — nome/razão social", autoPreencherDe: "nome" },
      { chave: "CNPJ_CPF_contratada", rotulo: "CNPJ/CPF da contratada", autoPreencherDe: "cnpj" },
      { chave: "contratada_endereco", rotulo: "Endereço da contratada", autoPreencherDe: "endereco" },
      { chave: "contratada_cidade", rotulo: "Cidade da contratada", autoPreencherDe: "cidade" },
      { chave: "contratada_uf", rotulo: "UF da contratada", autoPreencherDe: "uf" },
      { chave: "CEP", rotulo: "CEP da contratada", autoPreencherDe: "cep" },
      { chave: "email_contratada", rotulo: "E-mail da contratada", autoPreencherDe: "email" },
      { chave: "nome_representante_legal", rotulo: "Representante legal da contratada", autoPreencherDe: "nomeRepresentanteLegal" },
      { chave: "CPF_Representante_Legal", rotulo: "CPF do representante legal", autoPreencherDe: "cpfRepresentanteLegal" },
      { chave: "telefone_contratada", rotulo: "Telefone da contratada", autoPreencherDe: null },
      { chave: "responsavel_tecnico", rotulo: "Responsável técnico (contador) da contratada", autoPreencherDe: null },
      { chave: "crc_responsavel_tecnico", rotulo: "CRC do responsável técnico", autoPreencherDe: null },
      { chave: "anexo_empresas_terceirizadas", rotulo: "Empresas terceirizadas (Anexo I)", autoPreencherDe: null },
      { chave: "valor_honorário", rotulo: "Valor mensal total (soma do Anexo I)", autoPreencherDe: null },
      { chave: "dia_vencimento", rotulo: "Dia do pagamento (mês seguinte)", autoPreencherDe: null },
      { chave: "data_inicio", rotulo: "Início da vigência (dd/mm/aaaa)", autoPreencherDe: null },
      { chave: "testemunha1", rotulo: "Testemunha 1", autoPreencherDe: null },
      { chave: "CPF_testemunha1", rotulo: "CPF da testemunha 1", autoPreencherDe: null },
      { chave: "testemunha1_email", rotulo: "E-mail da testemunha 1", autoPreencherDe: null },
      { chave: "testemunha2", rotulo: "Testemunha 2", autoPreencherDe: null },
      { chave: "CPF_testemunha2", rotulo: "CPF da testemunha 2", autoPreencherDe: null },
      { chave: "testemunha2_email", rotulo: "E-mail da testemunha 2", autoPreencherDe: null },
    ],
    conteudoHtml: TERCEIRIZACAO_HTML.trim(),
  },
];
