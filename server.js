// server.js - Aplicação web: login + pesquisa + transferência de unidade
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

const {
    setTransporter,
    loginHttp,
    iniciarNavegador,
    buscarUsuarioVitae,
    transferirUnidadeUsuario,
    fecharSessao,
    obterSessao,
    buscarEspecialidadesDisponiveis,
    adicionarEspecialidade,
    excluirEspecialidade,
    salvarAlteracoesEspecialidade,
    capturarGruposUsuario
} = require('./vitae.js');

const USUARIOS_FILE = path.join(__dirname, 'json', 'usuarios_permitidos.json');
const HOSPITAL_REGIONAL_NORTE_NOME = 'HOSPITAL REGIONAL NORTE';

function carregarUsuariosPermitidos() {
    const conteudo = fs.readFileSync(USUARIOS_FILE, 'utf-8');
    return JSON.parse(conteudo).usuarios.map(u => u.toUpperCase());
}

setTransporter(null, {
    vitae: {
        url: process.env.VITAE_URL,
        username: process.env.VITAE_USERNAME,
        password: process.env.VITAE_PASSWORD
    },
    whatsapp: {
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    }
});

const SESSION_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 2;

// Sem fallback aqui de propósito: um valor fixo no código assinaria os cookies de sessão com um
// segredo público (visível a qualquer um com acesso ao repositório), permitindo forjar sessões
// autenticadas em qualquer deploy que esqueça de configurar o .env.
if (!process.env.SESSION_SECRET) {
    console.error('❌ SESSION_SECRET não definido no .env. Defina um valor longo e aleatório antes de iniciar o servidor.');
    process.exit(1);
}

const app = express();
app.use(express.json());
app.use(session({
    store: new FileStore({
        path: path.join(__dirname, 'sessions'),
        ttl: SESSION_COOKIE_MAX_AGE_MS / 1000,
        retries: 1,
        logFn: () => {} // a lib loga a cada leitura/escrita por padrão; silenciado para não poluir os logs do PM2
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: SESSION_COOKIE_MAX_AGE_MS }
}));

function loginRequired(req, res, next) {
    if (!req.session.logged_in) {
        if (req.path.startsWith('/api/')) {
            return res.status(401).json({ erro: 'Não autenticado' });
        }
        return res.redirect('/');
    }
    next();
}

app.get('/', (req, res) => {
    if (req.session.logged_in) return res.redirect('/consulta');
    res.sendFile(path.join(__dirname, 'views', 'login.html'));
});

app.post('/login', async (req, res) => {
    const username = (req.body.username || '').trim().toUpperCase();
    const password = (req.body.password || '').trim();

    if (!username || !password) {
        return res.json({ success: false, error: 'Usuário e Senha são obrigatórios!' });
    }

    const usuariosPermitidos = carregarUsuariosPermitidos();
    if (!usuariosPermitidos.includes(username)) {
        return res.json({ success: false, error: 'Usuário não autorizado a usar este sistema.' });
    }

    try {
        const resultadoLogin = await loginHttp(process.env.VITAE_URL, username, password);
        if (!resultadoLogin.sucesso) {
            return res.json({ success: false, error: 'Usuário ou Senha do Vitae incorretos!' });
        }
    } catch (error) {
        return res.json({ success: false, error: 'Erro ao validar credenciais no Vitae. Tente novamente.' });
    }

    req.session.logged_in = true;
    req.session.username = username;
    // Guarda a senha para usar o próprio usuário logado como agente nas ações no Vitae
    req.session.password = password;

    // Já abre a sessão/navegador no Vitae aqui, para que /api/pesquisar e /api/transferir
    // reaproveitem o mesmo agente já logado em vez de logar de novo a cada chamada
    try {
        const ok = await iniciarNavegador(`web-${req.sessionID}`, username, password);
        if (!ok) {
            return res.json({ success: false, error: 'Login válido, mas falha ao abrir sessão de automação no Vitae.' });
        }
    } catch (error) {
        return res.json({ success: false, error: 'Login válido, mas falha ao abrir sessão de automação no Vitae.' });
    }

    res.json({ success: true, redirect: '/consulta' });
});

app.get('/logout', async (req, res) => {
    await fecharSessao(`web-${req.sessionID}`);
    req.session.destroy(() => res.redirect('/'));
});

app.get('/consulta', loginRequired, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'consulta.html'));
});

// Avalia o resultado de buscarUsuarioVitae e normaliza num formato único para o front-end
function avaliarResultadoBusca(resultado, grupos) {
    if (resultado.encontrado) {
        const unidade = resultado.unidade_atual;
        const jaNoHRN = (unidade || '').trim().toUpperCase() === HOSPITAL_REGIONAL_NORTE_NOME;
        return {
            encontradoListagem: true,
            nome: resultado.nome_completo,
            login: resultado.login_atual,
            unidade,
            status: resultado.status,
            podeTransferir: !jaNoHRN,
            jaNoHRN,
            especialidades: resultado.dados_especialidade || [],
            grupos: grupos || [],
            mensagem: jaNoHRN ? 'Usuário já está no Hospital Regional Norte. Nenhuma transferência necessária.' : null
        };
    }

    if (resultado.caso === 1) {
        return {
            encontradoListagem: false,
            mensagem: resultado.erro
        };
    }

    if (resultado.caso === 2) {
        const unidade = resultado.unidade;
        const jaNoHRN = (unidade || '').trim().toUpperCase() === HOSPITAL_REGIONAL_NORTE_NOME;
        return {
            encontradoListagem: true,
            nome: resultado.nome,
            login: resultado.login,
            unidade,
            status: 'ATIVO',
            podeTransferir: !jaNoHRN,
            jaNoHRN,
            especialidades: [],
            grupos: [],
            mensagem: jaNoHRN ? 'Usuário já está no Hospital Regional Norte. Nenhuma transferência necessária.' : null
        };
    }

    return {
        encontradoListagem: false,
        mensagem: resultado.erro || 'Usuário não encontrado.'
    };
}

