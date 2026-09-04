# Transferência de Usuário VITAE

Aplicação web interna que automatiza, dentro do sistema **VITAE** (um sistema hospitalar JSF/RichFaces, sem API pública), a transferência de unidade de um usuário para o **HOSPITAL REGIONAL NORTE**. Também permite consultar e gerenciar as Especialidades e visualizar os Grupos de um usuário.

Não existe banco de dados próprio: o VITAE é o sistema de registro, e esta aplicação apenas o pilota via [Puppeteer](https://pptr.dev/), usando a sessão de quem estiver logado.

## Funcionalidades

- **Login** com o próprio usuário/senha do VITAE, restrito a uma lista de logins autorizados (`json/usuarios_permitidos.json`).
- **Consulta** de usuário por CPF, Login ou Nome, retornando nome, login, unidade atual, status, especialidades e grupos.
- **Transferência de unidade** para o HOSPITAL REGIONAL NORTE / Setor Ambulatório, feita em nome do próprio usuário logado (o "agente").
- **Gerenciamento de Especialidade**: adicionar e excluir registros de especialidade do usuário.

## Como funciona (resumo)

Cada ação de escrita no VITAE (transferir unidade, alterar especialidade) é executada **como o próprio usuário logado na aplicação**, não por uma conta de administrador fixa. Isso é necessário porque o VITAE só permite editar um usuário cuja unidade seja igual à do agente que está executando a ação — então uma transferência não é uma escrita única:

1. Busca o usuário-alvo e captura a unidade atual dele.
2. Muda temporariamente a unidade do próprio agente para a mesma do alvo.
3. Faz logoff/login (o VITAE só aplica a nova permissão depois de um login novo) e edita o usuário-alvo para HOSPITAL REGIONAL NORTE / Ambulatório.
4. Restaura a unidade original do agente.

Se qualquer etapa a partir da (2) falhar, a aplicação sempre tenta restaurar a unidade do agente antes de devolver o erro, para nunca deixar a conta do agente presa na unidade do usuário-alvo.

Detalhes de arquitetura mais profundos (fluxo de sessão, tratamento de casos especiais do VITAE, decisões de design) estão documentados em [`CLAUDE.md`](./CLAUDE.md).

## Pré-requisitos

- Node.js 18+
- Acesso de rede ao VITAE (`VITAE_URL`)
- Um login VITAE válido, incluído em `json/usuarios_permitidos.json`

## Instalação

```bash
npm install
```

## Configuração

1. Copie `.env.example` para `.env` e preencha:

   ```
   VITAE_URL=https://seu-vitae.exemplo
   PORT=5020
   SESSION_SECRET=gere-um-valor-aleatorio-longo
   ```

   Para gerar um `SESSION_SECRET` forte:

   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
   ```

   O servidor **recusa iniciar** sem `SESSION_SECRET` definido — não existe valor padrão no código, de propósito (evita sessões forjáveis por qualquer pessoa que veja o código-fonte).

2. Copie `json/usuarios_permitidos.example.json` para `json/usuarios_permitidos.json` e liste os logins VITAE autorizados a usar a aplicação:

   ```json
   {
       "usuarios": ["LOGIN1", "LOGIN2"]
   }
   ```

## Uso

**Localmente:**

```bash
npm start
```

Acesse `http://localhost:5020`.

**Em produção, com PM2:**

```bash
pm2 start pm2/ecosystem.config.js
```

O `ecosystem.config.js` resolve todos os caminhos (script, `cwd`, logs) a partir da raiz do projeto, então funciona independente de onde o comando `pm2` é executado.

## Estrutura do projeto

```
server.js               Rotas Express, sessão, formatação de request/response
vitae.js                Toda a automação do VITAE (login HTTP + Puppeteer)
views/                  Páginas estáticas (login e tela de consulta)
json/                   Configuração local (allowlist de usuários, cache de unidades)
pm2/ecosystem.config.js Configuração do PM2 para produção
logs/                   Logs de execução (gerados em runtime)
sessions/               Sessões persistidas em disco (geradas em runtime)
```

## Segurança e dados sensíveis

Este projeto lida com credenciais reais de funcionários e dados de pacientes/usuários de um sistema hospitalar. Nunca versionar:

- `.env` — segredos de configuração
- `sessions/*.json` — contêm a senha do VITAE em texto puro enquanto uma sessão está ativa (necessário para reautenticar o usuário nas confirmações que o VITAE exige)
- `logs/*.log` — contêm nomes, e-mails, logins e unidades reais capturados durante o uso
- `json/usuarios_permitidos.json` — lista real de funcionários autorizados

Todos esses caminhos já estão no `.gitignore`. Antes de qualquer commit, confira `git status` para garantir que nenhum deles foi acidentalmente adicionado. Mais detalhes em [`CLAUDE.md`](./CLAUDE.md#security--what-never-goes-in-git).

## Projeto relacionado

`bot/vitae.js` (repositório separado, bot de WhatsApp) compartilha a mesma origem de automação do VITAE. A única diferença pretendida entre os dois é quem atua como agente: o bot sempre usa uma credencial fixa do `.env`; esta aplicação web sempre usa a credencial de quem está logado.
