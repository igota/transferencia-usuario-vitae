// vitae.js - Versão OTIMIZADA COM .env (login via HTTP + restante via Puppeteer)

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

// 🔥 VARIÁVEIS QUE SERÃO CARREGADAS DO .env
let VITAE_URL = null;
let VITAE_USERNAME = null;
let VITAE_PASSWORD = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Armazena sessões ativas por usuário
const sessions = new Map();
const modalReadyPromises = new Map();

// Cache de unidades
let unidadesCache = null;

// Códigos enviados por usuário
const codigosEnviados = new Map();

// 🔥 TRANSPORTER E CONFIG
let transporter = null;
let config = null;

// ==================== CONSTANTES DE ESPECIALIDADE ====================
const XPATH_ABA_ESPECIALIDADE = '//*[@id="formulario:viewCadastro:abaEspec_lbl"]';

// ==================== CAPTURAR DADOS DA ESPECIALIDADE ====================
async function capturarDadosEspecialidade(page) {
    console.log("🔍 Capturando dados da Especialidade...");

    try {
        // 1. Clica na aba "Especialidade" para abrir
        await clicar(page, XPATH_ABA_ESPECIALIDADE);
        await sleep(500);

        // 2. Aguarda a tabela carregar
        try {
            await page.waitForSelector('table[id*="tblDataEspecialidade"]', { timeout: 5000 });
            console.log("   ✅ Tabela de Especialidade carregada");
        } catch (error) {
            console.log("   ⚠️ Tabela de Especialidade não encontrada (pode estar vazia)");
            return null;
        }

        // 3. Captura TODAS as linhas da tabela
        const especialidades = await page.evaluate(() => {
            const tabela = document.querySelector('table[id*="tblDataEspecialidade"]');
            if (!tabela) return [];

            const linhas = tabela.querySelectorAll('tr[class*="rich-table-row"]');
            const resultados = [];

            linhas.forEach((linha, index) => {
                try {
                    const cols = linha.querySelectorAll('td');
                    if (cols.length >= 3) {
                        const nome = cols[0]?.textContent?.trim() || 'Não informado';
                        const atendeAmbulatorio = cols[1]?.textContent?.trim() || 'Não informado';
                        const ativo = cols[2]?.textContent?.trim() || 'Não informado';

                        resultados.push({
                            especialidade: nome,
                            atendeAmbulatorio: atendeAmbulatorio,
                            ativo: ativo
                        });
                    }
                } catch (e) {
                    console.log(`   ⚠️ Erro ao capturar linha ${index}: ${e.message}`);
                }
            });

            return resultados;
        });

        if (!especialidades || especialidades.length === 0) {
            console.log("   ⚠️ Nenhuma especialidade encontrada");
            return null;
        }

        console.log(`   📋 Total de especialidades: ${especialidades.length}`);
        especialidades.forEach((esp, i) => {
            console.log(`      ${i+1}. ${esp.especialidade} | Ambulatório: ${esp.atendeAmbulatorio} | Ativo: ${esp.ativo}`);
        });

        return especialidades;

    } catch (error) {
        console.log(`   ❌ Erro ao capturar especialidade: ${error.message}`);
        return null;
    }
}

const XPATH_SELECT_ESPECIALIDADE = '//*[@id="tabelaEspecialidades"]/tbody/tr[1]/td[2]/select';

// Busca todas as especialidades disponíveis no select
async function buscarEspecialidadesDisponiveis(page) {
    console.log("🔍 Buscando especialidades disponíveis...");

    try {
        // page.waitForSelector/document.querySelector só aceitam CSS, não XPath - por isso
        // usamos waitForFunction + document.evaluate, igual ao resto do arquivo (ex: capturarOpcoesSelect)
        await page.waitForFunction((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return result.singleNodeValue !== null;
        }, { timeout: 5000 }, XPATH_SELECT_ESPECIALIDADE);

        const dados = await capturarOpcoesSelect(page, XPATH_SELECT_ESPECIALIDADE);
        const opcoes = dados ? dados.opcoes.filter(o => o.valor !== '') : [];

        console.log(`   📋 ${opcoes.length} especialidades disponíveis`);
        return opcoes;
    } catch (error) {
        console.log(`   ❌ Erro ao buscar especialidades: ${error.message}`);
        return [];
    }
}

// Adiciona uma especialidade ao usuário
async function adicionarEspecialidade(page, especialidadeValor, fazAmbulatorio) {
    console.log(`➕ Adicionando especialidade: ${especialidadeValor} | Ambulatório: ${fazAmbulatorio}`);

    try {
        // 1. Seleciona a especialidade no dropdown
        const selectXPath = XPATH_SELECT_ESPECIALIDADE;
        await page.evaluate((xpath, valor) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const select = result.singleNodeValue;
            if (select) {
                select.value = valor;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, selectXPath, especialidadeValor);
        await sleep(300);

        // 2. Seleciona o radio de Ambulatório (SIM ou NÃO)
        const radioXPath = fazAmbulatorio === 'SIM'
            ? '//*[@id="formulario:viewCadastro:j_id219:0"]'  // SIM
            : '//*[@id="formulario:viewCadastro:j_id219:1"]'; // NÃO

        await clicar(page, radioXPath);
        await sleep(300);

        // 3. Marca como ATIVO (sempre SIM)
        await clicar(page, '//*[@id="formulario:viewCadastro:j_id225:0"]');
        await sleep(300);

        // 4. Clica em "Adicionar"
        await clicar(page, '//*[@id="formulario:viewCadastro:adicionar"]');
        await sleep(500);

        console.log("   ✅ Especialidade adicionada!");
        return true;

    } catch (error) {
        console.log(`   ❌ Erro ao adicionar especialidade: ${error.message}`);
        return false;
    }
}

// Exclui a especialidade de uma linha da tabela (rowIndex é a posição 0-based, igual à ordem
// retornada por capturarDadosEspecialidade). Só remove a linha na tela - ainda é preciso
// chamar salvarAlteracoesEspecialidade depois para persistir, igual ao fluxo de adicionar.
async function excluirEspecialidade(page, rowIndex) {
    console.log(`🗑️ Excluindo especialidade da linha ${rowIndex}...`);

    // O clique no botão excluir dispara um confirm() NATIVO do navegador (não é um elemento do
    // DOM, então clicar()/document.evaluate não alcançam) - precisa ser aceito via page.on('dialog'),
    // registrado antes do clique para não perder o evento.
    const aceitarDialogo = async (dialog) => {
        console.log(`   ℹ️ Confirmando diálogo nativo: "${dialog.message()}"`);
        await dialog.accept();
    };

    try {
        page.once('dialog', aceitarDialogo);

        const xpathBotao = `//*[@id="formulario:viewCadastro:tblDataEspecialidade:${rowIndex}:j_id251"]`;
        await clicar(page, xpathBotao);

        // O processamento da exclusão é via AJAX depois do confirm() nativo - a linha continua
        // na tabela até salvar, mas o botão de excluir dessa linha desaparece quando o AJAX
        // termina. Um sleep fixo arrisca clicar em "Alterar" antes disso, salvando o estado
        // antigo - por isso espera ativamente o botão desaparecer em vez de um tempo fixo.
        try {
            await page.waitForFunction((xpath) => {
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                return result.singleNodeValue === null;
            }, { timeout: 8000 }, xpathBotao);
            console.log("   ✅ Botão de excluir removido (exclusão processada)");
        } catch (e) {
            console.log("   ⚠️ Botão de excluir ainda presente após espera - seguindo mesmo assim");
        }

        await sleep(300);

        console.log("   ✅ Especialidade removida da tela!");
        return true;

    } catch (error) {
        console.log(`   ❌ Erro ao excluir especialidade: ${error.message}`);
        return false;
    } finally {
        page.off('dialog', aceitarDialogo);
    }
}

const XPATH_ABA_GRUPOS = '//*[@id="formulario:viewCadastro:j_id205_lbl"]';
const XPATH_TBODY_GRUPOS = '//*[@id="formulario:viewCadastro:picktltbody"]';
const XPATH_ABA_USUARIOS = '//*[@id="formulario:viewCadastro:j_id88_lbl"]';
const XPATH_GRUPO_CONSULTA_ITEM = '//*[@id="formulario:viewCadastro:pick:source::62"]/td';
// RichFaces (rich:listShuttle) renderiza DOIS elementos gêmeos para o botão de "copiar
// selecionado(s)": "pickdiscopy" (desabilitado, visível quando nada está selecionado) e "pickcopy"
// (habilitado, visível só depois de selecionar um item na lista de origem) - só um dos dois fica
// com display diferente de "none" por vez. É o "pickcopy" que precisa ser clicado.
const XPATH_BOTAO_ADICIONAR_GRUPO = '//*[@id="formulario:viewCadastro:pickcopy"]/div/div/img';
const XPATH_CONTAINER_BOTAO_ADICIONAR_GRUPO = '//*[@id="formulario:viewCadastro:pickcopy"]';

// Seleciona um item da lista de grupos disponíveis (pela aba Grupos) e move pra lista do usuário,
// confirmando de fato que o grupo apareceu antes de retornar - usada para garantir o grupo
// CONSULTA (obrigatório pra salvar Entidade/Setor, ver alterarEntidadeSetor). clicar() nunca lança
// erro quando o xpath não casa com nada (só não faz nada), por isso aqui checamos explicitamente a
// existência do item antes de clicar.
async function adicionarGrupo(page, xpathItem, nomeGrupo) {
    console.log(`➕ Adicionando grupo ${nomeGrupo}...`);

    await clicar(page, XPATH_ABA_GRUPOS);
    await sleep(800);

    const itemExiste = await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue !== null;
    }, xpathItem);

    if (!itemExiste) {
        throw new Error(`Item "${nomeGrupo}" não encontrado na lista de grupos disponíveis do usuário`);
    }

    // clicarReal (não clicar): o rich:listShuttle (RichFaces 3.3.2) aplica a classe de destaque
    // com um clique sintético, mas só habilita os botões do shuttle com um evento de mouse real.
    await clicarReal(page, xpathItem);

    // O "pickcopy" só fica visível depois que o RichFaces confirma a seleção via AJAX (troca de
    // lugar com o "pickdiscopy" desabilitado). Clicar antes disso clicaria num elemento escondido
    // (display:none), então espera ativamente ele aparecer em vez de um sleep fixo.
    try {
        await page.waitForFunction((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const container = result.singleNodeValue;
            return !!container && window.getComputedStyle(container).display !== 'none';
        }, { timeout: 5000 }, XPATH_CONTAINER_BOTAO_ADICIONAR_GRUPO);
    } catch (e) {
        throw new Error(`Botão de adicionar grupo (pickcopy) não apareceu após selecionar "${nomeGrupo}"`);
    }

    await clicarReal(page, XPATH_BOTAO_ADICIONAR_GRUPO);

    // Espera ativamente o grupo aparecer na lista do usuário em vez de confiar num sleep fixo,
    // já que a atualização da tabela é via AJAX e o tempo de resposta varia.
    try {
        await page.waitForFunction((xpath, nome) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const tbody = result.singleNodeValue;
            return !!tbody && tbody.textContent.toUpperCase().includes(nome.toUpperCase());
        }, { timeout: 8000 }, XPATH_TBODY_GRUPOS, nomeGrupo);
    } catch (e) {
        throw new Error(`Grupo ${nomeGrupo} não apareceu na lista do usuário após tentar adicionar`);
    }

    console.log(`   ✅ Grupo ${nomeGrupo} adicionado e confirmado`);
}

