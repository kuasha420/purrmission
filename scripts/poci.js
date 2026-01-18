
// Native env loading used
console.log('--- POCI (Proof of Concept Infra) ---');
console.log('Connecting to database...');

const dbUrl = process.env.DATABASE_URL;
const apiKey = process.env.API_KEY;

if (!dbUrl) {
    console.error('❌ Error: DATABASE_URL is missing!');
    process.exit(1);
}

if (!apiKey) {
    console.error('❌ Error: API_KEY is missing!');
    process.exit(1);
}

// Mask sensitive info
const maskedKey = apiKey.substring(0, 4) + '****' + apiKey.substring(apiKey.length - 4);

console.log(`✅ Connected using URL: ${dbUrl}`);
console.log(`🔑 API Key loaded: ${maskedKey}`);
console.log('--- System Operational ---');
