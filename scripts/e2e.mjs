/**
 * End-to-end acceptance test for Phase 1.
 *
 * Prerequisites:
 *   1. `npm run dev` is running on http://127.0.0.1:5173
 *   2. test-media/ contains the generated sample files (see README)
 *
 * Run: npm run e2e
 *
 * Drives real Chrome via Playwright and verifies the full workflow: project
 * creation -> media import -> timeline editing -> playback -> persistence ->
 * reload -> export. Screenshots are written to test-results/.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'test-results');
const URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MEDIA = (name) => path.join(ROOT, 'test-media', name);

fs.mkdirSync(OUT, { recursive: true });

let step = 0;
const failures = [];
const consoleErrors = [];

function log(message) {
  console.log(`\n=== ${message}`);
}

async function screenshot(page, name) {
  step += 1;
  const file = path.join(OUT, `${String(step).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`screenshot: ${path.relative(ROOT, file)}`);
  return file;
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function snapshot(page) {
  return page.evaluate(() => window.__PREMIERE_DEBUG__.snapshot());
}

async function waitForProject(page) {
  await page.waitForFunction(() => Boolean(window.__PREMIERE_DEBUG__?.snapshot().projectId), null, {
    timeout: 20000,
  });
}

async function dropMedia(page, mediaId, trackName, offsetPx = 20) {
  const track = await page.evaluate((name) => {
    const seq = window.__PREMIERE_DEBUG__.getActiveSequence();
    const t = seq?.tracks.find((track) => track.name === name);
    return t ? { id: t.id, kind: t.kind } : null;
  }, trackName);
  assert(track, `track ${trackName} should exist`);
  const lane = page.locator(`[data-track-kind="${track.kind}"][data-track-id="${track.id}"]`).first();
  await lane.waitFor({ state: 'visible', timeout: 10000 });
  const box = await lane.boundingBox();
  assert(box, `track ${trackName} should have a bounding box`);
  const x = box.x + offsetPx;
  const y = box.y + box.height / 2;
  await page.evaluate(
    ({ x, y, mediaId }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/x-premiere-media', mediaId);
      dataTransfer.setData('text/plain', mediaId);
      const target = document.elementFromPoint(x, y);
      if (!target) throw new Error('No drop target at point');
      for (const type of ['dragover', 'drop']) {
        target.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer,
            clientX: x,
            clientY: y,
          }),
        );
      }
    },
    { x, y, mediaId },
  );
  await page.waitForTimeout(250);
}

async function mouseDrag(page, locator, dx, dy = 0, fromRatio = 0.5) {
  const box = await locator.boundingBox();
  assert(box, 'element should have a bounding box for drag');
  const startX = box.x + box.width * fromRatio;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 6 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

/** Read a pixel (RGB) from the program monitor canvas at relative coordinates. */
async function canvasPixel(page, xRatio, yRatio) {
  return page.evaluate(
    ({ xRatio, yRatio }) => {
      const canvas = document.querySelector('[data-testid="program-canvas"]');
      if (!canvas) throw new Error('program canvas not found');
      const ctx = canvas.getContext('2d');
      const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(canvas.width * xRatio)));
      const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(canvas.height * yRatio)));
      const data = ctx.getImageData(x, y, 1, 1).data;
      return [data[0], data[1], data[2]];
    },
    { xRatio, yRatio },
  );
}

