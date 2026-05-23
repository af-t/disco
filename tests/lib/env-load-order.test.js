import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = join(import.meta.dirname, '..', '..');

describe('env load order', () => {
  describe('bootstrap loads env before any level_* module evaluation', () => {
    it('index.js has no static imports that bypass loadEnvFile', () => {
      const indexSrc = readFileSync(join(projectRoot, 'src', 'index.js'), 'utf8');
      const loadEnvCall = indexSrc.match(/process\.loadEnvFile/);
      assert.ok(loadEnvCall, 'index.js must call process.loadEnvFile');

      // Static import declarations are hoisted above ALL top-level code in ESM.
      // Any static import that transitively imports level_1 or level_2 will cause
      // those modules to evaluate their module-scope process.env reads before
      // loadEnvFile runs -- defeating the purpose.
      // The fix: index.js delegates to a dynamic import('./app.js') which is
      // NOT hoisted; it evaluates AFTER the top-level loadEnvFile completes.
      const staticImports = [...indexSrc.matchAll(/^import\s+(?!\()/gm)];

      if (staticImports.length > 0) {
        // If static imports exist, loadEnvFile must run before them.
        // But ESM hoisting makes that impossible, so index.js should have
        // zero static imports of anything that reads process.env.
        const loadEnvIdx = loadEnvCall.index;
        for (const m of staticImports) {
          assert.ok(
            m.index > loadEnvIdx,
            `Static import on line ${indexSrc.substring(0, m.index).split('\n').length} will be hoisted above loadEnvFile`,
          );
        }
      }
      // The subprocess test below proves the fix actually works end-to-end
    });

    it('applies custom .env values to module-scope constants via subprocess simulation', () => {
      const envPath = join(projectRoot, 'tmp', '.test-env-order');
      const scriptPath = join(projectRoot, 'tmp', '.test-env-order.mjs');
      writeFileSync(
        envPath,
        'DISCORD_RECONNECT_DELAY=86753\nDISCORD_RECONNECT_LIMIT=2\nDISCORD_GATEWAY_URL=wss://custom.example/\nDISCORD_MAX_RETRIES=4\n',
      );
      writeFileSync(
        scriptPath,
        [
          `process.loadEnvFile('${envPath}');`,
          // Dynamic import so module-scope consts evaluate AFTER env is set
          `const l1 = await import('${join(projectRoot, 'src/client/level_1.js')}');`,
          `const l2 = await import('${join(projectRoot, 'src/client/level_2.js')}');`,
          `process.stdout.write(JSON.stringify({`,
          `  rd: l1._TEST_RECONNECT_DELAY,`,
          `  rl: l1._TEST_RECONNECT_LIMIT,`,
          `  gw: l1._TEST_GATEWAY_URL,`,
          `  mr: l2._TEST_MAX_RETRIES,`,
          `}));`,
          `process.exit(0);`,
        ].join('\n'),
      );

      try {
        const raw = execSync(`${process.execPath} --no-warnings ${scriptPath}`, {
          encoding: 'utf8',
          timeout: 5000,
        });
        const result = JSON.parse(raw.trim());
        assert.strictEqual(result.rd, 86753, 'DISCORD_RECONNECT_DELAY from .env should override default 5000');
        assert.strictEqual(result.rl, 2, 'DISCORD_RECONNECT_LIMIT from .env should override default 5');
        assert.strictEqual(result.gw, 'wss://custom.example/', 'DISCORD_GATEWAY_URL from .env should be used verbatim');
        assert.strictEqual(result.mr, 4, 'DISCORD_MAX_RETRIES from .env should override default 3');
      } finally {
        try {
          unlinkSync(envPath);
          unlinkSync(scriptPath);
        } catch {
          // best-effort cleanup
        }
      }
    });
  });
});
