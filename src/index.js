// dynamic import escapes ESM hoisting
try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional in production deployments
}

await import('./app.js');