// O VITAE recusa o "Alterar" da Entidade/Setor se o usuário não tiver nenhum grupo, o que
// acontece em alguns cadastros ao transferir para o HOSPITAL REGIONAL NORTE - por isso o alvo
// da transferência sempre ganha o grupo CONSULTA antes de salvar (ver alterarEntidadeSetor).
async function adicionarGrupoConsulta(page) {
    return adicionarGrupo(page, XPATH_GRUPO_CONSULTA_ITEM, 'CONSULTA');
}

// Captura os grupos em que o usuário está inserido, lendo todas as linhas do tbody da lista de
// uma vez. Igual à Especialidade, precisa clicar na aba "Grupos" antes da lista carregar completa.
async function capturarGruposUsuario(page) {
    console.log("🔍 Capturando grupos do usuário...");

    try {
        await clicar(page, XPATH_ABA_GRUPOS);
        await sleep(800);

        const grupos = await page.evaluate((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const tbody = result.singleNodeValue;
            if (!tbody) return [];

            const resultados = [];
            tbody.querySelectorAll('tr').forEach((linha) => {
                const td = linha.querySelector('td');
                const texto = (td || linha).textContent.trim();
                if (texto) resultados.push(texto);
            });
            return resultados;
        }, XPATH_TBODY_GRUPOS);

        console.log(`   📋 ${grupos.length} grupo(s) encontrado(s)`);

        // Volta pra aba "Usuários" (padrão do cadastro) antes de devolver o controle - deixar o
        // modal parado na aba Grupos parece interferir quando uma busca seguinte tenta reabrir
        // o menu Usuários com esse modal ainda aberto numa aba diferente da padrão.
        await clicar(page, XPATH_ABA_USUARIOS);
        await sleep(300);

        return grupos;
    } catch (error) {
        console.log(`   ❌ Erro ao capturar grupos: ${error.message}`);
        return [];
    }
}

function setTransporter(mailTransporter, appConfig) {
    transporter = mailTransporter;
    config = appConfig;

    console.log('🔍 VITAE: Recebendo configurações...');
    console.log('🔍 Config recebido:', config ? 'SIM' : 'NÃO');

    // Carrega as configurações do VITAE do .env
    if (config && config.vitae) {
        VITAE_URL = config.vitae.url;
        VITAE_USERNAME = config.vitae.username;
        VITAE_PASSWORD = config.vitae.password;
        console.log('✅ VITAE: Configurações carregadas do .env');
        console.log(`   URL: ${VITAE_URL}`);
        console.log(`   Usuário: ${VITAE_USERNAME}`);
        console.log(`   Senha: ${'*'.repeat(VITAE_PASSWORD?.length || 0)}`);
    } else {
        console.error('❌ VITAE: Configurações não encontradas no .env');
        console.error('   Conteúdo do config:', JSON.stringify(config, null, 2));

        console.log('⚠️ Usando valores FALLBACK para VITAE');
    }

    console.log('✅ VITAE: Transporter configurado');
}

// Função para enviar código por email
async function enviarCodigoEmailVitae(email, codigo, nome) {
    if (!transporter) {
        console.error('❌ Transporter não configurado');
        return false;
    }

    console.log(`📧 Tentando enviar email para: ${email}`);

    const mailOptions = {
        from: `"Suporte TI - Alteração de Email" <${config?.email?.user || 'no-reply@localhost'}>`,
        to: email,
        subject: '🔐 Código de Verificação - Alteração de Email VITAE',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #667eea;">🔐 Código de Verificação</h2>
                <p>Olá <strong>${nome}</strong>,</p>
                <p>Recebemos uma solicitação para alterar seu email no sistema <strong>VITAE</strong>.</p>
                <p>Utilize o código abaixo para confirmar a operação:</p>
                <div style="background-color: #f0f4ff; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; border-radius: 10px; margin: 20px 0;">
                    ${codigo}
                </div>
                <p>Este código é válido por <strong>10 minutos</strong>.</p>
                <p>Se você não solicitou esta alteração, ignore este e-mail.</p>
                <hr style="margin: 20px 0;">
                <p style="color: #888; font-size: 12px;">⚠️ Mantenha este código em segurança. Não compartilhe com ninguém.</p>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`✅ Email enviado com sucesso para ${email}`);
        return true;
    } catch (error) {
        console.error(`❌ Erro ao enviar email: ${error.message}`);
        return false;
    }
}

function extrairViewStateLogin(html) {
    const m = html.match(/name="javax\.faces\.ViewState"\s+id="javax\.faces\.ViewState"\s+value="([^"]*)"/)
        || html.match(/javax\.faces\.ViewState[^>]*value="([^"]*)"/);
    return m ? m[1] : null;
}

function logadoComSucessoHttp(html) {
    return html.includes('iconmenuPrincipal') && !html.includes('funcaoclickForm:login');
}

// Valida login (apenas verificação de credenciais) contra o sistema PacienteHRN,
// usado exclusivamente pela tela web - não afeta o fluxo de automação do Vitae principal
async function validarLoginPacienteHRN(loginUrl, username, password) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        validateStatus: () => true,
        maxRedirects: 0
    }));

    const getResp = await client.get(loginUrl);
    const viewState = extrairViewStateLogin(getResp.data) || 'j_id1';

    const host = new URL(loginUrl).host;

    const form = new URLSearchParams({
        'formulario': 'formulario',
        'login': username.toUpperCase(),
        'xyb-ac': password,
        'formulario:botaoLogin': 'confirmar',
        'formulario:host': host,
        'javax.faces.ViewState': viewState
    });

    const postResp = await client.post(loginUrl, form.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': loginUrl,
            'Origin': `${new URL(loginUrl).protocol}//${host}`
        }
    });

    const location = postResp.headers['location'] || '';
    if (postResp.status === 302 && location.includes('paginaPrincipal.jsf')) {
        return { sucesso: true };
    }

    return { sucesso: false, erro: 'Usuário ou Senha incorretos!' };
}

