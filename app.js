import { mountQuestionnaire, unavailableScreen } from './engine.js';
import { DraftRecoveryError, resolveManifest } from './bootstrap.js';

// This temporary store never rewrites or clears an older browser draft.
function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => entries.get(key) ?? null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key)
  };
}

async function start(options = {}) {
  try {
    const result = await resolveManifest(options);
    mountQuestionnaire(result.manifest, options);
  } catch (error) {
    if (!(error instanceof DraftRecoveryError)) {
      unavailableScreen();
      return;
    }
    const app = document.getElementById('app');
    const title = document.createElement('h1');
    title.textContent = error.code === 'storage_unavailable' ? '暂时无法读取填写进度' : '上一版填写进度暂时无法载入';
    const message = document.createElement('p'); message.textContent = error.message; message.className = 'notice'; message.setAttribute('role', 'alert');
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button'; retry.textContent = '刷新并重试'; retry.addEventListener('click', () => location.reload());
    app.replaceChildren(title, message, retry); app.setAttribute('aria-busy', 'false');
    if (error.code === 'storage_unavailable') {
      const warning = document.createElement('p'); warning.className = 'helper';
      warning.textContent = '也可以不保存草稿，直接开始本次填写。此时无法恢复上一版进度；刷新或关闭页面会丢失本次未提交答案。原有草稿会保留。';
      const proceed = document.createElement('button'); proceed.type = 'button'; proceed.className = 'button secondary'; proceed.textContent = '不保存草稿，继续本次填写';
      proceed.addEventListener('click', () => {
        proceed.disabled = true;
        start({storage: memoryStorage(), storageAvailable: false});
      });
      app.append(warning, proceed);
    }
  }
}

// The published build is a classic script: no module loader or top-level await.
start();
