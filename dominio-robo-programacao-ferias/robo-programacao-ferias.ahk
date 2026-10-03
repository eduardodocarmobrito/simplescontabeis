#Requires AutoHotkey v2.0
#SingleInstance Force
SetTitleMatchMode 2
SetKeyDelay 60, 60
CoordMode "Pixel", "Screen"
CoordMode "Mouse", "Screen"

; ============================================================================
;  AGENTE "PROGRAMACAO DE FERIAS" - Dominio Folha (streaming)
;
;  Fica rodando sozinho e PERGUNTA AO SITE a cada 10s se deve rodar (manual ou
;  automatico por intervalo). Ao rodar, puxa as empresas marcadas no site,
;  processa uma a uma e REPORTA O PROGRESSO (barra na tela do site).
;
;  PRE-REQUISITOS: Dominio ABERTO e LOGADO; F8 em modo "Codigo"; "Programacao de
;  Ferias" no menu FAVORITOS (modulo Folha); nada cobrindo o canto sup. esquerdo.
;
;  Diferencas vs. o robo do Comparativo: modulo FOLHA; Favoritos = 2o item;
;  tela de parametros so precisa clicar OK (Data base = hoje, padrao); sem periodo.
;
;  SAIR: Ctrl+Alt+Q.
; ============================================================================

; ---------------------------------------------------------------- CONFIGURACAO
SITE_URL     := "https://simplescontabeis-production.up.railway.app"
AGENTE_TOKEN := "COLE_AQUI_O_TOKEN_DO_AGENTE"

POLL_SEGUNDOS := 10       ; de quanto em quanto tempo pergunta ao site

; Re-selecionar o modulo Folha a cada execucao? true = garante que esta no modulo certo.
SELECIONAR_MODULO := true
FAV_KEY      := "f"       ; letra do menu FAVORITOS
DOMINIO_WIN  := "ahk_exe AppController.exe"

; Pasta LOCAL do Google Drive (pra CONFERIR se o PDF salvou e repetir se falhar)
PASTA_LOCAL  := "G:\Meu Drive\Relatorios Dominio"
MAX_TENTATIVAS := 3       ; quantas vezes tenta cada empresa se o PDF nao aparecer

; Coordenadas de TELA da janela "Salvar em PDF" (abre em 0,23)
THISPC_X    := 52,   THISPC_Y    := 265
CAMPO_NOME_X:= 250,  CAMPO_NOME_Y:= 388

; Botao OK da tela "Programacao de Ferias" (gera o relatorio). Data base = hoje (padrao).
; (Fica na COLUNA DIREITA da janela; nao confundir com o campo de data, que fica ao centro.)
FERIAS_OK_X := 1475, FERIAS_OK_Y := 583

; Centro do dialogo "Sem dados para emitir !" (clique pra dar FOCO de teclado antes do Enter/OK)
SEMDADOS_X  := 1286, SEMDADOS_Y  := 796

; SELECAO DE MODULO (garante 100% que esta no modulo certo antes de rodar).
; 1) clica o logo DOMINIO (abre o menu de modulos); 2) clica o item do modulo FOLHA.
LOGO_X      := 40,   LOGO_Y      := 74     ; logo "DOMINIO" (abre menu de modulos)
MODULO_X    := 75,   MODULO_Y    := 192    ; item "Folha" no menu de modulos
T_MODULO_CARGA := 10000                    ; espera o modulo carregar (~10s)

; Favoritos: "Programacao de Ferias" e o 2o item do submenu (Down x2 -> Enter).
FAV_DOWNS   := 2

T_CURTO  := 700
T_MEDIO  := 2000
T_LONGO  := 4000
T_GERAR_PDF      := 15000
T_ENTRE_EMPRESAS := 15000
T_RENDER_TIMEOUT := 90000                  ; espera o relatorio renderizar ate 90s; senao trata como sem dados

LOGFILE := A_ScriptDir "\robo-programacao-ferias.log"

^!q::ExitApp