// Faz login via HTTP puro e retorna os cookies no formato aceito por page.setCookie() do Puppeteer
async function loginHttp(vitaeUrl, username, password) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        validateStatus: () => true
    }));

    const loginUrl = `${vitaeUrl}/seguranca/login.jsf`;

    const getResp = await client.get(loginUrl);
    const viewState = extrairViewStateLogin(getResp.data);

    if (!viewState) {
        return { sucesso: false, erro: 'ViewState não encontrado na página de login' };
    }

    const form = new URLSearchParams({
        'funcaoclickForm': 'funcaoclickForm',
        'funcaoclickForm:login': username.toUpperCase(),
        'funcaoclickForm:funcaoclick': password.toUpperCase(),
        'funcaoclickForm:logar': 'Confirmar',
        'javax.faces.ViewState': viewState
    });

    const postResp = await client.post(loginUrl, form.toString(), {
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': loginUrl,
            'Origin': vitaeUrl
        }
    });

    if (!logadoComSucessoHttp(postResp.data)) {
        return { sucesso: false, erro: 'Credenciais inválidas ou estrutura de página inesperada' };
    }

    const domain = new URL(vitaeUrl).hostname;
    const cookiesJar = await jar.getCookies(`${vitaeUrl}/seguranca/`);

    const cookiesPuppeteer = cookiesJar.map(c => ({
        name: c.key,
        value: c.value,
        domain,
        path: '/seguranca/'
    }));

    return { sucesso: true, cookies: cookiesPuppeteer };
}

// Clique "de verdade" via Puppeteer (mousedown+mouseup+click nas coordenadas reais do elemento),
// diferente de clicar() que só dispara um evento 'click' sintético via elemento.click(). Necessário
// para o picklist de Grupos (RichFaces 3.3.2/rich:listShuttle): a seleção de item visualmente
// "pega" com o clique sintético (aplica a classe de destaque via onclick), mas a lógica interna
// que habilita os botões do shuttle não dispara sem um evento de mouse real.
async function clicarReal(page, xpath) {
    try {
        const box = await page.evaluate((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const elemento = result.singleNodeValue;
            if (!elemento) return null;
            elemento.scrollIntoView({ block: 'center' });
            const rect = elemento.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }, xpath);

        if (!box) return false;

        await page.mouse.click(box.x, box.y);
        await sleep(200);
        return true;
    } catch (error) {
        console.log(`   ⚠️ Erro ao clicar (mouse real): ${error.message}`);
        return false;
    }
}

async function clicar(page, xpath) {
    try {
        await page.evaluate((xpath) => {
            const result = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            const elemento = result.singleNodeValue;
            if (elemento) {
                elemento.scrollIntoView({ block: 'center' });
                elemento.click();
            }
        }, xpath);
        await sleep(200);
        return true;
    } catch (error) {
        console.log(`   ⚠️ Erro ao clicar: ${error.message}`);
        return false;
    }
}

async function extrairTexto(page, xpath) {
    try {
        const texto = await page.evaluate((xpath) => {
            const result = document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            const elemento = result.singleNodeValue;
            return elemento ? elemento.textContent.trim() : null;
        }, xpath);
        return texto;
    } catch (e) {
        return null;
    }
}

