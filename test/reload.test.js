import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';

test('real Pi resource reload refreshes message projection helpers, not cached JavaScript', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-remote-reload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = await readFile(new URL('../src/protocol.ts', import.meta.url), 'utf8');
  const fallback = 'The model provider returned an error without a message.';
  await writeFile(join(dir, 'protocol.ts'), source.replace(fallback, 'First projection'));
  await writeFile(join(dir, 'extension.ts'), `import { publicMessage } from './protocol.ts';
    export default function (pi) {
      pi.registerCommand('projection', { handler: (_args, ctx) => {
        ctx.ui.notify(publicMessage({ role: 'assistant', content: [], stopReason: 'error' }).errorMessage);
      } });
    }`);
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [join(dir, 'extension.ts')] });
  const project = async () => {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const command = loader.getExtensions().extensions.find(extension => extension.commands.has('projection')).commands.get('projection');
    let result;
    await command.handler('', { ui: { notify: text => { result = text; } } });
    return result;
  };
  assert.equal(await project(), 'First projection');
  await writeFile(join(dir, 'protocol.ts'), source.replace(fallback, 'Reloaded projection'));
  assert.equal(await project(), 'Reloaded projection');
});
