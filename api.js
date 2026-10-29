export const ENDPOINT = 'https://lcectofnpiizkeiovcii.supabase.co/functions/v1/collect-vignette';
// Supabase publishable keys are public client identifiers, not server secrets.
export const PUBLISHABLE_KEY = 'sb_publishable_4SPPN0bulkUCWOtrsJgYbQ_KJt24jk_';

export class CollectionError extends Error {
  constructor(message, status = 0, code = '') { super(message); this.name = 'CollectionError'; this.status = status; this.code = code; }
}

export async function requestCollection(payload, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: {'Content-Type': 'application/json', apikey: PUBLISHABLE_KEY},
      body: JSON.stringify(payload), signal: controller.signal
    });
    let result;
    try { result = await response.json(); }
    catch { throw new CollectionError('服务器没有返回有效确认。请保留当前页面并重试。', response.status); }
    if (!response.ok || result?.ok !== true) {
      const code = typeof result?.error === 'string' ? result.error : (result?.error?.code || '');
      const messages = {
        study_unavailable: '问卷已暂停接收答卷，请稍后再试。',
        invalid_answers: '部分答案不符合问卷要求，请检查后重新提交。',
        session_expired: '本次填写已超时。请保存需要的信息后重新开始。',
        invalid_session: '无法确认本次填写记录，请保留当前页面并重试。',
        missing_answer: '仍有必答题未完成，请返回检查。',
        invalid_answer_value: '部分答案不符合问卷要求，请返回检查。',
        already_submitted_with_different_answers: '本次填写已有一份答卷被保存，不能更改。请保留页面并联系研究者。',
        rate_limited: '当前请求较多，请稍后重试。',
        version_mismatch: '问卷版本已更新，请刷新页面后重新开始。'
      };
      throw new CollectionError(messages[code] || '暂未收到提交成功的确认。请保留当前页面，稍后重试。', response.status, code);
    }
    return result;
  } catch (error) {
    if (error instanceof CollectionError) throw error;
    throw new CollectionError(error?.name === 'AbortError'
      ? '连接超时。你的答案仍保留在当前标签页中，请重试。'
      : '网络连接失败。你的答案仍保留在当前标签页中，请恢复网络后重试。');
  } finally { clearTimeout(timeout); }
}
