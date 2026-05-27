module.exports = {
  apps: [
    {
      name: 'disco-store',
      script: 'src/store/server.js',
      watch: false,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'disco-bot',
      script: 'src/index.js',
      watch: false,
      autorestart: true,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
