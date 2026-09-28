; ============================================================================
; Robô "Comparativo de Movimento" — roda no servidor Windows onde o Domínio
; Web está instalado. Todo dia, pega a lista de empresas marcadas no site
; (Empresas > Editar > Configurações > "Exportar Comparativo de Movimento
; diariamente"), abre cada uma no Domínio, exporta o relatório em PDF e salva
; numa pasta sincronizada pelo Google Drive Desktop — o site já lê essa pasta
; sozinho a cada 10 segundos (Configurações > Domínio Web > Relatórios).
;
; ESTE ARQUIVO AINDA TEM PARTES INCOMPLETAS (marcadas com "TODO" abaixo).
; Elas dependem de ver a tela real do Domínio Web — não dá pra adivinhar o
; nome exato dos menus/botões sem isso. Veja o LEIA-ME.txt desta mesma pasta
; para o passo a passo de como descobrir e preencher essas partes.
; ============================================================================

#Requires AutoHotkey v2.0
#SingleInstance Force
SetWorkingDir A_ScriptDir

; ---------------------------------------------------------------- CONFIGURAÇÃO
; URL do site e a MESMA chave já usada pelo agente do Domínio Web (a mesma que
; fica em DOMINIO_AGENT_TOKEN no servidor do site) — pergunte ao administrador
; se não souber onde pegar; ela também aparece em Configurações > Domínio Web.
SITE_URL := "https://simplescontabeis-production.up.railway.app"
AGENTE_TOKEN := "COLE_AQUI_O_TOKEN_DO_AGENTE"

; Pasta sincronizada pelo Google Drive Desktop neste computador — a MESMA pasta
; que você compartilhou com agente-drive@simples-contabeis.iam.gserviceaccount.com
; e escolheu em Configurações > Domínio Web > Relatórios > "Pasta no Google Drive".
PASTA_SAIDA := "C:\Users\SEU_USUARIO\Google Drive\Relatorios Dominio"

; Caminho do executável do Domínio Web neste servidor.
DOMINIO_EXE := "C:\Caminho\Para\DominioWeb.exe"   ; TODO: ajuste pro caminho real

; ---------------------------------------------------------------- BUSCA A LISTA DE EMPRESAS
BuscarEmpresas() {
    global SITE_URL, AGENTE_TOKEN
    http := ComObject("WinHttp.WinHttpRequest.5.1")
    http.Open("GET", SITE_URL . "/api/dominio-agent/empresas-comparativo", false)
    http.SetRequestHeader("X-Agent-Token", AGENTE_TOKEN)
    http.Send()
    if (http.Status != 200) {
        MsgBox("Não consegui buscar a lista de empresas no site (HTTP " . http.Status . "). Confira o token e a internet.")
        return []
    }
    ; Resposta: {"items":[{"id":1,"codigoDominio":"125","nome":"ARMAZENS..."}]}
    return ParseJsonItems(http.ResponseText)
}

; Analisador de JSON bem simples, só pro formato fixo acima (evita depender de
; biblioteca externa). Se preferir mais robustez, dá pra trocar por uma lib de
; JSON pra AutoHotkey v2 (ex.: "Cjson.ahk", fácil de achar pronta).
ParseJsonItems(texto) {
    itens := []
    pos := 1
    while (pos := RegExMatch(texto, '"codigoDominio":"(.*?)".*?"nome":"(.*?)"', &m, pos)) {
        itens.Push({codigo: m[1], nome: m[2]})
        pos += StrLen(m[0])
    }
    return itens
}

; ---------------------------------------------------------------- AVISA O SITE DO RESULTADO
AvisarResultado(codigo, ok, erro := "") {
    global SITE_URL, AGENTE_TOKEN
    corpo := '{"itens":[{"codigoDominio":"' . codigo . '","ok":' . (ok ? "true" : "false") . (erro ? ',"erro":"' . StrReplace(erro, '"', "'") . '"' : "") . '}]}'
    try {
        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.Open("POST", SITE_URL . "/api/dominio-agent/comparativo-status", false)
        http.SetRequestHeader("X-Agent-Token", AGENTE_TOKEN)
        http.SetRequestHeader("Content-Type", "application/json")
        http.Send(corpo)
    }
}

; ---------------------------------------------------------------- ABRE O DOMÍNIO (se não estiver aberto)
GarantirDominioAberto() {
    global DOMINIO_EXE
    ; TODO: troque "DominioWeb.exe" pelo nome de processo real (Gerenciador de Tarefas > Detalhes)
    if !ProcessExist("DominioWeb.exe") {
        Run(DOMINIO_EXE)
        WinWaitActive("ahk_exe DominioWeb.exe", , 60)
        Sleep(3000)  ; tempo pro sistema terminar de carregar a tela inicial
    }
}

; ---------------------------------------------------------------- POR EMPRESA: exporta o relatório
; TODO — esta é a parte que precisa dos seus prints/Window Spy pra ficar certa.
; O esqueleto abaixo mostra ONDE cada ação entra; troque os comentários "TODO"
; pelos comandos reais (ControlClick, Send, etc.) — veja o LEIA-ME.txt.
ExportarComparativo(codigo, nome, pasta) {
    ; 1) Selecionar a empresa pelo código
    ;    TODO: normalmente é um campo de busca/combo no topo do Domínio.
    ;    Exemplo (ajustar o nome do controle depois do Window Spy):
    ;    ControlFocus("Edit1", "ahk_exe DominioWeb.exe")
    ;    ControlSetText("Edit1", codigo, "ahk_exe DominioWeb.exe")
    ;    Send("{Enter}")
    ;    Sleep(1500)

    ; 2) Abrir o menu/relatório "Comparativo de Movimento"
    ;    TODO: pode ser um menu (Send("!r") pra Alt+R, por exemplo) ou um
    ;    duplo-clique numa árvore de relatórios. Descubra com Window Spy.

    ; 3) Preencher o período do relatório (se pedir)
    ;    TODO: normalmente as datas do mês atual — dá pra calcular com
    ;    FormatTime(A_Now, "01/MM/yyyy") pro primeiro dia do mês, etc.

    ; 4) Exportar/Salvar como PDF
    ;    TODO: o Domínio costuma ter um botão "Exportar" ou "Imprimir para
    ;    PDF" que abre um "Salvar como" do Windows — nesse caso:
    ;    WinWaitActive("Salvar como")
    ;    caminho := pasta . "\ComparativoMovimento_" . codigo . "_" . FormatTime(A_Now, "yyyyMMdd") . ".pdf"
    ;    ControlSetText("Edit1", caminho, "Salvar como")
    ;    Send("{Enter}")
    ;    WinWaitClose("Salvar como", , 30)

    ; 5) Fechar a tela do relatório pra voltar pro estado inicial
    ;    TODO: Send("{Escape}") ou fechar a janela do relatório, conforme o caso.

    return true  ; troque por false + mensagem de erro se algo falhar
}

; ---------------------------------------------------------------- ROTINA PRINCIPAL
Main() {
    global PASTA_SAIDA
    DirCreate(PASTA_SAIDA)
    empresas := BuscarEmpresas()
    if (empresas.Length = 0) {
        MsgBox("Nenhuma empresa marcada para o Comparativo de Movimento (ou falha ao buscar a lista).")
        return
    }
    GarantirDominioAberto()
    for empresa in empresas {
        ok := true
        erro := ""
        try {
            ok := ExportarComparativo(empresa.codigo, empresa.nome, PASTA_SAIDA)
        } catch as e {
            ok := false
            erro := e.Message
        }
        AvisarResultado(empresa.codigo, ok, erro)
        Sleep(1000)  ; respiro entre uma empresa e outra
    }
    MsgBox("Concluído: " . empresas.Length . " empresa(s) processada(s).")
}

Main()
