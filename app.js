import { mountQuestionnaire, unavailableScreen } from './engine.js?v=pilot-2026-11-02-v2';
import { DraftRecoveryError, resolveManifest } from './bootstrap.js';

try {
  const result = await resolveManifest();
  mountQuestionnaire(result.manifest);
} catch (error) {
  if (!(error instanceof DraftRecoveryError)) {
    unavailableScreen();
  } else {
    const app = document.getElementById('app');
    const title = document.createElement('h1'); title.textContent = '上一版填写进度暂时无法载入';
    const message = document.createElement('p'); message.textContent = error.message; message.className = 'notice'; message.setAttribute('role', 'alert');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = '刷新并重试'; retry.addEventListener('click', () => location.reload());
    app.replaceChildren(title, message, retry); app.setAttribute('aria-busy', 'false');
  }
}