app.post('/api/pesquisar', loginRequired, async (req, res) => {
    const { tipoBusca, valor } = req.body;
    if (!tipoBusca || !valor) {
        return res.status(400).json({ erro: 'Informe o tipo e o valor da busca.' });
    }

    const from = `web-${req.sessionID}`;

    try {
        const ok = await iniciarNavegador(from, req.session.username, req.session.password);
        if (!ok) {
            return res.status(500).json({ encontradoListagem: false, mensagem: 'Falha ao iniciar sessão com o Vitae.' });
        }

        // 4º argumento true: busca também as Especialidades, igual ao bot do WhatsApp
        const resultado = await buscarUsuarioVitae(from, valor, tipoBusca, true);

        // Grupos só estão disponíveis com o cadastro (modal) aberto, ou seja, quando "encontrado"
        let grupos = [];
        if (resultado.encontrado) {
            const page = obterSessao(from)?.page;
            if (page) {
                grupos = await capturarGruposUsuario(page);
            }
        }

        res.json(avaliarResultadoBusca(resultado, grupos));
    } catch (error) {
        await fecharSessao(from);
        res.status(500).json({ encontradoListagem: false, mensagem: error.message });
    }
});

app.post('/api/transferir', loginRequired, async (req, res) => {
    const { tipoBusca, valor } = req.body;
    if (!tipoBusca || !valor) {
        return res.status(400).json({ sucesso: false, erro: 'Informe o tipo e o valor da busca.' });
    }

    const from = `web-${req.sessionID}`;

    try {
        const ok = await iniciarNavegador(from, req.session.username, req.session.password);
        if (!ok) {
            return res.status(500).json({ sucesso: false, erro: 'Falha ao iniciar sessão com o Vitae.' });
        }

        const resultado = await transferirUnidadeUsuario(from, valor, tipoBusca);
        res.json(resultado);
    } catch (error) {
        await fecharSessao(from);
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

// Gerenciamento de Especialidade - exige que uma consulta tenha sido feita antes (mesma sessão
// "web-{sessionID}" com o cadastro do usuário ainda aberto na aba/página do Vitae).
app.post('/api/especialidades-disponiveis', loginRequired, async (req, res) => {
    const from = `web-${req.sessionID}`;
    const page = obterSessao(from)?.page;
    if (!page) {
        return res.status(409).json({ erro: 'Sessão expirada. Faça a consulta novamente.' });
    }

    try {
        const especialidades = await buscarEspecialidadesDisponiveis(page);
        res.json({ especialidades });
    } catch (error) {
        res.status(500).json({ erro: error.message });
    }
});

// Depois de salvar uma alteração de especialidade, reloga do zero (fecha + abre sessão nova) em
// vez de só esperar um tempo fixo - garante uma página/ViewState limpos antes da reconsulta
// automática que o front-end dispara a seguir, evitando buscas vazias por causa de algum estado
// intermediário do JSF/RichFaces logo após o Alterar + confirmação de senha.
async function relogarAposAlteracao(from, username, password) {
    try {
        await fecharSessao(from);
        await iniciarNavegador(from, username, password);
    } catch (error) {
        console.log(`⚠️ Falha ao relogar após alteração: ${error.message}`);
    }
}

app.post('/api/especialidade/adicionar', loginRequired, async (req, res) => {
    const { especialidadeValor, fazAmbulatorio } = req.body;
    if (!especialidadeValor || !fazAmbulatorio) {
        return res.status(400).json({ sucesso: false, erro: 'Informe a especialidade e se atende Ambulatório.' });
    }

    const from = `web-${req.sessionID}`;
    const page = obterSessao(from)?.page;
    if (!page) {
        return res.status(409).json({ sucesso: false, erro: 'Sessão expirada. Faça a consulta novamente.' });
    }

    try {
        const adicionado = await adicionarEspecialidade(page, especialidadeValor, fazAmbulatorio);
        if (!adicionado) {
            return res.json({ sucesso: false, erro: 'Não foi possível adicionar a especialidade.' });
        }

        const salvo = await salvarAlteracoesEspecialidade(page, req.session.password);
        await relogarAposAlteracao(from, req.session.username, req.session.password);
        res.json({ sucesso: salvo, erro: salvo ? null : 'Especialidade adicionada, mas pode não ter sido salva. Verifique manualmente.' });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

app.post('/api/especialidade/excluir', loginRequired, async (req, res) => {
    const { rowIndex } = req.body;
    if (rowIndex === undefined || rowIndex === null) {
        return res.status(400).json({ sucesso: false, erro: 'Informe a especialidade a excluir.' });
    }

    const from = `web-${req.sessionID}`;
    const page = obterSessao(from)?.page;
    if (!page) {
        return res.status(409).json({ sucesso: false, erro: 'Sessão expirada. Faça a consulta novamente.' });
    }

    try {
        const excluido = await excluirEspecialidade(page, rowIndex);
        if (!excluido) {
            return res.json({ sucesso: false, erro: 'Não foi possível excluir a especialidade.' });
        }

        const salvo = await salvarAlteracoesEspecialidade(page, req.session.password);
        await relogarAposAlteracao(from, req.session.username, req.session.password);
        res.json({ sucesso: salvo, erro: salvo ? null : 'Especialidade removida da tela, mas pode não ter sido salva. Verifique manualmente.' });
    } catch (error) {
        res.status(500).json({ sucesso: false, erro: error.message });
    }
});

const PORT = process.env.PORT || 5020;
app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});