// Função para iniciar navegador (APENAS ABRE A LISTAGEM)
async function iniciarNavegador(from, username, password) {
    console.log(`🚀 Iniciando navegador para: ${from}`);

    // Usa as credenciais informadas (ex: usuário logado na aplicação web) ou,
    // por compatibilidade, as credenciais padrão carregadas do .env
    const usuarioLogin = username || VITAE_USERNAME;
    const senhaLogin = password || VITAE_PASSWORD;

    // 🔥 VERIFICA SE AS CONFIGURAÇÕES FORAM CARREGADAS
    if (!VITAE_URL || !usuarioLogin || !senhaLogin) {
        console.error('❌ VITAE: Configurações não carregadas. Verifique o .env');
        return false;
    }

    if (sessions.has(from)) {
        console.log(`   ℹ️ Sessão já existe para: ${from}`);
        return true;
    }

    const browser = await puppeteer.launch({
        headless: config?.whatsapp?.headless ?? true,
        args: config?.whatsapp?.args ?? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    try {
        console.log('🔐 Login via HTTP (sem Puppeteer)...');
        const resultadoLogin = await loginHttp(VITAE_URL, usuarioLogin, senhaLogin);

        if (!resultadoLogin.sucesso) {
            console.log(`❌ Falha no login HTTP: ${resultadoLogin.erro}`);
            await browser.close();
            return false;
        }

        console.log('✅ Login HTTP confirmado, injetando cookies de sessão no navegador...');
        await page.setCookie(...resultadoLogin.cookies);

        await page.goto(`${VITAE_URL}/seguranca/principal.jsf`, { waitUntil: 'networkidle2' });

        await page.waitForSelector('[id*="iconmenuPrincipal"]', { timeout: 15000 });
        console.log('✅ Sessão confirmada no navegador!');

        console.log('📂 Abrindo menu Usuários...');
        await clicar(page, '//*[@id="iconmenuPrincipal:j_id15:j_id28"]');
        await sleep(1000);

        await page.waitForSelector('input[id*="cpf2"]', { timeout: 10000 });

        sessions.set(from, {
            browser,
            page,
            step: 'AGUARDANDO_CPF',
            username: usuarioLogin,
            password: senhaLogin
        });

        console.log(`✅ Navegador iniciado, aguardando usuário enviar CPF...`);
        return true;

    } catch (error) {
        console.log(`❌ Erro ao iniciar navegador: ${error.message}`);
        await browser.close();
        return false;
    }
}

const XPATH_LOGIN = '//input[@name="formulario:viewBusca:j_id66"]';
const XPATH_NOME = '//input[@name="formulario:viewBusca:j_id68"]';
const XPATH_CPF = '//*[@id="formulario:viewBusca:cpf2"]';
const XPATH_ENTIDADE = "//*[@id='formulario:viewCadastro:j_id88']/table/tbody/tr/td/table/tbody/tr[4]/td[2]/select";
const XPATH_SETOR = "//*[@id='formulario:viewCadastro:pgSetor']/select";

async function digitarPorXpath(page, xpath, texto) {
    await page.evaluate((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const input = result.singleNodeValue;
        if (input) input.value = '';
    }, xpath);
    await sleep(100);

    const handle = await page.evaluateHandle((xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    }, xpath);

    const elemento = handle.asElement();
    if (!elemento) throw new Error(`Campo não encontrado para o xpath: ${xpath}`);

    await elemento.type(texto, { delay: 50 });
}

// Limpa os campos de pesquisa (CPF, Login, Nome) e preenche apenas o campo do tipo escolhido
async function preencherCampoPesquisa(page, tipo, valor) {
    await page.evaluate((xpaths) => {
        xpaths.forEach((xpath) => {
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const el = result.singleNodeValue;
            if (el) el.value = '';
        });
    }, [XPATH_CPF, XPATH_LOGIN, XPATH_NOME]);
    await sleep(200);

    let xpath;
    let valorFinal = valor;
    if (tipo === 'login') {
        xpath = XPATH_LOGIN;
        valorFinal = valor.toUpperCase();
    } else if (tipo === 'nome') {
        xpath = XPATH_NOME;
        valorFinal = valor.toUpperCase();
    } else {
        xpath = XPATH_CPF;
        valorFinal = `${valor.slice(0,3)}.${valor.slice(3,6)}.${valor.slice(6,9)}-${valor.slice(9)}`;
    }

    await digitarPorXpath(page, xpath, valorFinal);

    // O rádio "Todos" (valor vazio) não retorna resultados ao filtrar por Login/Nome -
    // é necessário marcar explicitamente "Ativo" (value="S"). Mantemos "Todos" na busca por
    // CPF para preservar a detecção de usuário INATIVO (CASO 1/CASO 2) - via Login/Nome essa
    // detecção não é alcançável, pois usuários INATIVOS somem do resultado com o filtro "Ativo".
    if (tipo === 'login' || tipo === 'nome') {
        await page.evaluate(() => {
            const radioAtivo = document.querySelector('input[id="formulario:viewBusca:j_id80:1"]');
            if (radioAtivo) radioAtivo.click();
        });
    }

    await sleep(300);
}

// Define o valor de um <select> pelo xpath e dispara o evento change (necessário para a
// AJAX da RichFaces repopular o select de Setor quando a Entidade é alterada)
async function definirSelectPorXpath(page, xpath, valor) {
    return page.evaluate((xpath, valor) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const select = result.singleNodeValue;
        if (!select) return false;
        select.value = valor;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, xpath, valor);
}

// Confirma a alteração preenchendo o modal de senha que aparece após clicar em "Alterar"
async function confirmarAlteracaoComSenha(page, password) {
    await clicar(page, '//input[contains(@id,"alterar")]');
    await sleep(300);

    await page.waitForSelector('input[id*="senhaModal"]', { timeout: 10000 });

    await page.evaluate((password) => {
        const senhaInput = document.querySelector('input[id*="senhaModal"]');
        if (senhaInput) senhaInput.value = password;
    }, password || VITAE_PASSWORD);

    await sleep(300);

    await clicar(page, '//*[@id="formulario:formModalAlte:logar"]');
    await sleep(1500);
}

// Salva/confirma as alterações de especialidade - reaproveita confirmarAlteracaoComSenha porque
// o botão "Alterar" aqui abre o mesmo modal de senha usado no resto do cadastro.
async function salvarAlteracoesEspecialidade(page, password) {
    console.log("💾 Salvando alterações...");

    try {
        await confirmarAlteracaoComSenha(page, password);

        const sucesso = await page.evaluate(() => {
            const mensagens = document.querySelectorAll('[class*="message"], [id*="message"]');
            for (let msg of mensagens) {
                if (msg.textContent.toLowerCase().includes('sucesso')) {
                    return true;
                }
            }
            return false;
        });

        if (sucesso) {
            console.log("   ✅ Alterações salvas com sucesso!");
        } else {
            console.log("   ⚠️ Não foi possível confirmar o salvamento");
        }

        return sucesso;
    } catch (error) {
        console.log(`   ❌ Erro ao salvar: ${error.message}`);
        return false;
    }
}

// Reloga no Vitae reaproveitando a mesma página/navegador (sem fechar a sessão nem perder o
// agente), usado quando o campo de busca não aparece mesmo depois de reabrir o menu Usuários -
// sinal de que a sessão do Vitae expirou no servidor por inatividade prolongada, mesmo a aba do
// Puppeteer continuando aberta.
async function relogarSessaoVitae(from) {
    const session = sessions.get(from);
    if (!session || !session.page) return false;

    const page = session.page;
    const usuarioLogin = session.username || VITAE_USERNAME;
    const senhaLogin = session.password || VITAE_PASSWORD;

    if (!VITAE_URL || !usuarioLogin || !senhaLogin) {
        console.log("   ❌ Não foi possível relogar: configurações do Vitae não carregadas");
        return false;
    }

    try {
        console.log("   🔐 Relogando no Vitae (sessão expirada)...");
        const resultadoLogin = await loginHttp(VITAE_URL, usuarioLogin, senhaLogin);
        if (!resultadoLogin.sucesso) {
            console.log(`   ❌ Falha ao relogar: ${resultadoLogin.erro}`);
            return false;
        }

        await page.setCookie(...resultadoLogin.cookies);
        await page.goto(`${VITAE_URL}/seguranca/principal.jsf`, { waitUntil: 'networkidle2' });
        await page.waitForSelector('[id*="iconmenuPrincipal"]', { timeout: 15000 });

        await clicar(page, '//*[@id="iconmenuPrincipal:j_id15:j_id28"]');
        await sleep(1000);
        await page.waitForSelector('input[id*="cpf2"]', { timeout: 10000 });

        console.log("   ✅ Sessão do Vitae renovada com sucesso");
        return true;
    } catch (error) {
        console.log(`   ❌ Erro ao relogar: ${error.message}`);
        return false;
    }
}

// Função para buscar usuário pelo CPF, Login ou Nome (já com a página pronta) - COM VERIFICAÇÃO DE STATUS
async function buscarUsuarioVitae(from, valorBusca, tipoBusca = 'cpf', capturarEspecialidade = false) {
    const cpf = valorBusca; // mantido para compatibilidade com chamadas antigas (busca por CPF)
    console.log(`🔍 Buscando usuário VITAE com ${tipoBusca.toUpperCase()}: ${valorBusca} - From: ${from}`);

    const session = sessions.get(from);

    if (!session || !session.page) {
        console.log("   ❌ Sessão não encontrada");
        return { encontrado: false, erro: "Sessão não encontrada" };
    }

    const page = session.page;
    let dadosEspecialidade = null;

    try {
        // Garante que a página está na tela de listagem/busca antes de pesquisar - necessário
        // porque, com a sessão reaproveitada entre chamadas, a página pode ter ficado parada
        // na tela de cadastro (aberta por uma busca anterior que encontrou usuário editável)
        try {
            await page.waitForSelector('input[id*="cpf2"]', { timeout: 3000 });
        } catch (error) {
            console.log("   ℹ️ Não está na tela de busca, reabrindo menu Usuários...");
            await clicar(page, '//*[@id="iconmenuPrincipal:j_id15:j_id28"]');
            await sleep(1000);

            try {
                await page.waitForSelector('input[id*="cpf2"]', { timeout: 10000 });
            } catch (error2) {
                // O campo de busca não apareceu nem depois de reabrir o menu - sinal de que a
                // sessão do Vitae expirou no servidor por inatividade (a aba do Puppeteer
                // continua aberta, mas o login por trás dela não é mais válido). Tenta relogar
                // reaproveitando a mesma página em vez de só devolver o erro de timeout.
                console.log("   ⚠️ Campo de busca não apareceu - sessão do Vitae pode ter expirado. Tentando relogar...");
                const relogado = await relogarSessaoVitae(from);
                if (!relogado) {
                    throw new Error('Sessão do Vitae expirou e não foi possível relogar automaticamente. Saia e entre novamente.');
                }
            }
        }

        // 🔥 TENTA COM REFRESH ATÉ 3 VEZES
        const MAX_TENTATIVAS_REFRESH = 2;
        let linhaEncontrada = -1;
        let statusUsuario = null;
        let temBotaoEditar = false;
        let temResultados = false;
        let todosInativos = false;
        let algumAtivo = false;

        // 🔥 NOVO: Variáveis para capturar dados do Caso 2
        let nomeUsuarioCaso2 = null;
        let unidadeUsuarioCaso2 = null;
        let loginUsuarioCaso2 = null;

        for (let tentativaGlobal = 1; tentativaGlobal <= MAX_TENTATIVAS_REFRESH; tentativaGlobal++) {
            console.log(`\n🔄 ===== TENTATIVA GLOBAL ${tentativaGlobal}/${MAX_TENTATIVAS_REFRESH} =====`);

            if (tentativaGlobal > 1) {
                console.log("   🔄 Atualizando a página...");
                await page.reload({ waitUntil: 'networkidle2' });
                await sleep(2000);

                // Verifica se ainda está na página de usuários após refresh
                try {
                    await page.waitForSelector('input[id*="cpf2"]', { timeout: 5000 });
                    console.log("   ✅ Página de usuários carregada após refresh");
                } catch (error) {
                    console.log("   ⚠️ Precisa reabrir o menu Usuários...");
                    await clicar(page, '//*[@id="iconmenuPrincipal:j_id15:j_id28"]');
                    await sleep(1000);
                    await page.waitForSelector('input[id*="cpf2"]', { timeout: 5000 });
                }
            }

            // Tenta pesquisar 1 vez nesta tentativa global
            let pesquisaSucesso = false;

            console.log(`   📌 Pesquisando...`);

            // Limpa e preenche o campo de pesquisa de acordo com o tipo escolhido
            await preencherCampoPesquisa(page, tipoBusca, valorBusca);

            await clicar(page, '//input[contains(@id,"pesquisar")]');

            // Aguarda resultados
            try {
                await page.waitForSelector('table[id*="tblData"]', { timeout: 8000 });
                await sleep(1000);

                const conteudo = await page.content();

                if (conteudo.includes('Nenhum registro encontrado')) {
                    console.log(`   ⚠️ Nenhum registro encontrado`);
                } else {
                    temResultados = true;

                    // 🔥 VERIFICA O STATUS DO USUÁRIO NA PRIMEIRA LINHA
                    const linhas = await page.evaluate(() => {
                        const tabela = document.querySelector('table[id*="tblData"]');
                        if (!tabela) return [];

                        const linhas = [];
                        const cells = tabela.querySelectorAll('td[id*="j_id299"]');
                        cells.forEach((cell, index) => {
                            linhas.push({
                                index: index,
                                status: cell.textContent.trim().toUpperCase(),
                                id: cell.id
                            });
                        });
                        return linhas;
                    });

                    console.log(`   📊 Linhas encontradas: ${linhas.length}`);
                    linhas.forEach(linha => {
                        console.log(`      Linha ${linha.index}: ${linha.status} (${linha.id})`);
                    });

                    // 🔥 ANALISA O STATUS DE CADA LINHA
                    let linhaAtiva = -1;
                    for (let i = 0; i < linhas.length; i++) {
                        if (linhas[i].status === 'ATIVO') {
                            linhaAtiva = i;
                            algumAtivo = true;
                            break;
                        }
                    }

                    // Verifica se todas as linhas são INATIVO
                    const todasInativas = linhas.every(linha => linha.status === 'INATIVO');
                    if (todasInativas && linhas.length > 0) {
                        todosInativos = true;
                        console.log(`   ⚠️ Todas as linhas estão INATIVO`);
                    }

                    // Verifica se tem linha ATIVO
                    if (linhaAtiva !== -1) {
                        linhaEncontrada = linhaAtiva;
                        statusUsuario = 'ATIVO';
                        console.log(`   ✅ Usuário ATIVO encontrado na linha ${linhaAtiva}`);

                        // Verifica se o botão de editar existe na linha correta
                        const botaoEditarXPath = `//*[@id="formulario:viewListagem:tblData:${linhaAtiva}:j_id310"]`;
                        const botaoExiste = await page.evaluate((xpath) => {
                            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                            return result.singleNodeValue !== null;
                        }, botaoEditarXPath);

                        if (botaoExiste) {
                            temBotaoEditar = true;
                            pesquisaSucesso = true;
                            console.log(`   ✅ Botão de editar encontrado na linha ${linhaAtiva}`);
                        } else {
                            console.log(`   ⚠️ Botão de editar NÃO encontrado na linha ATIVO`);

                            // 🔥 CASO 2: Captura login, nome e unidade do usuário ATIVO sem botão
                            try {
                                // Captura o login (j_id291)
                                const loginXPath = `//*[@id="formulario:viewListagem:tblData:${linhaAtiva}:j_id291"]`;
                                loginUsuarioCaso2 = await extrairTexto(page, loginXPath);

                                // Captura o nome (j_id293)
                                const nomeXPath = `//*[@id="formulario:viewListagem:tblData:${linhaAtiva}:j_id293"]`;
                                nomeUsuarioCaso2 = await extrairTexto(page, nomeXPath);

                                // Captura a unidade (j_id297)
                                const unidadeXPath = `//*[@id="formulario:viewListagem:tblData:${linhaAtiva}:j_id297"]`;
                                unidadeUsuarioCaso2 = await extrairTexto(page, unidadeXPath);

                                console.log(`   📝 Login capturado (Caso 2): ${loginUsuarioCaso2}`);
                                console.log(`   📝 Nome capturado (Caso 2): ${nomeUsuarioCaso2}`);
                                console.log(`   📝 Unidade capturada (Caso 2): ${unidadeUsuarioCaso2}`);
                            } catch (error) {
                                console.log(`   ⚠️ Erro ao capturar dados do Caso 2: ${error.message}`);
                            }

                            // Já capturou os dados necessários (CASO 2) - não precisa repetir pesquisa nem refresh
                            pesquisaSucesso = true;
                        }
                    } else if (linhas.length > 0) {
                        // Tem resultados mas nenhum ATIVO
                        statusUsuario = linhas[0].status;
                        console.log(`   ⚠️ Nenhum usuário ATIVO encontrado. Status: ${statusUsuario}`);
                    }
                }

            } catch (error) {
                console.log(`   ❌ Erro na pesquisa: ${error.message}`);
            }

            // Se encontrou o botão de editar (CASO normal) ou já capturou os dados do CASO 2, sai do loop global
            if (pesquisaSucesso && (temBotaoEditar || nomeUsuarioCaso2)) {
                console.log(`   ✅ Usuário encontrado! Status: ${statusUsuario}`);
                break;
            } else {
                console.log(`   ❌ Tentativa global ${tentativaGlobal} falhou, ${tentativaGlobal < MAX_TENTATIVAS_REFRESH ? 'vai tentar refresh...' : 'última tentativa'}`);
                if (tentativaGlobal === MAX_TENTATIVAS_REFRESH) {
                    console.log(`❌ CPF não encontrado após ${MAX_TENTATIVAS_REFRESH} tentativas com refresh`);
                }
            }
        }

        // 🔥 CASO 1: Não aparece botão de editar em nenhuma linha e todas as linhas são INATIVO
        if (!temBotaoEditar && temResultados && todosInativos) {
            console.log(`❌ CASO 1: Usuário INATIVO - sem botão de editar`);
            return {
                encontrado: false,
                erro: "Usuário está INATIVO. Procure o NTI presencialmente para regularizar seu cadastro.",
                status: "INATIVO",
                caso: 1
            };
        }

        // 🔥 CASO 2: Não aparece botão de editar em nenhuma linha mas existe ATIVO
        if (!temBotaoEditar && temResultados && algumAtivo) {
            console.log(`❌ CASO 2: Usuário ATIVO mas sem botão de editar`);
            return {
                encontrado: false,
                erro: "Você não está cadastrado no Hospital Regional Norte no momento. Procure o NTI presencialmente para realizar transferência de Unidade.",
                status: "ATIVO_SEM_BOTAO",
                caso: 2,
                login: loginUsuarioCaso2,
                nome: nomeUsuarioCaso2,
                unidade: unidadeUsuarioCaso2
            };
        }

        // Se não encontrou o botão de editar mas também não se encaixa nos casos acima
        if (!temBotaoEditar) {
            console.log(`❌ Não foi possível encontrar o botão de editar`);
            return {
                encontrado: false,
                erro: "Não foi possível abrir a edição do usuário. Procure o NTI presencialmente para resolver o problema."
            };
        }

        // 🔥 SE CHEGOU AQUI, TEM BOTÃO DE EDITAR E USUÁRIO ESTÁ ATIVO
        // VERIFICA SE O USUÁRIO ESTÁ ATIVO ANTES DE EDITAR
        if (statusUsuario !== 'ATIVO') {
            console.log(`❌ Usuário está ${statusUsuario}, não é possível alterar`);
            return {
                encontrado: false,
                erro: `Usuário está ${statusUsuario}. Não é possível alterar dados de usuários inativos.`,
                status: statusUsuario
            };
        }

        console.log("✏️ Abrindo edição na linha correta...");

        // 🔥 CLICA NO BOTÃO EDITAR DA LINHA CORRETA (onde o usuário está ATIVO)
        const botaoEditarXPath = `//*[@id="formulario:viewListagem:tblData:${linhaEncontrada}:j_id310"]`;

        let editado = false;
        for (let i = 0; i < 3; i++) {
            try {
                await clicar(page, botaoEditarXPath);
                editado = true;
                break;
            } catch (error) {
                console.log(`   Tentativa ${i+1} falhou...`);
                await sleep(500);
            }
        }

        if (!editado) {
            return { encontrado: false, erro: "Não foi possível abrir edição" };
        }

        // Aguarda o modal e seus campos (com retentativa: às vezes o clique não dispara a
        // AJAX a tempo, então clicamos em Editar novamente antes de desistir)
        console.log("⏳ Aguardando modal viewCadastro...");

        let modalDetectado = false;
        for (let i = 0; i < 2 && !modalDetectado; i++) {
            try {
                await page.waitForSelector('input[id*="viewCadastro"]', { timeout: 10000 });
                modalDetectado = true;
                console.log("   ✅ Modal detectado");
            } catch (e) {
                console.log(`   ⚠️ Modal não detectado na tentativa ${i + 1}, clicando em Editar novamente...`);
                await sleep(500);
                try {
                    await clicar(page, botaoEditarXPath);
                } catch (clickError) {
                    console.log(`   ⚠️ Falha ao reclicar em Editar: ${clickError.message}`);
                }
            }
        }

        if (!modalDetectado) {
            console.log("❌ Modal não detectado");
            return { encontrado: false, erro: "Modal de edição não abriu" };
        }

        // Aguarda o campo de nome ser populado
        try {
            await page.waitForFunction(() => {
                const xpath = "//*[@id='formulario:viewCadastro:j_id88']/table/tbody/tr/td/table/tbody/tr[1]/td[2]/input";
                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                const input = result.singleNodeValue;
                return input && input.value && input.value.trim().length > 0;
            }, { timeout: 10000 });
            console.log("   ✅ Campo de nome populado");
        } catch (e) {
            console.log("   ⚠️ Campo de nome não populado");
        }

        await sleep(500);

        // Capturar dados
        const nomeCompleto = await page.evaluate(() => {
            const xpath = "//*[@id='formulario:viewCadastro:j_id88']/table/tbody/tr/td/table/tbody/tr[1]/td[2]/input";
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const input = result.singleNodeValue;
            return input ? input.value.trim() : null;
        });

        const emailAtual = await extrairTexto(page, "//*[@id='formulario:viewCadastro:panelGroupDeAlterar']/table/tbody/tr[5]/td[2]");
        const loginAtual = await extrairTexto(page, "//*[@id='formulario:viewCadastro:panelGroupDeAlterar']/table/tbody/tr[4]/td[2]");

        const dadosSelect = await capturarOpcoesSelect(page, XPATH_ENTIDADE);
        const unidadeAtual = dadosSelect ? dadosSelect.selecionada_nome : null;
        const unidadeAtualValor = dadosSelect ? dadosSelect.selecionada_valor : null;

        if (!nomeCompleto) {
            console.log("❌ Não foi possível capturar o nome do usuário");
            return { encontrado: false, erro: "Não foi possível capturar dados" };
        }

        console.log(`✅ Usuário encontrado: ${nomeCompleto}`);
        console.log(`   Email: ${emailAtual || 'Não informado'}`);
        console.log(`   Login: ${loginAtual || 'Não informado'}`);
        console.log(`   Unidade: ${unidadeAtual || 'Não informada'}`);

        if (capturarEspecialidade) {
            console.log("   🔍 Capturando dados da Especialidade...");
            try {
                const abaExiste = await page.evaluate(() => {
                    const result = document.evaluate(
                        '//*[@id="formulario:viewCadastro:abaEspec_lbl"]',
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                    );
                    return result.singleNodeValue !== null;
                });

                if (abaExiste) {
                    dadosEspecialidade = await capturarDadosEspecialidade(page);
                } else {
                    console.log("   ℹ️ Aba 'Especialidade' não disponível para este usuário");
                }
            } catch (error) {
                console.log(`   ⚠️ Erro ao capturar especialidade: ${error.message}`);
            }
        }

        session.cpf = cpf;
        session.nomeCompleto = nomeCompleto;
        session.emailAtual = emailAtual;
        session.loginAtual = loginAtual;
        session.unidadeAtual = unidadeAtual;
        session.unidadeAtualValor = unidadeAtualValor;
        session.step = 'AGUARDANDO_ALTERACAO';

        return {
            encontrado: true,
            nome_completo: nomeCompleto,
            email_atual: emailAtual,
            login_atual: loginAtual,
            unidade_atual: unidadeAtual,
            unidade_atual_valor: unidadeAtualValor,
            status: statusUsuario,
            dados_especialidade: dadosEspecialidade
        };

    } catch (error) {
        console.log(`❌ Erro: ${error.message}`);
        return { encontrado: false, erro: error.message };
    }
}

async function capturarOpcoesSelect(page, selectXpath) {
    try {
        const dados = await page.evaluate((selectXpath) => {
            const result = document.evaluate(
                selectXpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
            );
            const select = result.singleNodeValue;

            if (!select) return null;

            const opcoes = [];
            let selecionadaNome = null;
            let selecionadaValor = null;

            for (let i = 0; i < select.options.length; i++) {
                const option = select.options[i];
                const optionText = option.textContent.trim();
                const optionValue = option.value;
                const isSelected = option.selected;

                if (optionValue !== "0") {
                    opcoes.push({
                        valor: optionValue,
                        nome: optionText
                    });
                }

                if (isSelected && optionValue !== "0") {
                    selecionadaNome = optionText;
                    selecionadaValor = optionValue;
                }
            }

            return {
                opcoes: opcoes,
                selecionada_nome: selecionadaNome,
                selecionada_valor: selecionadaValor
            };
        }, selectXpath);

        return dados;
    } catch (e) {
        return null;
    }
}

// Definir o caminho da pasta Json no início do arquivo
const UNIDADES_FILE = path.join(__dirname, 'json', 'unidades.json');

function salvarOpcoesUnidadesJson(opcoes, arquivo = UNIDADES_FILE) {
    if (fs.existsSync(arquivo)) return true;

    try {
        const dados = {
            unidades: opcoes,
            total: opcoes.length,
            data_captura: new Date().toLocaleString('pt-BR')
        };
        fs.writeFileSync(arquivo, JSON.stringify(dados, null, 2), 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
}

function carregarUnidades() {
    if (fs.existsSync(UNIDADES_FILE)) {
        const data = fs.readFileSync(UNIDADES_FILE, 'utf-8');
        const json = JSON.parse(data);
        unidadesCache = json.unidades;
        return unidadesCache;
    }
    return null;
}

// Função para alterar email na sessão já aberta (OTIMIZADA)
async function buscarEAlterarEmailVitae(from, novoEmail) {
    console.log(`🚀 Alterando email para: ${novoEmail} - From: ${from}`);

    const session = sessions.get(from);

    if (!session || !session.page) {
        return { sucesso: false, erro: "Sessão não encontrada" };
    }

    const page = session.page;

    try {
        // Verificar se o modal ainda está aberto
        const modalAberto = await page.evaluate(() => {
            return document.querySelector('input[id*="viewCadastro"]') !== null;
        });

        if (!modalAberto) {
            await clicar(page, '//*[@id="formulario:viewListagem:tblData:0:j_id310"]');
            await page.waitForSelector('input[id*="viewCadastro"]', { timeout: 15000 });
            await sleep(200);
        }

        // ALTERAR EMAIL
        const emailAlterado = await page.evaluate((novoEmail) => {
            const xpath = "//*[@id='formulario:viewCadastro:j_id88']/table/tbody/tr/td/table/tbody/tr[2]/td[2]/input";
            const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            const input = result.singleNodeValue;
            if (input) {
                input.value = '';
                input.value = novoEmail;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            }
            return false;
        }, novoEmail);

        if (!emailAlterado) {
            return { sucesso: false, erro: "Campo de email não encontrado" };
        }

        // Botão Alterar
        await clicar(page, '//input[contains(@id,"alterar")]');
        await sleep(200);

        // Modal senha
        await page.waitForSelector('input[id*="senhaModal"]', { timeout: 200 });

        await page.evaluate((password) => {
            const senhaInput = document.querySelector('input[id*="senhaModal"]');
            if (senhaInput) {
                senhaInput.value = password;
            }
        }, VITAE_PASSWORD);

        await sleep(300);

        // Confirmar
        await clicar(page, '//*[@id="formulario:formModalAlte:logar"]');

        await sleep(200);

        // Fechar sessão
        await fecharSessao(from);

        console.log("✅ EMAIL ALTERADO COM SUCESSO!");

        return {
            sucesso: true,
            nome_completo: session.nomeCompleto,
            login: session.loginAtual,
            email_anterior: session.emailAtual,
            email_novo: novoEmail,
            unidade: session.unidadeAtual
        };

    } catch (error) {
        console.log(`❌ Erro: ${error.message}`);
        await fecharSessao(from);
        return { sucesso: false, erro: error.message };
    }
}

// Constantes da unidade/setor padrão usados na transferência.
// O código (valor) do Setor MUDA para cada Entidade, então o Setor é selecionado pelo
// começo do nome da opção (ex: "AMBULATÓRIO", "NTI"), nunca por um código fixo.
const HOSPITAL_REGIONAL_NORTE_VALOR = '21';
const SETOR_AMBULATORIO_NOME = 'AMBULATÓRIO';
const SETOR_NTI_NOME = 'NTI';

// Com o modal de edição já aberto na página, altera a Entidade e o Setor (por nome) e confirma com senha.
// `garantirGrupoConsulta` só é usado na transferência do usuário ALVO para o HRN (não no ajuste
// de unidade do agente) - ver adicionarGrupoConsulta.
async function alterarEntidadeSetor(page, entidadeValor, setorNomePadrao, password, garantirGrupoConsulta = false) {
    const okEntidade = await definirSelectPorXpath(page, XPATH_ENTIDADE, entidadeValor);
    if (!okEntidade) throw new Error('Select de Entidade não encontrado');

    // Aguarda a AJAX da RichFaces repopular o select de Setor após mudar a Entidade
    await sleep(1500);

    const opcoesSetor = await capturarOpcoesSelect(page, XPATH_SETOR);
    if (!opcoesSetor) throw new Error('Select de Setor não encontrado');

    const opcaoSetor = opcoesSetor.opcoes.find(
        o => o.nome.trim().toUpperCase().startsWith(setorNomePadrao.toUpperCase())
    );
    if (!opcaoSetor) {
        throw new Error(`Setor "${setorNomePadrao}" não encontrado nas opções da entidade selecionada (valor=${entidadeValor})`);
    }

    const okSetor = await definirSelectPorXpath(page, XPATH_SETOR, opcaoSetor.valor);
    if (!okSetor) throw new Error('Select de Setor não encontrado');

    await sleep(300);

    // O VITAE recusa o "Alterar" se o usuário não tiver nenhum grupo - garante o grupo CONSULTA
    // antes de confirmar quando isso é esperado (transferência do alvo para o HRN).
    if (garantirGrupoConsulta) {
        const gruposAtuais = await capturarGruposUsuario(page);
        if (gruposAtuais.length === 0) {
            await adicionarGrupoConsulta(page);
        } else {
            console.log(`   ℹ️ Usuário já possui ${gruposAtuais.length} grupo(s) - não é necessário adicionar CONSULTA`);
        }
    }

    await confirmarAlteracaoComSenha(page, password);

    // Exigir um texto específico de "sucesso" se mostrou pouco confiável (falso negativo
    // confirmado: a alteração salvava mesmo sem essa mensagem aparecer a tempo). Em vez disso,
    // só falha se aparecer uma mensagem de ERRO de verdade; na ausência de erro, assume sucesso.
    const resultadoConfirmacao = await page.evaluate(() => {
        const candidatos = Array.from(document.querySelectorAll('[class*="message"], [id*="message"]'));
        const textos = candidatos.map(el => el.textContent.trim()).filter(Boolean);
        const temErro = textos.some(t => /erro|inv[áa]lid|incorret|falh|n[ãa]o foi poss[íi]vel/i.test(t));
        return { textos, temErro };
    });

    if (resultadoConfirmacao.temErro) {
        throw new Error(`VITAE reportou um erro ao confirmar: ${resultadoConfirmacao.textos.join(' | ')}`);
    }

    console.log(`   ✅ Entidade/Setor alterados (Setor: ${opcaoSetor.nome})` +
        (resultadoConfirmacao.textos.length ? ` - mensagens: ${resultadoConfirmacao.textos.join(' | ')}` : ' - nenhuma mensagem detectada'));
}

// Reabre sessão como o agente e restaura a Entidade/Setor originais dele. Usada tanto no
// caminho de sucesso (etapa 4) quanto no bloco de recuperação quando algo falha depois que a
// unidade do agente já tinha sido alterada (etapa 2) - nunca deixa o agente "preso" numa unidade
// que não é a dele só porque uma etapa posterior da transferência deu erro.
// `reabrirSessao` controla se relogamos do zero antes de restaurar:
// - true (padrão, usado na recuperação de erro): o estado da página é desconhecido depois de
//   uma falha, então começar limpo é mais seguro do que arriscar reaproveitar algo quebrado.
// - false (usado no caminho de sucesso): a sessão já está fresca (acabou de editar o alvo com o
//   mesmo agente), relogar de novo só custaria tempo sem ganho de confiabilidade.
async function restaurarUnidadeAgente(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, reabrirSessao = true) {
    if (!unidadeAgenteValor || !setorAgenteNome) {
        return { sucesso: false, erro: 'Não foi possível identificar a unidade/setor original do agente para restaurar' };
    }

    try {
        if (reabrirSessao) {
            await fecharSessao(from);
            if (!(await iniciarNavegador(from, usuarioAgente, senhaAgente))) {
                return { sucesso: false, erro: 'Falha ao reabrir sessão para restaurar o agente' };
            }
        }

        const resultadoAdmin = await buscarUsuarioVitae(from, usuarioAgente, 'login');
        if (!resultadoAdmin.encontrado) {
            await fecharSessao(from);
            return { sucesso: false, erro: 'Não foi possível reabrir o cadastro do agente para restaurar a unidade' };
        }

        const page = sessions.get(from).page;
        console.log(`🔁 Restaurando unidade do agente para "${unidadeAgenteNome}" / Setor "${setorAgenteNome}"...`);
        await alterarEntidadeSetor(page, unidadeAgenteValor, setorAgenteNome, senhaAgente);
        await fecharSessao(from);
        console.log('✅ Unidade do agente restaurada com sucesso.');
        return { sucesso: true };
    } catch (error) {
        console.log(`   ❌ Falha ao restaurar unidade do agente: ${error.message}`);
        await fecharSessao(from);
        return { sucesso: false, erro: error.message };
    }
}

// Tenta restaurar o agente e, se falhar, tenta MAIS UMA VEZ sempre relogando do zero antes de
// desistir. Sem isso, uma falha na única tentativa deixava o agente preso na unidade do alvo
// (incidente real já aconteceu duas vezes) - a chamada nunca pode aceitar a primeira falha.
async function restaurarUnidadeAgenteComRetry(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, reabrirSessaoPrimeiraTentativa) {
    let restauracao = await restaurarUnidadeAgente(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, reabrirSessaoPrimeiraTentativa);
    if (!restauracao.sucesso) {
        console.log(`⚠️ Falha ao restaurar o agente (${restauracao.erro}) - tentando novamente com relogin completo...`);
        restauracao = await restaurarUnidadeAgente(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, true);
    }
    return restauracao;
}

// Fluxo completo de transferência de unidade. O "agente" (usuário/senha logados na
// aplicação web) é quem executa as alterações, não um admin fixo:
// 1) busca o usuário alvo e captura sua unidade atual (reaproveita a sessão já aberta)
// 2) muda a unidade do próprio agente para a mesma do alvo (setor Ambulatório) - mesma sessão,
//    sem relogar, porque a Entidade do agente ainda não mudou nesse ponto
// 3) faz logoff/login (aqui sim é necessário: a Entidade do agente mudou no passo 2, e o VITAE só
//    reflete o novo escopo de permissão depois de um login novo) e edita o usuário alvo para
//    HOSPITAL REGIONAL NORTE / Ambulatório
// 4) restaura a unidade/setor originais do agente, sem relogar de novo (sessão ainda fresca do
//    passo 3) - exceto no caminho de erro (catch), onde sempre relogamos antes de restaurar
//    porque o estado da página após uma falha é desconhecido
//
// Se qualquer etapa a partir da (2) falhar, o catch sempre tenta restaurar a unidade do agente
// antes de devolver o erro - caso contrário a conta do agente fica presa na unidade do alvo.
async function transferirUnidadeUsuario(from, valorBusca, tipoBusca = 'cpf') {
    // Captura o usuário/senha logados (o "agente" que fará as alterações) antes de
    // fechar a sessão atual - se nenhum estiver disponível, cai no admin padrão do .env
    const sessaoAtual = sessions.get(from);
    const usuarioAgente = sessaoAtual?.username || VITAE_USERNAME;
    const senhaAgente = sessaoAtual?.password || VITAE_PASSWORD;

    // Só ficam preenchidos depois que a unidade do agente é efetivamente alterada (etapa 2);
    // usados pelo bloco de recuperação do catch caso algo falhe depois disso.
    let unidadeAgenteValor = null;
    let unidadeAgenteNome = null;
    let setorAgenteNome = null;
    let agenteFoiAlterado = false;

    try {
        console.log(`🚚 Iniciando transferência de unidade - ${tipoBusca}=${valorBusca}`);

        const resultadoAlvo = await buscarUsuarioVitae(from, valorBusca, tipoBusca);

        let unidadeOrigemValor = resultadoAlvo.unidade_atual_valor;
        let unidadeOrigemNome = resultadoAlvo.unidade_atual;
        let nomeAlvo = resultadoAlvo.nome_completo;
        let loginAlvo = resultadoAlvo.login_atual || resultadoAlvo.login;

        // Se ainda estiver undefined, tenta extrair do nome (fallback)
        if (!loginAlvo) {
            const nomeSemEspacos = (resultadoAlvo.nome_completo || '').replace(/\s/g, '').toUpperCase();
            loginAlvo = nomeSemEspacos || 'LOGIN_NAO_ENCONTRADO';
            console.log(`⚠️ Login não encontrado, gerado a partir do nome: ${loginAlvo}`);
        }

        // CASO 2: usuário ATIVO mas sem botão de editar - a unidade vem da listagem, não do modal
        if (!resultadoAlvo.encontrado && resultadoAlvo.caso === 2) {
            unidadeOrigemNome = resultadoAlvo.unidade;
            nomeAlvo = resultadoAlvo.nome;
        }

        if (!unidadeOrigemValor && !unidadeOrigemNome) {
            await fecharSessao(from);
            return { sucesso: false, erro: resultadoAlvo.erro || 'Não foi possível capturar a unidade do usuário' };
        }

        // Se o usuário já está no HOSPITAL REGIONAL NORTE, não há transferência a fazer
        if (unidadeOrigemValor === HOSPITAL_REGIONAL_NORTE_VALOR ||
            (unidadeOrigemNome && unidadeOrigemNome.trim().toUpperCase() === 'HOSPITAL REGIONAL NORTE')) {
            await fecharSessao(from);
            console.log('ℹ️ Usuário já está no HOSPITAL REGIONAL NORTE - nenhuma transferência necessária.');
            return {
                sucesso: true,
                jaEstavaNaUnidade: true,
                nome_completo: nomeAlvo,
                login: loginAlvo,
                unidade_atual: unidadeOrigemNome || 'HOSPITAL REGIONAL NORTE'
            };
        }

        // Etapa 2: alteração da unidade do próprio agente - reaproveita a sessão já aberta pela
        // busca do alvo (a Entidade do agente ainda não mudou, então não há motivo pra relogar
        // aqui; buscarUsuarioVitae já volta pra tela de listagem por conta própria se precisar)
        const resultadoAdmin = await buscarUsuarioVitae(from, usuarioAgente, 'login');
        if (!resultadoAdmin.encontrado) {
            await fecharSessao(from);
            return { sucesso: false, erro: `Não foi possível abrir o cadastro do agente (${usuarioAgente})` };
        }

        let page = sessions.get(from).page;

        // Captura a Entidade/Setor atuais do agente para poder restaurá-los ao final
        // (o agente pode não ser sempre o HOSPITAL REGIONAL NORTE/NTI)
        unidadeAgenteValor = resultadoAdmin.unidade_atual_valor;
        unidadeAgenteNome = resultadoAdmin.unidade_atual;
        const opcoesSetorAgente = await capturarOpcoesSelect(page, XPATH_SETOR);
        setorAgenteNome = opcoesSetorAgente?.selecionada_nome;

        if (!unidadeOrigemValor && unidadeOrigemNome) {
            const opcoesEntidade = await capturarOpcoesSelect(page, XPATH_ENTIDADE);
            const opcaoEncontrada = opcoesEntidade?.opcoes.find(
                o => o.nome.trim().toUpperCase() === unidadeOrigemNome.trim().toUpperCase()
            );
            if (opcaoEncontrada) unidadeOrigemValor = opcaoEncontrada.valor;
        }

        if (!unidadeOrigemValor) {
            await fecharSessao(from);
            return { sucesso: false, erro: 'Não foi possível identificar o código da unidade de destino' };
        }

        console.log(`🔁 Alterando unidade do agente para "${unidadeOrigemNome}" (valor=${unidadeOrigemValor}) / Setor Ambulatório...`);
        try {
            await alterarEntidadeSetor(page, unidadeOrigemValor, SETOR_AMBULATORIO_NOME, senhaAgente);
        } catch (error) {
            console.log(`⚠️ Erro na alteração: ${error.message}`);
            console.log("🔄 Tentando novamente com delay maior...");
            await sleep(3000);
            await alterarEntidadeSetor(page, unidadeOrigemValor, SETOR_AMBULATORIO_NOME, senhaAgente);
        }
        agenteFoiAlterado = true;

        // Etapa 3: logoff/login e edição do usuário alvo
        await fecharSessao(from);
        if (!(await iniciarNavegador(from, usuarioAgente, senhaAgente))) {
            throw new Error('Falha ao reabrir sessão após mudar unidade do agente');
        }

        const resultadoAlvo2 = await buscarUsuarioVitae(from, valorBusca, tipoBusca);
        if (!resultadoAlvo2.encontrado) {
            throw new Error(resultadoAlvo2.erro || 'Não foi possível editar o usuário mesmo após igualar a unidade do agente');
        }

        page = sessions.get(from).page;
        console.log('🔁 Alterando unidade do usuário alvo para HOSPITAL REGIONAL NORTE / Setor Ambulatório...');
        await alterarEntidadeSetor(page, HOSPITAL_REGIONAL_NORTE_VALOR, SETOR_AMBULATORIO_NOME, senhaAgente, true);

        // Etapa 4: restauração da unidade do agente - primeira tentativa sem relogar (a sessão
        // já está fresca desde a etapa 3), com retry automático relogando do zero se falhar.
        const restauracao = await restaurarUnidadeAgenteComRetry(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, false);
        if (!restauracao.sucesso) {
            return {
                sucesso: false,
                erro: `Usuário transferido com sucesso, mas falha ao restaurar o agente (${usuarioAgente}): ${restauracao.erro}. ` +
                      `Corrija manualmente no VITAE: a unidade/setor da conta "${usuarioAgente}" deveria ser "${unidadeAgenteNome}" / "${setorAgenteNome}".`
            };
        }

        console.log('✅ TRANSFERÊNCIA DE UNIDADE CONCLUÍDA COM SUCESSO!');
        console.log(`🔑 LOGIN CAPTURADO: ${loginAlvo}`);

        return {
            sucesso: true,
            usuario: nomeAlvo,
            login: loginAlvo,
            unidade_origem: unidadeOrigemNome,
            unidade_destino: 'HOSPITAL REGIONAL NORTE',
            setor_destino: 'AMBULATÓRIO'
        };

    } catch (error) {
        console.log(`❌ Erro na transferência de unidade: ${error.message}`);

        // Se a unidade do agente já tinha sido alterada quando o erro aconteceu, ele não pode
        // ficar "preso" na unidade do alvo - tenta restaurar antes de devolver o erro original.
        if (agenteFoiAlterado) {
            console.log(`⚠️ A unidade do agente (${usuarioAgente}) já tinha sido alterada antes do erro - tentando restaurar...`);
            const restauracao = await restaurarUnidadeAgenteComRetry(from, usuarioAgente, senhaAgente, unidadeAgenteValor, setorAgenteNome, unidadeAgenteNome, true);
            if (!restauracao.sucesso) {
                return {
                    sucesso: false,
                    erro: `${error.message}. ALÉM DISSO, a restauração automática da unidade do agente (${usuarioAgente}) falhou: ${restauracao.erro}. ` +
                          `Corrija manualmente no VITAE: a unidade/setor da conta "${usuarioAgente}" deveria ser "${unidadeAgenteNome}" / "${setorAgenteNome}".`
                };
            }
            return {
                sucesso: false,
                erro: `${error.message} (a unidade do agente "${usuarioAgente}" foi restaurada automaticamente para "${unidadeAgenteNome}" / "${setorAgenteNome}")`
            };
        }

        await fecharSessao(from);
        return { sucesso: false, erro: error.message };
    }
}

// Função de debug: expõe a sessão (browser/page) para scripts de inspeção/captura
function obterSessao(from) {
    return sessions.get(from) || null;
}

// Função para fechar sessão
async function fecharSessao(from) {
    const session = sessions.get(from);
    if (session && session.browser) {
        await session.browser.close();
        sessions.delete(from);
        console.log(`🔒 Sessão fechada para: ${from}`);
    }
}

// Funções auxiliares
function obterOpcoesUnidades(unidadeCorreta) {
    const unidades = carregarUnidades();

    // Número de opções aleatórias desejadas (4)
    const QUANTIDADE_ALEATORIAS = 4;
    // Total de opções = 1 correta + 4 aleatórias = 5
    const TOTAL_OPCOES = 1 + QUANTIDADE_ALEATORIAS;

    if (!unidades || unidades.length === 0) {
        // Fallback com 5 opções
        const fallback = [
            "HOSPITAL REGIONAL NORTE",
            "UPA - MESSEJANA",
            "HOSPITAL GERAL FORTALEZA",
            "HOSPITAL DE MESSEJANA",
            "UPA - JOSÉ WALTER"
        ];
        // Garante que a unidade correta está incluída
        const outras = fallback.filter(u => u !== unidadeCorreta);
        const opcoes = [unidadeCorreta, ...outras.slice(0, QUANTIDADE_ALEATORIAS)];
        return embaralharArray(opcoes);
    }

    // Filtra unidades diferentes da correta
    const outrasUnidades = unidades.filter(u => u.nome !== unidadeCorreta);

    // Embaralha e pega 4 unidades aleatórias
    const aleatorias = embaralharArray([...outrasUnidades])
        .slice(0, QUANTIDADE_ALEATORIAS)
        .map(u => u.nome);

    // Combina a unidade correta com as 4 aleatórias
    const opcoes = [unidadeCorreta, ...aleatorias];

    // Embaralha as 5 opções finais
    return embaralharArray(opcoes);
}

function embaralharArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function gerarCodigoVerificacao() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// EXPORTAÇÕES
module.exports = {
    setTransporter,
    loginHttp,
    validarLoginPacienteHRN,
    iniciarNavegador,
    buscarUsuarioVitae,
    buscarEAlterarEmailVitae,
    obterOpcoesUnidades,
    gerarCodigoVerificacao,
    enviarCodigoEmailVitae,
    codigosEnviados,
    carregarUnidades,
    fecharSessao,
    obterSessao,
    clicar,
    extrairTexto,
    capturarOpcoesSelect,
    transferirUnidadeUsuario,
    buscarEspecialidadesDisponiveis,
    adicionarEspecialidade,
    excluirEspecialidade,
    salvarAlteracoesEspecialidade,
    capturarGruposUsuario
};