; ------------------------------------------------------------------- HTTP
HttpReq(metodo, rota, corpo := "") {
    global SITE_URL, AGENTE_TOKEN
    try {
        req := ComObject("WinHttp.WinHttpRequest.5.1")
        req.Open(metodo, SITE_URL . rota, false)
        req.SetTimeouts(10000, 10000, 10000, 15000)
        req.SetRequestHeader("X-Agent-Token", AGENTE_TOKEN)
        if (metodo = "POST")
            req.SetRequestHeader("Content-Type", "application/json")
        req.Send(corpo)
        return req.ResponseText
    } catch as e {
        return ""
    }
}

JsonEscape(s) {
    s := StrReplace(s, "\", "\\")
    s := StrReplace(s, '"', '\"')
    s := StrReplace(s, "`r", " ")
    s := StrReplace(s, "`n", " ")
    return s
}

; ------------------------------------------------------------------- FUNCOES
Logar(txt) {
    global LOGFILE
    try FileAppend(FormatTime(A_Now, "yyyy-MM-dd HH:mm:ss") . "  " . txt . "`n", LOGFILE)
}

; Lista as janelas do Dominio com titulo/tamanho/ativa (diagnostico).
ListarJanelasDominio() {
    s := ""
    a := WinExist("A")
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        w := 0, h := 0
        try WinGetPos(, , &w, &h, "ahk_id " . hwnd)
        s .= "{'" . WinGetTitle("ahk_id " . hwnd) . "' " . w . "x" . h . (hwnd = a ? " ATIVO" : "") . "} "
    }
    return s
}

; O dialogo "Sem dados para emitir!" (MsgBox de info, titulo "Aviso") esta aberto?
; ANTES pegava QUALQUER janelinha pequena e confundia com "Erro de sistema"/janelas
; transitorias da GERACAO -> pulava empresa COM dados. Agora exige o titulo do aviso;
; se o titulo for outro, cai no timeout do render (seguro).
DialogoSemDados() {
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        t := WinGetTitle("ahk_id " . hwnd)
        if !(InStr(t, "Aviso") || InStr(t, "Sem dados"))
            continue
        w := 0, h := 0
        try WinGetPos(, , &w, &h, "ahk_id " . hwnd)
        if (w > 60 && h > 60 && w <= 900 && h <= 600)
            return true
    }
    return false
}

; A tela de parametros "Programacao de Ferias" (janela PEQUENA com esse titulo) ainda esta aberta?
; A janela principal tambem tem "Programa" no titulo quando o relatorio abre, mas e GRANDE (filtro por tamanho).
TelaParamAberta() {
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        if !InStr(WinGetTitle("ahk_id " . hwnd), "Programa")
            continue
        w := 0, h := 0
        try WinGetPos(, , &w, &h, "ahk_id " . hwnd)
        if (w > 60 && h > 60 && w <= 900 && h <= 700)
            return true
    }
    return false
}

; Ativa a janela do APP do Dominio (a que NAO e o launcher "Lista de Programas").
AtivarApp() {
    global DOMINIO_WIN
    alvo := 0
    for hwnd in WinGetList("ahk_exe AppController.exe") {
        if !InStr(WinGetTitle("ahk_id " . hwnd), "Lista de Programas") {
            alvo := hwnd
            break
        }
    }
    if (alvo) {
        try WinActivate("ahk_id " . alvo)
    } else if WinExist(DOMINIO_WIN) {
        WinActivate(DOMINIO_WIN)
    }
}

; Launcher (app fechado / sessao caiu) esta na frente?
NoLauncher() {
    return InStr(WinGetTitle("A"), "Lista de Programas") || InStr(WinGetTitle("A"), "Dominio Web")
}

; VIGIA: fecha erros do Dominio (bug do chatbot) / Windows pelo X, nunca "Finalizar".
FecharErroSistema() {
    static ativo := false
    achou := false
    for titulo in ["Erro de sistema", "Location is not available"] {
        if WinExist(titulo) {
            WinClose(titulo)
            achou := true
        }
    }
    if (achou && !ativo) {
        Logar("AVISO: janela de erro (Dominio/Windows) apareceu - fechando pelo vigia.")
        ativo := true
    } else if (!achou) {
        ativo := false
    }
    if (achou)
        Sleep 300
}

