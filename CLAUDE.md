# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A small Express web app used by hospital staff to look up a user in the **VITAE** system (a JSF/RichFaces web application, not an API) and transfer that user's unit ("Entidade"/"Setor") to `HOSPITAL REGIONAL NORTE`. It also supports managing a user's "Especialidade" (specialty) records and viewing their groups. There is no database — VITAE itself is the system of record, and this app drives it via Puppeteer using the browsing session of whichever staff member is logged in.

## Commands

- Install: `npm install`
- Run: `npm start` (runs `node server.js`, default port `5020`, override with `PORT` env var)
- Process manager: `pm2/ecosystem.config.js` is a PM2 config (`pm2 start pm2/ecosystem.config.js`) used in production; it builds absolute paths off `__dirname/..` (project root) for `script`, `cwd`, and the log files, so it works no matter what directory `pm2` is invoked from. `cwd` is set explicitly to the project root because `dotenv` reads `.env` from `process.cwd()`, which would otherwise resolve to `pm2/` (PM2's default cwd is the ecosystem file's directory) and silently fail to load `.env`.
- No test suite, linter, or build step exists in this repo.

## Configuration

Required in `.env` (project root, not committed): `VITAE_URL`, `SESSION_SECRET`. `VITAE_USERNAME`/`VITAE_PASSWORD` exist as a fallback default agent but the normal flow uses the logged-in web user's own credentials as the agent. `server.js` refuses to start if `SESSION_SECRET` is missing (no hardcoded fallback) — a public fallback string would let anyone who's seen the source forge session cookies. Copy `.env.example` to `.env` and fill in real values; generate `SESSION_SECRET` with e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

`json/usuarios_permitidos.json` is an explicit allowlist of VITAE logins permitted to use this app (checked in `/login` before any credential validation, case-insensitive) — it's real staff data, gitignored, not committed; copy `json/usuarios_permitidos.example.json` to seed it. `json/unidades.json` (gitignored, generated on first use by `salvarOpcoesUnidadesJson` in `vitae.js`) caches the unit dropdown options.

## Security / what never goes in git

This repo handles real hospital-staff credentials and PII, so treat these as absolute rules, not suggestions, when touching `.gitignore` or adding new persistence:
- `.env`, `sessions/*.json` (plaintext VITAE passwords via `req.session.password`, see below), `logs/*.log` (real names/emails/logins/units captured from production use), and `json/usuarios_permitidos.json` (real staff allowlist) are all gitignored — verify `git status` shows none of them before every commit, especially the first one when turning this into a public/shared repo.
- Don't add a literal fallback value for `SESSION_SECRET` or any credential — fail fast instead (see `server.js`'s startup check). A fallback baked into source is a fallback anyone reading the repo can use.
- Don't hardcode real email addresses, hostnames, or credentials as defaults in code (`vitae.js`'s `enviarCodigoEmailVitae` uses a generic `no-reply@localhost` fallback for exactly this reason) — pull them from `config`/`.env` or leave them unset.

## Architecture

**`server.js`** — Express routes, session handling (`express-session`), and request/response shaping. No business logic or Puppeteer calls live here directly; everything VITAE-related is delegated to `vitae.js`. Express sessions are persisted to disk via `session-file-store` (one JSON file per session under `sessions/`, gitignore-worthy/not committed) instead of the default `MemoryStore`, so login state (including `req.session.password`, kept for re-authenticating as the agent mid-flow — see below) survives a server/PM2 restart. Note this only persists the *Express* session; the Puppeteer browser tied to it (see below) is in-memory only and is always gone after a restart, so `iniciarNavegador` re-opens it lazily on the next `/api/*` call using the restored session credentials.

**`vitae.js`** — all VITAE automation. Two layers:
1. A one-shot HTTP login (`loginHttp`, via `axios` + `tough-cookie`) that authenticates without a browser and extracts session cookies.
2. A Puppeteer browser session (`iniciarNavegador`) that has those cookies injected via `page.setCookie`, then navigates the JSF app and drives it by XPath (JSF/RichFaces render mostly non-semantic HTML, so nearly all element lookups are XPath constants at the top of the file, e.g. `XPATH_ENTIDADE`, `XPATH_SETOR`, `XPATH_ABA_ESPECIALIDADE`).

**Per-request session model**: each browser tab is keyed in an in-memory `Map` (`sessions`) by `from = "web-${req.sessionID}"` — one Puppeteer session per logged-in Express session, reused across `/api/*` calls rather than relaunching per request. `obterSessao(from)` exposes the raw `{ browser, page, ... }` session object; `fecharSessao(from)` closes the browser and removes it from the map. There is no session cleanup/expiry sweep — a browser stays open until `/logout` or an explicit `fecharSessao` call.

**Login on `/login` does double duty**: it validates credentials via `loginHttp` *and* immediately opens the Puppeteer session (`iniciarNavegador`) so that the subsequent `/api/pesquisar`/`/api/transferir` calls reuse an already-authenticated browser instead of logging in again per request.

