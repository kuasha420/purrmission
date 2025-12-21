module.exports = {
    apps: [
        {
            name: "Purrmission",
            script: "./apps/purrmission-bot/dist/index.js",
            cwd: "./", // .env file must be in this directory (project root)
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
