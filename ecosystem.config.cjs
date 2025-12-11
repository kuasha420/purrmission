module.exports = {
    apps: [
        {
            name: "Purrmission",
            script: "./apps/purrmission-bot/dist/index.js",
            cwd: "./",
            env: {
                NODE_ENV: "production",
            },
        },
    ],
};