function colorDistance(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: process.env.HEADED ? false : true,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--disable-features=MediaSessionService',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1050 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Media resource errors are expected when testing offline/missing files.
      consoleErrors.push(text);
      console.log(`[browser console error] ${text}`);
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
    console.log(`[page error] ${error.message}`);
  });

  try {
    log('1. Project home loads');
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /New Project/i }).first().waitFor();
    await page.waitForFunction(() => Boolean(window.__PREMIERE_DEBUG__));
    await screenshot(page, 'project-home');

    log('2. Create a 1080p / 30fps project');
    await page.getByRole('button', { name: /New Project/i }).first().click();
    await page.locator('input[placeholder="My Video Edit"]').fill('E2E Acceptance Project');
    await page.locator('input[placeholder="Sequence 01"]').fill('Acceptance Sequence');
    await screenshot(page, 'new-project-dialog');
    await page.getByRole('button', { name: /Create Project/i }).click();
    await waitForProject(page);
    await page.locator('[data-testid="media-panel"]').waitFor();
    await screenshot(page, 'editor-empty');

    let state = await snapshot(page);
    assert(state.projectName === 'E2E Acceptance Project', 'project name persisted to store');
    assert(state.sequence.width === 1920 && state.sequence.height === 1080, 'sequence is 1080p');
    assert(state.sequence.frameRate.label === '30', 'sequence frame rate is 30fps');

    log('3. Import two videos, audio and images');
    const fileInput = page.locator('[data-testid="media-file-input"]');
    await fileInput.waitFor({ state: 'attached' });
    await fileInput.setInputFiles([
      MEDIA('video-a.mp4'),
      MEDIA('video-b.mp4'),
      MEDIA('audio-tone.mp3'),
      MEDIA('image-red.jpg'),
      MEDIA('image-green.png'),
    ]);
    await page.waitForFunction(
      () => window.__PREMIERE_DEBUG__.snapshot().media.length >= 5,
      null,
      { timeout: 90000 },
    );
    state = await snapshot(page);
    assert(state.media.length === 5, `expected 5 imported assets, got ${state.media.length}`);
    const byName = (name) => state.media.find((m) => m.fileName === name);
    assert(byName('video-a.mp4'), 'video-a imported');
    assert(byName('video-a.mp4').durationSec > 3, 'video duration probed');
    assert(byName('video-a.mp4').width === 1280, 'video dimensions probed');
    assert(byName('video-a.mp4').thumbnailDataUrl?.startsWith('data:image'), 'video thumbnail generated');
    assert(byName('audio-tone.mp3').kind === 'audio', 'audio typed as audio');
    assert(byName('image-green.png').kind === 'image', 'image typed as image');
    await screenshot(page, 'media-imported');

    log('4. Drag media onto V1, V2, V3 and A1');
    const videoA = byName('video-a.mp4');
    const videoB = byName('video-b.mp4');
    const audio = byName('audio-tone.mp3');
    const imageRed = byName('image-red.jpg');
    const imageGreen = byName('image-green.png');

    await dropMedia(page, videoA.id, 'V1', 20);
    await dropMedia(page, videoB.id, 'V1', 320);
    await dropMedia(page, imageRed.id, 'V2', 40);
    await dropMedia(page, imageGreen.id, 'V3', 120);
    await dropMedia(page, audio.id, 'A1', 30);
    state = await snapshot(page);
    assert(state.sequence.clips.length === 5, `expected 5 timeline clips, got ${state.sequence.clips.length}`);
    assert(
      state.sequence.clips.filter((c) => c.trackId === state.sequence.tracks.find((t) => t.name === 'V1').id).length === 2,
      'two clips on V1',
    );
    await screenshot(page, 'timeline-clips');

    log('5. Select, move, trim, split, delete, undo and redo');
    const firstClip = state.sequence.clips.find((c) => c.mediaId === videoA.id);
    await page.locator(`[data-clip-id="${firstClip.id}"]`).click({ position: { x: 40, y: 20 } });
    const startBefore = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id).startFrame;
    await mouseDrag(page, page.locator(`[data-clip-id="${firstClip.id}"]`), 60);
    let moved = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    assert(moved.startFrame > startBefore, 'clip moved right on drag');
    await page.keyboard.press('Control+z');
    moved = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    assert(moved.startFrame === startBefore, 'undo restored clip position');
    await page.keyboard.press('Control+Shift+z');
    moved = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    assert(moved.startFrame > startBefore, 'redo re-applied clip movement');
    await page.keyboard.press('Control+z');

    // trim end by dragging the right trim handle (top-right corner of clip)
    const clipLocator = page.locator(`[data-clip-id="${firstClip.id}"]`);
    const clipBox = await clipLocator.boundingBox();
    const beforeTrim = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    await page.mouse.move(clipBox.x + clipBox.width - 3, clipBox.y + clipBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(clipBox.x + clipBox.width - 60, clipBox.y + clipBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    let afterTrim = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    assert(afterTrim.durationFrames < beforeTrim.durationFrames, 'trim reduced clip duration');
    await page.keyboard.press('Control+z');
    afterTrim = (await snapshot(page)).sequence.clips.find((c) => c.id === firstClip.id);
    assert(afterTrim.durationFrames === beforeTrim.durationFrames, 'undo restored trimmed duration');

    // split the first clip at its midpoint via playhead + Ctrl+K
    const beforeSplit = await snapshot(page);
    const targetClip = beforeSplit.sequence.clips.find((c) => c.id === firstClip.id);
    const middle = targetClip.startFrame + Math.floor(targetClip.durationFrames / 2);
    await page.evaluate((frame) => window.__PREMIERE_DEBUG__.programPlayback.seek(frame), middle);
    await page.locator(`[data-clip-id="${firstClip.id}"]`).click({ position: { x: 10, y: 20 } });
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(200);
    const afterSplit = await snapshot(page);
    assert(afterSplit.sequence.clips.length === beforeSplit.sequence.clips.length + 1, 'split added a clip');
    const left = afterSplit.sequence.clips.find((c) => c.id === firstClip.id);
    const right = afterSplit.sequence.clips.find(
      (c) => c.startFrame === middle && c.mediaId === videoA.id && c.id !== firstClip.id,
    );
    assert(right, 'split produced right-hand clip at playhead');
    assert(left.startFrame + left.durationFrames === middle, 'left clip ends at playhead');
    await page.keyboard.press('Control+z');

    // delete and undo
    const beforeDelete = (await snapshot(page)).sequence.clips.length;
    await page.locator(`[data-clip-id="${firstClip.id}"]`).click({ position: { x: 10, y: 20 } });
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    assert((await snapshot(page)).sequence.clips.length === beforeDelete - 1, 'delete removed clip');
    await page.keyboard.press('Control+z');
    assert((await snapshot(page)).sequence.clips.length === beforeDelete, 'undo restored deleted clip');

    log('5.1 Track creation and undo');
    await page.locator('[data-testid="add-video-track"]').click();
    await page.waitForTimeout(200);
    assert(
      (await snapshot(page)).sequence.tracks.filter((t) => t.kind === 'video').length === 4,
      'add video track created V4',
    );
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);
    assert(
      (await snapshot(page)).sequence.tracks.filter((t) => t.kind === 'video').length === 3,
      'undo removed added video track',
    );
    await page.locator('[data-testid="add-audio-track"]').click();
    await page.waitForTimeout(200);
    assert(
      (await snapshot(page)).sequence.tracks.filter((t) => t.kind === 'audio').length === 4,
      'add audio track created A4',
    );
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(150);

    await page.keyboard.press('Control+s');
    await page.waitForTimeout(700);

    log('6. Playback and frame stepping');
    await page.evaluate(() => window.__PREMIERE_DEBUG__.programPlayback.seek(0));
    await page.locator('[data-testid="program-play"]').click();
    await page.waitForTimeout(1200);
    let playing = await snapshot(page);
    assert(playing.isPlaying, 'program is playing');
    assert(playing.currentFrame > 10, `playhead advanced during playback (frame ${playing.currentFrame})`);
    await page.locator('[data-testid="program-play"]').click();
    await page.waitForTimeout(150);
    const pausedFrame = (await snapshot(page)).currentFrame;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(120);
    const stepped = await snapshot(page);
    assert(stepped.currentFrame === pausedFrame + 1, `frame step advanced exactly one frame (${pausedFrame} -> ${stepped.currentFrame})`);
    await screenshot(page, 'program-monitor');

    log('6.1 Source Monitor: preview, mark in/out, insert range');
    await page.evaluate(() => window.__PREMIERE_DEBUG__.programPlayback.pause());
    const sourceAsset = byName('video-a.mp4');
    await page
      .locator(`[data-testid="media-asset"][data-media-id="${sourceAsset.id}"]`)
      .first()
      .dblclick();
    await page.waitForFunction(() => {
      const video = document.querySelector('[data-testid="source-monitor"] video');
      return Boolean(video && video.readyState >= 1 && window.__PREMIERE_DEBUG__.stores.playback.getState().source.mediaId);
    }, null, { timeout: 20000 });
    await page.evaluate(() => window.__PREMIERE_DEBUG__.sourcePlayback.seek(30));
    await page.waitForTimeout(300);
    await page.locator('[data-testid="source-mark-in"]').click();
    await page.evaluate(() => window.__PREMIERE_DEBUG__.sourcePlayback.seek(60));
    await page.waitForTimeout(300);
    await page.locator('[data-testid="source-mark-out"]').click();
    const marks = await page.evaluate(() => window.__PREMIERE_DEBUG__.stores.playback.getState().source);
    assert(marks.inFrame === 30 && marks.outFrame === 60, `source in/out marks set (${marks.inFrame}-${marks.outFrame})`);
    const beforeInsert = (await snapshot(page)).sequence.clips.length;
    await page.locator('[data-testid="source-insert"]').click();
    await page.waitForTimeout(400);
    const insertedState = await snapshot(page);
    assert(insertedState.sequence.clips.length === beforeInsert + 1, 'source range inserted as a timeline clip');
    const insertedClip = insertedState.sequence.clips.find((c) => c.id === insertedState.selectedClipIds[0]);
    assert(insertedClip, 'inserted clip is selected');
    assert(insertedClip.sourceInFrame === 30, `inserted clip source in = 30 (got ${insertedClip.sourceInFrame})`);
    assert(insertedClip.durationFrames === 30, `inserted clip duration = 30 (got ${insertedClip.durationFrames})`);
    await screenshot(page, 'source-monitor-marks');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__PREMIERE_DEBUG__.stores.playback.getState().closeSource());

    log('6.2 Properties changes affect the live composite');
    await page.evaluate(() => window.__PREMIERE_DEBUG__.programPlayback.seek(90));
    await page.waitForTimeout(600);
    const greenClip = (await snapshot(page)).sequence.clips.find((c) => c.mediaId === imageGreen.id);
    assert(greenClip, 'green image clip on timeline');
    await page.locator(`[data-clip-id="${greenClip.id}"]`).click({ position: { x: 20, y: 20 } });
    await page.waitForTimeout(500);
    const centerBefore = await canvasPixel(page, 0.5, 0.5);
    const cornerBefore = await canvasPixel(page, 0.03, 0.5);
    assert(centerBefore[1] > centerBefore[0] + 30 && centerBefore[1] > centerBefore[2] + 30, `green image visible at center via compositing (${centerBefore})`);
    const scaleInput = page
      .locator('[data-testid="properties-panel"] label:text-is("Scale")')
      .first()
      .locator('xpath=following::input[1]');
    await scaleInput.fill('50');
    await scaleInput.press('Enter');
    await page.waitForTimeout(800);
    const scaledClip = (await snapshot(page)).sequence.clips.find((c) => c.id === greenClip.id);
    assert(Math.abs(scaledClip.transform.scale - 0.5) < 0.001, 'properties scale applied to clip model');
    const cornerAfter = await canvasPixel(page, 0.03, 0.5);
    assert(colorDistance(cornerBefore, cornerAfter) > 40, `scaling the top clip revealed the track below (${cornerBefore} -> ${cornerAfter})`);
    await screenshot(page, 'properties-composite-scale');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(800);
    const cornerRestored = await canvasPixel(page, 0.03, 0.5);
    assert(colorDistance(cornerBefore, cornerRestored) < 60, `undo restored full-frame composite (${cornerRestored})`);

    log('6.3 Copy and paste at the playhead');
    const beforePaste = (await snapshot(page)).sequence.clips.length;
    await page.locator(`[data-clip-id="${firstClip.id}"]`).click({ position: { x: 10, y: 20 } });
    await page.keyboard.press('Control+c');
    await page.evaluate(() => window.__PREMIERE_DEBUG__.programPlayback.seek(200));
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+v');
    await page.waitForTimeout(400);
    const pastedState = await snapshot(page);
    assert(pastedState.sequence.clips.length === beforePaste + 1, 'paste created a new clip');
    const pasted = pastedState.sequence.clips.find((c) => c.id === pastedState.selectedClipIds[0]);
    assert(pasted && pasted.startFrame === 200, `pasted clip at playhead frame 200 (got ${pasted?.startFrame})`);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);

    log('7. Save, reload, reopen and verify project state');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(
      () => window.__PREMIERE_DEBUG__.snapshot().saveStatus === 'saved',
      null,
      { timeout: 15000 },
    );
    const saved = await snapshot(page);
    const savedClips = saved.sequence.clips
      .map((c) => ({ id: c.id, start: c.startFrame, duration: c.durationFrames, media: c.mediaId, track: c.trackId }))
      .sort((a, b) => a.id.localeCompare(b.id));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /New Project/i }).first().waitFor();
    await screenshot(page, 'project-home-reopened');
    await page.getByText('E2E Acceptance Project', { exact: true }).first().click();
    await page.locator('[data-testid="media-panel"]').waitFor();
    await page.waitForFunction(() => {
      const s = window.__PREMIERE_DEBUG__?.snapshot();
      return s && s.projectId && s.sequence.clips.length > 0 && s.urls.length >= 5;
    });
    const reopened = await snapshot(page);
    assert(reopened.projectId === saved.projectId, 'reopened same project');
    const reopenedClips = reopened.sequence.clips
      .map((c) => ({ id: c.id, start: c.startFrame, duration: c.durationFrames, media: c.mediaId, track: c.trackId }))
      .sort((a, b) => a.id.localeCompare(b.id));
    assert(JSON.stringify(reopenedClips) === JSON.stringify(savedClips), 'clip arrangement restored exactly');
    assert(reopened.urls.length >= 5, 'media object URLs rehydrated after reload');
    await screenshot(page, 'editor-reopened');

    log('7.1 Missing media overlay and relink workflow');
    const greenAssetReopened = reopened.media.find((m) => m.fileName === 'image-green.png');
    assert(greenAssetReopened, 'green image media restored');
    await page.evaluate(
      (id) => window.__PREMIERE_DEBUG__.stores.project.getState().updateMedia(id, { missing: true }),
      greenAssetReopened.id,
    );
    await page.evaluate(() => window.__PREMIERE_DEBUG__.programPlayback.seek(90));
    await page.waitForTimeout(800);
    assert(
      await page.locator('[data-testid="program-offline"]').isVisible().catch(() => false),
      'program monitor shows a media-offline overlay',
    );
    assert(
      (await page.locator(`[data-media-id="${greenAssetReopened.id}"] [data-testid="media-offline"]`).count()) > 0,
      'media panel marks the asset offline',
    );
    await screenshot(page, 'missing-media');
    await page
      .locator(`[data-testid="media-asset"][data-media-id="${greenAssetReopened.id}"]`)
      .first()
      .click({ button: 'right' });
    await page.getByRole('button', { name: /Relink Media/ }).click();
    await page.locator('[data-testid="media-relink-input"]').setInputFiles([MEDIA('image-green.png')]);
    await page.waitForFunction(
      (id) => window.__PREMIERE_DEBUG__.snapshot().media.find((m) => m.id === id)?.missing === false,
      greenAssetReopened.id,
      { timeout: 30000 },
    );
    await page.waitForTimeout(1000);
    assert(
      (await page.locator('[data-testid="program-offline"]').count()) === 0,
      'offline overlay cleared after relinking media',
    );
    await page.keyboard.press('Control+s');
    await page.waitForTimeout(700);
    await screenshot(page, 'media-relinked');

    log('8. Unsupported media error handling');
    const badFile = path.join(OUT, 'unsupported.txt');
    fs.writeFileSync(badFile, 'not media');
    await page.locator('[data-testid="media-file-input"]').setInputFiles([badFile]);
    await page.waitForTimeout(1000);
    const toastText = await page.locator('body').innerText();
    assert(/unsupported|not supported/i.test(toastText), 'unsupported file shows an error notification');
    await screenshot(page, 'unsupported-file-error');

    log('9. Export the edited sequence');
    await page.getByRole('button', { name: /^Export$/ }).first().click();
    await page.locator('[data-testid="export-dialog"]').waitFor();
    await screenshot(page, 'export-dialog');

    // Interrupted export: start, then cancel and return to settings.
    await page.locator('[data-testid="export-start"]').click();
    await page.waitForTimeout(800);
    const cancelButton = page.locator('[data-testid="export-cancel"]');
    await cancelButton.waitFor({ timeout: 15000 });
    await cancelButton.click();
    await page.waitForTimeout(1500);
    const cancelStatus = await page
      .locator('[data-testid="export-status"]')
      .innerText()
      .catch(() => '');
    const cancelled = /cancel/i.test(cancelStatus) || (await page.getByText(/cancelled/i).count()) > 0;
    assert(cancelled, `export cancellation reported (${cancelStatus || 'no status'})`);
    await screenshot(page, 'export-cancelled');
    const backToSettings = page.getByRole('button', { name: /Back to settings/i });
    if (await backToSettings.count()) await backToSettings.click();
    await page.waitForTimeout(500);

    // Full export.
    await page.locator('[data-testid="export-start"]').click();
    await page.waitForTimeout(500);
    await screenshot(page, 'export-progress');
    await page.locator('[data-testid="export-download"]').waitFor({ timeout: 180000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await page.locator('[data-testid="export-download"]').click();
    const download = await downloadPromise;
    const exportPath = path.join(OUT, 'export-result' + (download.suggestedFilename().endsWith('.webm') ? '.webm' : '.mp4'));
    await download.saveAs(exportPath);
    const size = fs.statSync(exportPath).size;
    assert(size > 5000, `exported file has real content (${size} bytes)`);
    console.log(`exported: ${path.relative(ROOT, exportPath)} (${size} bytes)`);
    await screenshot(page, 'export-complete');

    log(`\nALL CHECKS PASSED. Console errors: ${consoleErrors.length}`);
    await browser.close();
    process.exit(0);
  } catch (error) {
    failures.push(error);
    try {
      await screenshot(page, 'failure');
    } catch {
      /* ignore */
    }
    console.error('\nE2E FAILURE:', error);
    if (consoleErrors.length) {
      console.error('Browser console errors:\n' + consoleErrors.slice(-20).join('\n'));
    }
    await browser.close();
    process.exit(1);
  }
}

main();
