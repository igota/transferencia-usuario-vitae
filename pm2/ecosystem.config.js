const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');

module.exports = {
    apps: [
        {
            name: 'transferencia-usuario',
            script: path.join(ROOT_DIR, 'server.js'),
            cwd: ROOT_DIR, // garante que o dotenv (que lê process.cwd()/.env) ache o .env na raiz do projeto
            instances: 1,
            autorestart: true,
            watch: false,
            max_memory_restart: '500M',
            env: {
                NODE_ENV: 'production'
            },
            error_file: path.join(ROOT_DIR, 'logs', 'transferencia-error.log'),
            out_file: path.join(ROOT_DIR, 'logs', 'transferencia-out.log'),
            log_file: path.join(ROOT_DIR, 'logs', 'transferencia-combined.log'),
            time: true,
            merge_logs: true,
            log_date_format: 'YYYY-MM-DD HH:mm:ss'
        }
    ]
};
