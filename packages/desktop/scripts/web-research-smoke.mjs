// Exercise real Chromium hydration and sandboxing; HTTPS fixtures are intercepted
// in this test only. The production network proxy has separate boundary tests.
import assert from 'node:assert/strict';
import { app, BrowserWindow, session } from 'electron';
import { renderResearchPage } from '../src/main/web-research-browser.ts';
import { extractWebPage } from '../../agent-runtime/dist/web-page-reader.js';

const timeout = setTimeout(() => { console.error('Web research smoke timed out'); app.exit(1); }, 30_000);
app.on('window-all-closed', () => {});
void app.whenReady().then(async () => {
const original = session.fromPartition;
const partitions = [];
session.fromPartition = function (name, options) {
  const isolated = original.call(session, name, options);
  partitions.push(isolated);
  isolated.protocol.handle('https', () => new Response(`<!doctype html><title>Hydrated article</title><main>Loading</main><script>
    setTimeout(() => {
      document.querySelector('main').innerHTML = '<article><h1>Hydrated article</h1><p>' +
        'Research content rendered by JavaScript. '.repeat(20) + '</p><p>Node access: ' + typeof require + '</p></article>';
    }, 150);
  </script>`, { headers: { 'Content-Type': 'text/html' } }));
  return isolated;
};
try {
  await session.defaultSession.cookies.set({ url: 'https://example.org', name: 'private-blame-cookie', value: 'never-share' });
  const page = await renderResearchPage('https://example.org/article', new AbortController().signal);
  const extracted = extractWebPage(page.html, page.url, page.url, 'electron');
  assert.equal(extracted.status, 'read');
  assert.match(extracted.content, /Research content rendered by JavaScript/);
  assert.match(extracted.content, /Node access: undefined/);
  assert.equal((await partitions[0].cookies.get({})).length, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await assert.rejects(renderResearchPage('http://127.0.0.1/', new AbortController().signal));
  await assert.rejects(renderResearchPage('https://example.org/', AbortSignal.abort(new Error('cancelled'))), /cancelled/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  console.log('Electron web research passed: JS hydration, Readability, sandbox, session isolation, cleanup and cancellation.');
  clearTimeout(timeout); app.exit(0);
} catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }

});