TrocarEmpresa(codigo) {
    global T_CURTO, T_MEDIO, T_LONGO
    Send "{F8}"
    Sleep T_MEDIO
    Send "^a"
    Sleep 200
    SendText codigo
    Sleep T_MEDIO
    Send "{Enter}"
    Sleep T_LONGO
}

; Abre Favoritos > Programacao de Ferias (Alt+F -> Down x FAV_DOWNS -> Enter), com foco antes.
AbrirRelatorio() {
    global FAV_KEY, FAV_DOWNS, T_CURTO, T_MEDIO
    Click("700 400")             ; foco de teclado (streaming)
    Sleep 400
    Send "!" . FAV_KEY           ; Alt+F -> abre Favoritos
    Sleep T_MEDIO
    Loop FAV_DOWNS {
        Send "{Down}"
        Sleep T_CURTO
    }
    Send "{Enter}"
    Sleep T_MEDIO
}

; Tela "Programacao de Ferias": Data base ja vem com a data de HOJE (padrao). So clicar OK.
GerarRelatorio() {
    global FERIAS_OK_X, FERIAS_OK_Y
    Sleep 3000                                 ; espera a tela de parametros abrir/renderizar
    ; Clica OK ate a tela de parametros FECHAR de verdade (o streaming derruba clique de vez em quando).
    Loop 5 {
        Click(FERIAS_OK_X . " " . FERIAS_OK_Y) ; OK -> gera o relatorio
        Sleep 1800
        if (!TelaParamAberta())                ; fechou -> o OK pegou
            break
    }
    Sleep 5000                                 ; espera 5s a tela carregar (relatorio ou "Sem dados")
    return EsperarRender()
}