**The "agent" concept**: every VITAE write (transfer, specialty edit) is performed as the currently logged-in staff member, not a fixed admin account. `req.session.password` is kept in the session specifically so the app can re-authenticate as that same user mid-flow (VITAE requires re-entering the password in a modal to confirm most changes — see `confirmarAlteracaoComSenha`).

**Transfer flow (`transferirUnidadeUsuario`) is the most sensitive piece of logic.** VITAE only allows editing a user whose unit matches the acting agent's own unit, so a transfer is not a single write:
1. Look up the target user, capture their current unit.
2. Temporarily change the *agent's own* unit/sector to match the target's, so the agent is authorized to edit them.
3. Log off/on again (VITAE only honors a permission-scope change after a fresh login) and edit the target user to `HOSPITAL REGIONAL NORTE` / `AMBULATÓRIO`.
4. Restore the agent's original unit/sector.

If any step from (2) onward throws, the `catch` block always attempts to restore the agent's original unit before returning an error (`restaurarUnidadeAgenteComRetry`, which retries once with a full relogin) — an agent account getting permanently stuck in the target's unit is a real incident that has happened before, per the comments in the code. When touching this function, preserve that invariant: never let an error path return without attempting restoration if `agenteFoiAlterado` is true.

Step 3's edit of the target calls `alterarEntidadeSetor(page, HOSPITAL_REGIONAL_NORTE_VALOR, SETOR_AMBULATORIO_NOME, senhaAgente, true)` — the trailing `true` (`garantirGrupoConsulta`) matters: VITAE refuses to save the Entidade/Setor change if the target user has zero groups, which happens on some real accounts, so `alterarEntidadeSetor` checks the target's groups first and adds the `CONSULTA` group (via `adicionarGrupoConsulta`/`adicionarGrupo`) if none are present, before confirming. This step is *not* applied when moving the agent's own unit (steps 2 and 4 call `alterarEntidadeSetor` without that 5th argument) — only the transfer target needs it. `adicionarGrupo` interacts with a RichFaces `rich:listShuttle` picklist and deliberately uses `clicarReal` (a real Puppeteer mouse click at the element's coordinates) instead of the usual `clicar` (a synthetic `element.click()`) for selecting the item — the synthetic click visually highlights the row but doesn't trigger the shuttle's internal logic that enables the "move" button.

**Two-tier search result handling**: `buscarUsuarioVitae` distinguishes "not found", "found but inactive" (caso 1), and "found active but not editable by this agent — wrong unit scope" (caso 2, still returns name/login/unit scraped from the listing row) from a normal editable result. `server.js`'s `avaliarResultadoBusca` normalizes all of these into one shape for the frontend. Keep this distinction when modifying search — caso 2 is not an error, it's actionable information shown to the user. Note this caso 1/2 detection only fires for CPF searches: `preencherCampoPesquisa` forces the "Ativo" radio when searching by login or nome (VITAE's "Todos" filter returns zero results for those two search types, not just inactive ones), which as a side effect makes inactive users invisible to a login/nome search — only a CPF search can currently produce caso 1/2.

**Specialty ("Especialidade") edits** require the record's edit modal to already be open from a prior search in the same session (`obterSessao(from)?.page`), and after add/remove + save, the app deliberately closes and reopens the whole session (`relogarAposAlteracao`) rather than just waiting, to guarantee a clean JSF ViewState before the frontend's automatic re-search.

**`views/login.html` and `views/consulta.html`** are static HTML served directly (no templating engine); `consulta.html` is plain JS/fetch hitting the `/api/*` JSON endpoints listed above.

## Related project

`C:\Mega\Projeto BOT WPP - IA` (`bot/vitae.js`) is a WhatsApp-bot sibling that shares the same VITAE automation origin (near-identical XPath constants, function names, and comments) but has since diverged. Its only *intended* difference from this app is who the acting agent is: the bot always uses the fixed `.env` credentials (`iniciarNavegador(from)` is called with no username/password in `bot.js`), while this app always uses the credentials of whoever is logged into the web session. Bug fixes discovered in one project don't automatically make it into the other — check both when debugging a VITAE automation issue that might be systemic rather than app-specific.

## Working in this codebase

- XPaths are tied to VITAE's current DOM/ids. If VITAE changes, XPath constants (top of `vitae.js`) are the first thing to check/update, not the surrounding control flow.
- Timing (`sleep(...)`) calls after most Puppeteer interactions exist because RichFaces AJAX has no reliable completion signal in many cases; several comments explain *why* a particular wait or active-poll (`waitForFunction`) was chosen over a fixed sleep — read the comment before changing/removing one, since some encode a fix for a previously-seen race condition.
- `console.log` with emoji prefixes is the only logging in this app (feeds into PM2 log files); there's no structured logger.
- `sessions/*.json` files hold the logged-in user's VITAE password in plaintext (see `req.session.password` above) — treat that directory with the same care as `.env`, don't commit it, and don't dump its contents casually.
