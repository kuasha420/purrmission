
import http from 'http';

const PORT = 3000;

const projects = [
    { id: 'proj_123', name: 'POCI Infra', description: 'Dogfooding' }
];

const envs = [
    { id: 'env_dev', name: 'Development', slug: 'dev', projectId: 'proj_123' },
    { id: 'env_prod', name: 'Production', slug: 'prod', projectId: 'proj_123' }
];

const secrets = {
    'env_dev': {
        'DATABASE_URL': 'postgres://mock:mock@localhost:5432/poci',
        'API_KEY': 'sk_test_mocked_value_for_pull'
    }
}

const server = http.createServer((req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const auth = req.headers['authorization'];
    if (!auth) { // || !auth.startsWith('Bearer ')) {
        // Relaxed auth for mock
        console.log('⚠️  Mock API: Missing Auth Header (Testing Mode)');
        // res.writeHead(401); res.end('Unauthorized'); return;
    }

    console.log(`[Mock API] ${req.method} ${req.url}`);

    if (req.method === 'GET' && req.url === '/api/projects') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
        return;
    }

    // Auth: Device Code
    if (req.method === 'POST' && req.url === '/api/auth/device/code') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            device_code: 'mock_device_code',
            user_code: 'MOCK-USER',
            verification_uri: 'http://localhost:3000/verify',
            expires_in: 300,
            interval: 1
        }));
        return;
    }

    // Auth: Token
    if (req.method === 'POST' && req.url === '/api/auth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            access_token: 'mock_bearer_token',
            token_type: 'Bearer',
            expires_in: 3600
        }));
        return;
    }

    // Push Secrets
    if (req.method === 'PUT' && req.url.match(/\/api\/projects\/.*\/environments\/.*\/secrets/)) {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            console.log('[Mock API] Received Secrets:', body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
        return;
    }

    // Pull Secrets
    if (req.method === 'GET' && req.url.match(/\/api\/projects\/.*\/environments\/.*\/secrets/)) {
        // Extract envId for simplicity, or just return default
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ secrets: secrets['env_dev'] }));
        return;
    }

    if (req.method === 'GET' && req.url.match(/\/api\/projects\/.*\/environments/)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envs));
        return;
    }

    res.writeHead(404);
    res.end('Not Found');
});

server.listen(PORT, () => {
    console.log(`Mock API running on http://localhost:${PORT}`);
});