; Espera o relatorio RENDERIZAR (texto escuro na area). Retorna "ok" quando renderiza.
; Se NAO renderizar dentro do tempo, retorna "sem_dados" (cobre "Sem dados para emitir" real
; E Favoritos nao abrir a tela) -> o robo da OK/Esc e pula.
EsperarRender() {
    global T_RENDER_TIMEOUT
    inicio := A_TickCount
    while (A_TickCount - inicio < T_RENDER_TIMEOUT) {
        if (PixelSearch(&px, &py, 130, 150, 1600, 520, 0x000000, 70)) {
            Sleep 1500
            return "ok"
        }
        ; Pulo rapido: SO o dialogo "Aviso: Sem dados para emitir" (nao qualquer janelinha),
        ; e so se persistir ~1.2s e o relatorio continuar sem render.
        if (DialogoSemDados()) {
            Sleep 1200
            if (DialogoSemDados() && !PixelSearch(&px2, &py2, 130, 150, 1600, 520, 0x000000, 70)) {
                Logar("  'Sem dados' (Aviso) detectado (pulo rapido)")
                return "sem_dados"
            }
        }
        Sleep 800
    }
    Logar("  render TIMEOUT (nao renderizou em " . (T_RENDER_TIMEOUT // 1000) . "s) - janelas: " . ListarJanelasDominio())
    return "sem_dados"
}

DigitarTexto(txt) {
    for ch in StrSplit(txt) {
        SendText ch
        Sleep 80
    }
}

LimparCampoNome() {
    Send "{Home}"
    Sleep 150
    Send "+{End}"
    Sleep 150
    Send "{Del}"
    Sleep 250
}

NavegarAtePasta() {
    global THISPC_X, THISPC_Y
    Click(THISPC_X . " " . THISPC_Y)   ; "This PC" (barra esquerda)
    Sleep 4000                         ; deixa as pastas/drives carregarem
    Send "+{Tab}"                      ; foca a lista
    Sleep 4000
    SelecionarPastaPorNome("client g")
    SelecionarPastaPorNome("meu drive")
    SelecionarPastaPorNome("relatorios dominio")
}

SelecionarPastaPorNome(nome) {
    Sleep 1200
    for ch in StrSplit(nome) {
        SendText ch
        Sleep 80
    }
    Sleep 1200
    Send "{Enter}"
    Sleep 4000                         ; a pasta pode demorar a abrir
}

FecharPrevia() {
    global T_CURTO
    Loop 2 {
        Send "{Esc}"
        Sleep T_CURTO
    }
}

; Nome do arquivo: Programacao_de_Ferias_<codigo>_<DDMMAAAA de hoje>.pdf
MontarNome(codigo) {
    dataHoje := FormatTime(A_Now, "ddMMyyyy")
    bruto := "Programacao_de_Ferias_" . codigo . "_" . dataHoje
    return RegExReplace(bruto, "[^A-Za-z0-9_]", "") . ".pdf"
}

; Fecha janelas/previas abertas SO com Esc. NAO usa Ctrl+F4: quando nao ha janela
; interna aberta (ex.: logo apos abrir o modulo), o Ctrl+F4 fecha o Dominio inteiro.
LimparTelas() {
    global T_CURTO
    FecharErroSistema()
    Loop 6 {
        Send "{Esc}"
        Sleep T_CURTO
        FecharErroSistema()
    }
}

; Garante o modulo Folha. Clica o logo DOMINIO (abre o menu) e o item Folha.
SelecionarModulo() {
    global LOGO_X, LOGO_Y, MODULO_X, MODULO_Y, T_MODULO_CARGA, T_MEDIO
    FecharErroSistema()
    Click(LOGO_X . " " . LOGO_Y)      ; logo DOMINIO -> abre o menu de modulos
    Sleep T_MEDIO
    Click(MODULO_X . " " . MODULO_Y)  ; clica no modulo (Folha)
    Sleep T_MODULO_CARGA              ; espera carregar (~10s)
    FecharErroSistema()
}

ProcessarEmpresa(codigo) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, CAMPO_NOME_X, CAMPO_NOME_Y, SEMDADOS_X, SEMDADOS_Y
    Logar("Empresa " . codigo . ": iniciando")
    FecharErroSistema()
    Sleep 500
    LimparTelas()
    Click("700 400")                 ; foco de teclado (streaming)
    Sleep 500
    Logar("  [1] apos LimparTelas+foco: " . ListarJanelasDominio())
    TrocarEmpresa(codigo)
    Logar("  [2] apos F8/troca empresa: " . ListarJanelasDominio())
    AbrirRelatorio()
    Logar("  [3] apos Favoritos/Programacao de Ferias: " . ListarJanelasDominio())
    st := GerarRelatorio()
    Logar("  [4] apos gerar: " . st)
    if (st != "ok") {
        ; "Sem dados para emitir" OU Favoritos nao abriu a tela.
        ; Streaming: a tecla so pega com FOCO -> clica no dialogo antes do Enter (OK).
        Logar("Empresa " . codigo . ": sem relatorio (" . st . ") - OK/Esc e proxima")
        Click(SEMDADOS_X . " " . SEMDADOS_Y)   ; foca o dialogo (streaming: tecla so pega com foco)
        Sleep 600
        Send "{Enter}"                          ; OK no "Sem dados para emitir!"
        Sleep 5000                              ; espera 5s
        Send "{Esc}"
        Sleep T_CURTO
        Send "{Esc}"                            ; Esc x2
        Sleep 3000                              ; segue pra proxima empresa
        return "pular"
    }
    ; --- Salvar em PDF ---
    ; Relatorios GRANDES demoram pra terminar de desenhar: espera antes de mandar o Ctrl+D.
    Sleep 8000
    Click("700 260")
    Sleep T_CURTO
    Send "^d"
    ; ESPERA a janela "Salvar em PDF" abrir DE VERDADE (relatorio grande gera o PDF e demora ate ~30s).
    ini := A_TickCount
    while (!WinExist("Salvar em PDF") && (A_TickCount - ini) < 30000)
        Sleep 500
    if !WinExist("Salvar em PDF") {   ; nao abriu -> pode ser erro de caminho: OK e espera de novo
        Send "{Enter}"
        Sleep 5000
        ini := A_TickCount
        while (!WinExist("Salvar em PDF") && (A_TickCount - ini) < 20000)
            Sleep 500
    }
    Sleep 4000                        ; folga pra a lista de "This PC" carregar antes de navegar
    NavegarAtePasta()
    Sleep T_MEDIO
    try WinActivate("Salvar em PDF")
    Sleep 500
    MouseMove(CAMPO_NOME_X, CAMPO_NOME_Y)
    Sleep 400
    Click(CAMPO_NOME_X . " " . CAMPO_NOME_Y)
    Sleep 500
    Click(CAMPO_NOME_X . " " . CAMPO_NOME_Y)
    Sleep 500
    LimparCampoNome()
    DigitarTexto(MontarNome(codigo))
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_CURTO
    Send "{Enter}"
    Sleep T_GERAR_PDF
    FecharPrevia()
    Logar("Empresa " . codigo . ": fluxo concluido")
    return "ok"
}

; Roda a empresa e CONFIRMA que o PDF apareceu no Google Drive local. Se nao aparecer,
; reseta e REPETE ate MAX_TENTATIVAS. "pular" (sem dados) nao repete.
ProcessarEmpresaVerificado(codigo) {
    global PASTA_LOCAL, MAX_TENTATIVAS, T_MEDIO
    caminho := PASTA_LOCAL . "\" . MontarNome(codigo)
    Loop MAX_TENTATIVAS {
        try FileDelete(caminho)
        st := ProcessarEmpresa(codigo)
        if (st = "pular") {
            Logar("Empresa " . codigo . ": pulada (sem dados / tela nao abriu)")
            return "pular"
        }
        inicio := A_TickCount
        while (A_TickCount - inicio < 60000) {
            if (FileExist(caminho)) {
                Logar("Empresa " . codigo . ": PDF confirmado (tentativa " . A_Index . ")")
                return "ok"
            }
            Sleep 2000
        }
        ; Diagnostico: lista o que TEM na pasta com esse codigo (nome/pasta errado ou nao salvou?).
        naPasta := ""
        try {
            Loop Files, PASTA_LOCAL . "\*_" . codigo . "_*.pdf"
                naPasta .= A_LoopFileName . "; "
        }
        Logar("Empresa " . codigo . ": PDF NAO apareceu (tentativa " . A_Index . "/" . MAX_TENTATIVAS . ") - esperava '" . MontarNome(codigo) . "' - na pasta c/ codigo: " . (naPasta != "" ? naPasta : "(nenhum)"))
        LimparTelas()
        Sleep T_MEDIO
    }
    Logar("Empresa " . codigo . ": FALHOU apos " . MAX_TENTATIVAS . " tentativas")
    return "falhou"
}

; ------------------------------------------------------------- SITE (comandos)
; Extrai o valor numerico de uma chave do JSON: "chave":123
ExtrairNum(body, chave) {
    if RegExMatch(body, '"' . chave . '":(\d+)', &m)
        return Integer(m[1])
    return 0
}

; Atualiza os tempos (T_CURTO, T_MEDIO etc.) com o que a tela mandou no /ferias-comando — assim da pra
; editar esses tempos no site (Configuracoes) sem precisar baixar o robo de novo. Se a chave nao vier
; no JSON (robo antigo/site antigo), mantem o valor atual (fallback dos defaults la em cima).
AtualizarTempos(body) {
    global T_CURTO, T_MEDIO, T_LONGO, T_GERAR_PDF, T_ENTRE_EMPRESAS, T_RENDER_TIMEOUT, T_MODULO_CARGA
    v := ExtrairNum(body, "tCurtoMs")
    if (v > 0)
        T_CURTO := v
    v := ExtrairNum(body, "tMedioMs")
    if (v > 0)
        T_MEDIO := v
    v := ExtrairNum(body, "tLongoMs")
    if (v > 0)
        T_LONGO := v
    v := ExtrairNum(body, "tGerarPdfMs")
    if (v > 0)
        T_GERAR_PDF := v
    v := ExtrairNum(body, "tEntreEmpresasMs")
    if (v > 0)
        T_ENTRE_EMPRESAS := v
    v := ExtrairNum(body, "tRenderTimeoutMs")
    if (v > 0)
        T_RENDER_TIMEOUT := v
    v := ExtrairNum(body, "tModuloCargaMs")
    if (v > 0)
        T_MODULO_CARGA := v
}

DevePararSite() {
    body := HttpReq("GET", "/api/dominio-agent/ferias-comando")
    return InStr(body, '"parar":true') ? true : false
}

ReportarProgresso(rodando, total, feitas, atual, iniciando) {
    atualJson := atual != "" ? '"' . JsonEscape(atual) . '"' : "null"
    json := '{"rodando":' . (rodando ? "true" : "false") . ',"total":' . total . ',"feitas":' . feitas
          . ',"atual":' . atualJson . ',"iniciando":' . (iniciando ? "true" : "false") . "}"
    HttpReq("POST", "/api/dominio-agent/ferias-progresso", json)
}

PegarEmpresas() {
    body := HttpReq("GET", "/api/dominio-agent/empresas-ferias")
    lista := []
    pos := 1
    pat := '"codigoDominio":"([^"]*)","nome":"([^"]*)"'
    while (pos := RegExMatch(body, pat, &m, pos)) {
        lista.Push({ codigo: m[1], nome: m[2] })
        pos += StrLen(m[0])
    }
    return lista
}

ReportarStatus(itens) {
    if (itens.Length = 0)
        return
    partes := []
    for it in itens {
        erroJson := it.HasOwnProp("erro") && it.erro != "" ? ',"erro":"' . JsonEscape(it.erro) . '"' : ""
        partes.Push('{"codigoDominio":"' . it.codigo . '","ok":' . (it.ok ? "true" : "false") . erroJson . "}")
    }
    s := ""
    for i, v in partes
        s .= (i > 1 ? "," : "") . v
    HttpReq("POST", "/api/dominio-agent/ferias-status", '{"itens":[' . s . "]}")
}

RodarCiclo() {
    global DOMINIO_WIN, T_ENTRE_EMPRESAS, SELECIONAR_MODULO
    empresas := PegarEmpresas()
    total := empresas.Length
    Logar("=== EXECUCAO: " . total . " empresa(s) (Programacao de Ferias) ===")
    ReportarProgresso(true, total, 0, "", true)
    if (total = 0) {
        ReportarProgresso(false, 0, 0, "", false)
        return
    }
    if !WinExist(DOMINIO_WIN) {
        Logar("ERRO: Dominio nao esta aberto - execucao cancelada.")
        ReportarProgresso(false, total, 0, "", false)
        return
    }
    AtivarApp()
    Sleep 1500
    Logar("Janelas: " . ListarJanelasDominio())
    if NoLauncher() {
        Logar("ERRO: Dominio no launcher (Lista de Programas) - app nao esta aberto. Cancelado.")
        ReportarProgresso(false, total, 0, "", false)
        return
    }
    if (SELECIONAR_MODULO) {
        Logar("Selecionando modulo Folha...")
        SelecionarModulo()
    }
    FecharErroSistema()
    resultados := []
    feitas := 0
    for e in empresas {
        if (DevePararSite()) {
            Logar("=== PARADO pelo site (freio de emergencia) apos " . feitas . "/" . total . " ===")
            break
        }
        if (feitas > 0)
            Sleep T_ENTRE_EMPRESAS
        ReportarProgresso(true, total, feitas, e.codigo . " - " . e.nome, false)
        res := "falhou"
        try {
            res := ProcessarEmpresaVerificado(e.codigo)
        } catch as err {
            Logar("Empresa " . e.codigo . ": ERRO " . err.Message)
        }
        if (res = "ok")
            resultados.Push({ codigo: e.codigo, ok: true })
        else if (res = "pular")
            resultados.Push({ codigo: e.codigo, ok: false, erro: "Sem dados / tela nao abriu - pulada" })
        else
            resultados.Push({ codigo: e.codigo, ok: false, erro: "PDF nao confirmado apos as tentativas" })
        feitas++
        ReportarProgresso(true, total, feitas, "", false)
    }
    ReportarStatus(resultados)
    ReportarProgresso(false, total, feitas, "", false)
    Logar("=== EXECUCAO concluida (" . feitas . "/" . total . ") ===")
}

; ==================================================================== MAIN
Logar("=== Agente iniciado ===")
SetTimer(FecharErroSistema, 400)
OnExit(AoSair)
AoSair(*) {
    try ReportarProgresso(false, 0, 0, "", false)
}

Loop {
    body := HttpReq("GET", "/api/dominio-agent/ferias-comando")
    AtualizarTempos(body)
    if (InStr(body, '"deveRodar":true')) {
        RodarCiclo()
    }
    Sleep POLL_SEGUNDOS * 1000
}
