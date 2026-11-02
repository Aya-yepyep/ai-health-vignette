const TOKEN_RE = /^[0-9a-f]{64}$/;
const STUDY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const ARCHIVE_PATH_RE = /^(?:\.\/)?research\/archive\/[A-Za-z0-9][A-Za-z0-9._-]*\/manifest\.json$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class DraftRecoveryError extends Error {
  constructor(message, cause) { super(message, {cause}); this.name = 'DraftRecoveryError'; }
}

function validFields(fields) {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 200) return false;
  const ids = new Set();
  for (const f of fields) {
    if (!plain(f) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.id) || ids.has(f.id) ||
        typeof f.label !== 'string' || typeof f.required !== 'boolean') return false;
    ids.add(f.id);
    if (f.type === 'integer') {
      if (!Number.isInteger(f.min) || !Number.isInteger(f.max) || f.min > f.max) return false;
    } else if (f.type === 'choice') {
      if (!Array.isArray(f.options) || !f.options.length || new Set(f.options).size !== f.options.length ||
          f.options.some(option => typeof option !== 'string')) return false;
    } else if (f.type !== 'boolean') return false;
  }
  return true;
}

function validPartialAnswers(answers, fields) {
  if (!plain(answers)) return false;
  const byId = new Map(fields.map(field => [field.id, field]));
  return Object.entries(answers).every(([id, value]) => {
    const f = byId.get(id);
    if (!f) return false;
    if (f.type === 'integer') return Number.isInteger(value) && value >= f.min && value <= f.max;
    if (f.type === 'choice') return f.options.includes(value);
    return typeof value === 'boolean';
  });
}

// Validation is deliberately local and read-only. An old entry is never
// removed, rewritten or used as permission to create a new old-version token.
export function isResumableDraft(draft, studyId, version, now = Date.now(), isTest = false) {
  if (!plain(draft) || typeof draft.token !== 'string' || !TOKEN_RE.test(draft.token) || draft.receipt != null ||
      !plain(draft.session) || !Number.isInteger(draft.step) || draft.step < 0) return false;
  const session = draft.session;
  if (session.ok !== true || session.study_id !== studyId || session.version !== version ||
      session.session_token !== draft.token || session.is_test !== isTest ||
      !plain(session.condition) || typeof session.condition.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(session.condition.id) ||
      typeof session.condition.vignette !== 'string' || !validFields(session.fields)) return false;
  const expires = typeof session.expires_at === 'string' ? Date.parse(session.expires_at) : NaN;
  if (!Number.isFinite(expires) || expires <= now || !validPartialAnswers(draft.answers, session.fields)) return false;
  return draft.pendingAnswers === undefined || validPartialAnswers(draft.pendingAnswers, session.fields);
}

async function fetchManifest(fetchImpl, url) {
  const response = await fetchImpl(url, {cache: 'no-store', credentials: 'omit', redirect: 'error'});
  if (!response.ok) throw new Error('Manifest unavailable');
  const manifest = await response.json();
  if (!plain(manifest) || typeof manifest.study_id !== 'string' || !STUDY_RE.test(manifest.study_id) ||
      typeof manifest.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    throw new Error('Invalid manifest identity');
  }
  return manifest;
}

export async function resolveManifest(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const pageUrl = options.pageUrl || globalThis.location.href;
  const directoryUrl = new URL('.', pageUrl);
  const current = await fetchManifest(fetchImpl, new URL('./manifest.json', directoryUrl).href);
  if (!Array.isArray(current.previous_versions) || current.previous_versions.length === 0) {
    return {manifest: current, resumedVersion: null};
  }
  const now = options.now ?? Date.now();
  let storage;
  try { storage = options.storage ?? globalThis.sessionStorage; }
  catch (cause) { throw new DraftRecoveryError('暂时无法检查上一版填写进度。原有记录未被清除，请刷新页面重试。', cause); }
  for (const previous of current.previous_versions) {
    if (!plain(previous) || typeof previous.version !== 'string' || !VERSION_RE.test(previous.version) || previous.version === current.version) continue;
    let raw;
    try { raw = storage.getItem(`vignette-draft:${current.study_id}:${previous.version}`); }
    catch (cause) { throw new DraftRecoveryError('暂时无法检查上一版填写进度。原有记录未被清除，请刷新页面重试。', cause); }
    if (!raw) continue;
    let draft;
    try { draft = JSON.parse(raw); } catch { continue; }
    if (!isResumableDraft(draft, current.study_id, previous.version, now, current.is_test === true)) continue;
    try {
      if (typeof previous.manifest_path !== 'string' || !ARCHIVE_PATH_RE.test(previous.manifest_path)) {
        throw new Error('Unapproved archive path');
      }
      const archiveUrl = new URL(previous.manifest_path, directoryUrl);
      if (archiveUrl.origin !== directoryUrl.origin || !archiveUrl.pathname.startsWith(directoryUrl.pathname)) {
        throw new Error('Archive must stay inside this site');
      }
      const archived = await fetchManifest(fetchImpl, archiveUrl.href);
      if (archived.study_id !== current.study_id || archived.version !== previous.version ||
          archived.status !== 'open' || archived.is_test !== draft.session.is_test ||
          typeof archived.consent !== 'string' || !archived.consent.trim() ||
          (draft.session.consent !== undefined && draft.session.consent !== archived.consent)) {
        throw new Error('Archive does not match the existing session');
      }
      return {
        manifest: {...archived, description: '你正在继续上一版问卷。此前的情景和已填答案会继续保留，本次填写不会切换到新版。' + (archived.description ? `\n\n${archived.description}` : '')},
        resumedVersion: archived.version
      };
    } catch (cause) {
      // Never silently fall through to the new survey when there is a valid
      // unfinished old draft. A transient archive failure must not lose work.
      throw new DraftRecoveryError('上一版问卷暂时无法载入。原有填写进度已保留，请刷新页面重试；当前不会自动开始新版问卷。', cause);
    }
  }
  return {manifest: current, resumedVersion: null};
}
