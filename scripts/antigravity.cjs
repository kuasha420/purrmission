#!/usr/bin/env node
const { execSync, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// 1. Sync
console.log("🔄 Running Sync...");
try {
    const syncScript = path.join(__dirname, 'sync-mcp.cjs');
    execSync(`node ${syncScript}`, { stdio: "inherit" });
} catch (e) {
    console.error("❌ Sync failed.");
    process.exit(1);
}

// Helper to find project
const PROJECT_ROOT = path.resolve(__dirname, "..");
function findProjectDir(filterName) {
    const searchDirs = ['apps', 'packages'];

    for (const dir of searchDirs) {
        const basePath = path.join(PROJECT_ROOT, dir);
        if (!fs.existsSync(basePath)) continue;

        const items = fs.readdirSync(basePath, { withFileTypes: true });

        for (const item of items) {
            if (!item.isDirectory()) continue;

            // Match directory name (exact)
            if (item.name === filterName) {
                return path.join(basePath, item.name);
            }

            // Match package.json name
            try {
                const pkgPath = path.join(basePath, item.name, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (pkg.name === filterName) {
                        return path.join(basePath, item.name);
                    }
                }
            } catch (e) {
                console.warn(`⚠️  Could not parse package.json in ${path.join(basePath, item.name)}: ${e.message}`);
            }
        }
    }
    return null;
}

// 2. Resolve Target Directory
const args = process.argv.slice(2);
let targetDir = PROJECT_ROOT;

const filterIndex = args.indexOf('--filter');
if (filterIndex !== -1 && filterIndex + 1 < args.length) {
    const filterName = args[filterIndex + 1];
    const foundDir = findProjectDir(filterName);

    if (foundDir) {
        console.log(`🎯 Targeting project: ${foundDir}`);
        targetDir = foundDir;
    } else {
        console.error(`❌ Error: Project '${filterName}' not found.`);
        process.exit(1);
    }
}

// 3. Launch Antigravity IDE
console.log(`🚀 Launching Antigravity IDE in ${targetDir}...`);

// Ensure 'antigravity' command exists
try {
    const checkCmd = process.platform === 'win32' ? 'where' : 'command -v';
    execSync(`${checkCmd} antigravity`, { stdio: 'ignore' });
} catch (e) {
    console.warn("⚠️  'antigravity' command not found in PATH. Assuming User will restart IDE manually.");
    // We don't exit hard here because this script might be run just for the sync part + setup
    process.exit(0);
}

const child = spawn('antigravity', [targetDir], {
    detached: true,
    stdio: 'ignore'
});

child.on('error', (err) => {
    console.error(`❌ Failed to launch Antigravity IDE: ${err.message}`);
    process.exit(1);
});

child.unref();
process.exit(0);
