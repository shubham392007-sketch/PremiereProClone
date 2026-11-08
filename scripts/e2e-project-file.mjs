import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`PAGEERROR ${error.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

try {
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /New Project/i }).first().click();
  await page.locator('input[placeholder="My Video Edit"]').fill('Portable Project');
  await page.getByRole('button', { name: /Create Project/i }).click();
  await page.waitForFunction(() => Boolean(window.__PREMIERE_DEBUG__?.snapshot().projectId));

  // Return to the project home through the File menu.
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('button', { name: 'Close Project', exact: true }).click();
  await page.getByRole('button', { name: /New Project/i }).first().waitFor();

  // Export the portable project file from the card context menu.
  const card = page.locator('div[role="button"]').filter({ hasText: 'Portable Project' }).first();
  await card.hover();
  await card.getByRole('button', { name: 'Project options' }).click();
  const downloadPromise = page.waitForEvent('download', { timeout: 20000 });
  await page.getByRole('button', { name: /Export Project File/ }).click();
  const download = await downloadPromise;
  const projectPath = path.join(OUT, 'project-export.premiereweb.json');
  await download.saveAs(projectPath);
  const raw = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  if (raw.name !== 'Portable Project' || !Array.isArray(raw.sequences) || raw.sequences.length !== 1) {
    throw new Error('Exported project JSON is missing expected project data');
  }
  console.log('Project file export OK:', fs.statSync(projectPath).size, 'bytes');

  // Import the portable project through the Project Home import button.
  await page.locator('input[type="file"][accept*="json"]').setInputFiles(projectPath);
  await page.waitForFunction(
    () => document.body.innerText.includes('Project imported') || document.querySelectorAll('div[role="button"]').length >= 2,
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(800);
  const cards = await page.locator('div[role="button"]').filter({ hasText: 'Portable Project' }).count();
  if (cards < 2) throw new Error(`Expected the imported project card, found ${cards}`);
  console.log('Project file import OK: imported project appears on the home screen');

  // Open the imported project and verify it is editable (media offline is expected).
  await page.locator('div[role="button"]').filter({ hasText: 'Portable Project' }).first().click();
  await page.locator('[data-testid="media-panel"]').waitFor({ timeout: 20000 });
  const snapshot = await page.evaluate(() => window.__PREMIERE_DEBUG__.snapshot());
  if (!snapshot.projectId || snapshot.sequence.clips.length !== 0) {
    throw new Error('Imported project did not open with its empty sequence');
  }
  console.log('Imported project opens in the editor OK');
  console.log('CONSOLE ERRORS:', errors);
  await browser.close();
  process.exit(0);
} catch (error) {
  console.error('PROJECT FILE TEST FAILED:', error);
  console.error('Console errors:', errors);
  await page.screenshot({ path: path.join(OUT, 'project-file-failure.png') });
  await browser.close();
  process.exit(1);
}
