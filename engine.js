import { requestCollection, CollectionError } from './api.js';

const TOKEN_RE = /^[0-9a-f]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, className = '') {
  const node = el('button', text, `button ${className}`.trim());
  node.type = 'button'; node.addEventListener('click', action); return node;
}

function freshToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('');
}

export function closedScreen(message) {
  const app = document.getElementById('app');
  app.replaceChildren(el('p', 'RESEARCH QUESTIONNAIRE', 'eyebrow'), el('h1', '问卷尚未开放'),
    el('p', message || '当前暂不接收答卷，请稍后再试。', 'muted'));
  app.setAttribute('aria-busy', 'false');
}

export function unavailableScreen() {
  const app = document.getElementById('app');
  app.replaceChildren(el('p', 'RESEARCH QUESTIONNAIRE', 'eyebrow'), el('h1', '问卷暂时无法载入'),
    el('p', '请检查网络后重新载入页面。当前没有提交答卷。', 'muted'),
    button('重新载入', () => location.reload()));
  app.setAttribute('aria-busy', 'false');
}

function validateOpenManifest(m) {
  return plain(m) && m.status === 'open' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.study_id) &&
    typeof m.version === 'string' && typeof m.title === 'string' &&
    typeof m.consent === 'string' && m.consent.trim().length > 0;
}

function validateSession(session, m) {
  if (!plain(session) || session.ok !== true || session.study_id !== m.study_id || session.version !== m.version ||
      session.is_test !== (m.is_test === true) || !TOKEN_RE.test(session.session_token) ||
      !plain(session.condition) || typeof session.condition.vignette !== 'string' ||
      !Array.isArray(session.fields) || !session.fields.length) throw new CollectionError('问卷版本暂时不一致，请保留当前页面并稍后重试。');
  const ids = new Set();
  for (const f of session.fields) {
    if (!plain(f) || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.id) || ids.has(f.id) ||
        typeof f.label !== 'string' || typeof f.required !== 'boolean') throw new CollectionError('问卷暂时无法载入，请稍后再试。');
    ids.add(f.id);
    if (f.type === 'integer') {
      if (!Number.isInteger(f.min) || !Number.isInteger(f.max) || f.max < f.min) {
        throw new CollectionError('问卷暂时无法载入，请稍后再试。');
      }
    } else if (f.type === 'choice') {
      if (!Array.isArray(f.options) || !f.options.length || f.options.some(v => typeof v !== 'string')) {
        throw new CollectionError('问卷暂时无法载入，请稍后再试。');
      }
    } else if (f.type !== 'boolean') throw new CollectionError('问卷暂时无法载入，请稍后再试。');
  }
  return session;
}

export function mountQuestionnaire(manifest, options = {}) {
  if (manifest?.status !== 'open') { closedScreen(manifest?.closed_message); return; }
  if (!validateOpenManifest(manifest)) { unavailableScreen(); return; }
  const api = options.request || requestCollection;
  const app = document.getElementById('app');
  const storageKey = `vignette-draft:${manifest.study_id}:${manifest.version}`;
  let storageAvailable = true, draft = {token: null, session: null, answers: {}, step: 0, receipt: null};
  let busy = false, statusNode;
  try {
    const restored = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (plain(restored) && TOKEN_RE.test(restored.token) && plain(restored.answers)) {
      if (restored.session) validateSession(restored.session, manifest);
      draft = {...draft, ...restored};
      if (!Number.isInteger(draft.step) || draft.step < 0) draft.step = 0;
      if (draft.receipt && (!UUID_RE.test(draft.receipt.receipt_id) || !Number.isFinite(Date.parse(draft.receipt.submitted_at)))) draft.receipt = null;
    }
  } catch { storageAvailable = false; }

  function persist() {
    try { sessionStorage.setItem(storageKey, JSON.stringify(draft)); }
    catch { storageAvailable = false; }
  }
  function clear() { try { sessionStorage.removeItem(storageKey); } catch {} draft = {token: null, session: null, answers: {}, step: 0, receipt: null}; }
  function error(message) { statusNode.textContent = message; statusNode.hidden = false; statusNode.focus(); }
  function setBusy(value) {
    busy = value; app.setAttribute('aria-busy', String(value));
    app.querySelectorAll('button,input').forEach(node => { node.disabled = value || node.dataset.locked === 'true'; });
  }
  function screen(title, {step, total} = {}) {
    app.replaceChildren(); app.setAttribute('aria-busy', 'false');
    app.append(el('p', manifest.is_test ? '连接测试 · 不计入正式研究' : 'RESEARCH QUESTIONNAIRE', 'eyebrow'));
    if (manifest.pilot) app.append(el('p', '预测试新稿 · 本问卷题目尚在验证中', 'pilot-banner'));
    if (typeof step === 'number') {
      const label = el('div', undefined, 'progress-label'); label.append(el('span', '填写进度'), el('span', `${step} / ${total}`));
      const track = el('div', undefined, 'progress-track'); const fill = el('div', undefined, 'progress-fill');
      track.setAttribute('role', 'progressbar'); track.setAttribute('aria-label', '填写进度');
      track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', String(total)); track.setAttribute('aria-valuenow', String(step));
      fill.style.width = `${step / total * 100}%`; track.append(fill); app.append(label, track);
    }
    app.append(el('h1', title));
    statusNode = el('div', '', 'notice error'); statusNode.setAttribute('role', 'alert'); statusNode.tabIndex = -1; statusNode.hidden = true; app.append(statusNode);
    app.focus({preventScroll: true}); window.scrollTo({top: 0, behavior: 'instant'});
  }
  function exit() {
    if (busy) return;
    if (draft.pendingAnswers && !draft.receipt) {
      screen('提交结果尚未确认');
      app.append(el('p', '上一次提交可能已保存，但本页还没有收到确认。建议返回后重试，以取得同一份答卷的提交凭证。', 'notice'));
      const actions = el('div', undefined, 'actions');
      actions.append(button('仅清除本页进度并退出', () => {
        clear(); screen('本页进度已清除');
        app.append(el('p', '本页记录已清除。上一次提交可能已保存到研究数据库，请勿重复填写。', 'muted'));
      }, 'secondary'), button('返回并重试', renderStep));
      app.append(actions); return;
    }
    clear(); screen('已退出填写');
    app.append(el('p', '当前标签页的填写进度已清除。未提交的答案不会作为答卷保存。', 'muted'),
      button('返回问卷说明', intro, 'secondary'));
  }
  function getSections() {
    const fields = draft.session.fields;
    const fieldMap = new Map(fields.map(f => [f.id, f]));
    const seen = new Set(), sections = [];
    if (Array.isArray(manifest.sections)) {
      for (const section of manifest.sections) {
        if (!plain(section) || typeof section.title !== 'string' || !Array.isArray(section.field_ids)) continue;
        const items = section.field_ids.filter(id => fieldMap.has(id) && !seen.has(id)).map(id => {seen.add(id); return fieldMap.get(id);});
        if (items.length) sections.push({id: section.id, title: section.title, description: section.description, items});
      }
    }
    const remaining = fields.filter(f => !seen.has(f.id));
    if (remaining.length) sections.push({title: '请谈谈你的看法', items: remaining});
    const order = draft.session.metadata?.section_order || draft.session.condition.section_order;
    if (Array.isArray(order)) {
      const rank = id => order.includes(id) ? order.indexOf(id) : order.length;
      sections.sort((a, b) => rank(a.id) - rank(b.id));
    }
    return sections;
  }
  function vignette() {
    const box = el('div', draft.session.condition.vignette, 'vignette');
    return box;
  }
  function vignetteDetails() {
    const details = el('details'); details.append(el('summary', '再次查看刚才的情景'), vignette()); return details;
  }
  function valueLabel(field, value) {
    if (value === undefined) return '未填写';
    if (field.type === 'boolean') return value ? '是' : '否';
    const labels = manifest.field_labels?.[field.id]?.options;
    return labels && Object.hasOwn(labels, String(value)) ? String(labels[String(value)]) : String(value);
  }
  function intro() {
    screen(manifest.title);
    if (manifest.description) app.append(el('p', manifest.description, 'muted'));
    app.append(el('h2', '参与前，请先阅读'), el('div', manifest.consent, 'notice'));
    app.append(el('p', '参与完全自愿。你可以在提交前随时退出填写。', 'helper'));
    app.append(el('p', storageAvailable
      ? '本页会在当前标签页临时保存填写进度。若使用共享设备，离开前请点击“退出并清除进度”。'
      : '浏览器暂不支持临时保存进度。请在当前页面内完成填写；刷新或关闭标签页可能丢失答案。', 'helper'));
    const form = el('form'); form.noValidate = false;
    const consentLabel = el('label', undefined, 'consent-label');
    const consent = el('input'); consent.type = 'checkbox'; consent.required = true; consent.id = 'participation-consent';
    consentLabel.append(consent, el('span', '我已阅读上述说明，并自愿参与本次研究。')); form.append(consentLabel);
    const actions = el('div', undefined, 'actions'); const start = el('button', draft.session ? '同意并继续填写' : '同意并开始', 'button'); start.type = 'submit';
    actions.append(button('暂不参与', exit, 'text'), start); form.append(actions); app.append(form);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy || !form.reportValidity()) return;
      if (draft.session) { renderStep(); return; }
      if (!draft.token) { draft.token = freshToken(); persist(); }
      setBusy(true);
      try {
        const session = await api({action: 'start', study_id: manifest.study_id, version: manifest.version, consent: true, session_token: draft.token});
        validateSession(session, manifest);
        if (session.session_token !== draft.token) throw new CollectionError('无法确认本次填写记录，请保留当前页面并重试。');
        if (session.consent !== undefined && session.consent !== manifest.consent) throw new CollectionError('参与说明已更新，请刷新页面后重新开始。');
        draft.session = session; draft.step = 0; persist(); setBusy(false); renderStep();
      } catch (cause) { setBusy(false); error(cause.message || '暂时无法开始，请稍后重试。'); }
    });
  }
  function fieldset(field, number) {
    const fieldset = el('fieldset', undefined, 'question');
    const legend = el('legend'); legend.append(el('span', `${number}.`, 'question-number'), document.createTextNode(field.label));
    legend.append(el('span', field.required ? '必答' : '选答', 'required')); fieldset.append(legend);
    if (field.type === 'integer' && field.max - field.min > 10) {
      const input = el('input', undefined, 'number-input'); input.type = 'number'; input.step = '1';
      input.min = String(field.min); input.max = String(field.max); input.required = field.required;
      input.name = field.id; input.setAttribute('aria-label', field.label);
      if (Object.hasOwn(draft.answers, field.id)) input.value = String(draft.answers[field.id]);
      input.addEventListener('input', () => {
        if (input.value === '') delete draft.answers[field.id];
        else if (input.validity.valid) draft.answers[field.id] = input.valueAsNumber;
        persist();
      });
      fieldset.append(input, el('p', `请输入 ${field.min} 至 ${field.max} 之间的整数。`, 'helper'));
      return fieldset;
    }
    let values;
    if (field.type === 'integer') values = Array.from({length: field.max - field.min + 1}, (_, i) => field.min + i);
    else if (field.type === 'boolean') values = [true, false];
    else values = field.options;
    const group = el('div', undefined, field.type === 'integer' ? 'likert-options' : 'choices');
    if (field.type === 'integer') group.style.setProperty('--options', String(values.length));
    values.forEach((value, index) => {
      const label = el('label', undefined, 'option'), input = el('input'); input.type = 'radio';
      input.name = field.id; input.id = `${field.id}-${index}`; input.value = String(value); input.required = field.required;
      input.checked = Object.hasOwn(draft.answers, field.id) && draft.answers[field.id] === value;
      input.addEventListener('change', () => { draft.answers[field.id] = value; persist(); });
      label.append(input, el('span', valueLabel(field, value))); group.append(label);
    });
    fieldset.append(group);
    const labels = manifest.field_labels?.[field.id];
    if (field.type === 'integer' && (labels?.min_label || labels?.max_label)) {
      const anchors = el('div', undefined, 'scale-anchors'); anchors.append(el('span', labels.min_label || ''), el('span', labels.max_label || '')); fieldset.append(anchors);
    }
    if (labels?.help) fieldset.append(el('p', labels.help, 'helper'));
    return fieldset;
  }
  function renderStep() {
    const sections = getSections(), total = sections.length + 2;
    if (draft.step > sections.length + 1) draft.step = sections.length + 1;
    if (draft.step === 0) {
      screen('请阅读以下情景', {step: 1, total});
      app.append(el('p', manifest.vignette_instruction || '请仔细阅读，并设想自己处于这一情景中。接下来的问题将围绕这一情景展开。', 'muted'), vignette());
      const actions = el('div', undefined, 'actions'); actions.append(button('退出并清除进度', exit, 'text'), button('已阅读，继续', () => {draft.step = 1; persist(); renderStep();})); app.append(actions); return;
    }
    if (draft.step === sections.length + 1) { review(sections); return; }
    const section = sections[draft.step - 1];
    screen(section.title, {step: draft.step + 1, total});
    if (section.description) app.append(el('p', section.description, 'muted'));
    app.append(vignetteDetails());
    const form = el('form'); let offset = sections.slice(0, draft.step - 1).reduce((n, s) => n + s.items.length, 0);
    section.items.forEach((field, i) => form.append(fieldset(field, offset + i + 1)));
    const actions = el('div', undefined, 'actions'), navigation = el('div', undefined, 'action-group');
    navigation.append(button('上一步', () => {draft.step--; persist(); renderStep();}, 'secondary'));
    const next = el('button', '下一步', 'button'); next.type = 'submit'; navigation.append(next);
    actions.append(button('退出并清除进度', exit, 'text'), navigation); form.append(actions); app.append(form);
    form.addEventListener('submit', event => {event.preventDefault(); if (form.reportValidity()) { draft.step++; persist(); renderStep(); }});
  }
  function review(sections) {
    screen('提交前，请最后确认', {step: sections.length + 2, total: sections.length + 2});
    app.append(el('p', '请确认已按自己的真实想法完成填写。提交后本次答卷将被保存。', 'muted'));
    const list = el('ul', undefined, 'review-list');
    sections.flatMap(s => s.items).forEach(field => { const item = el('li', undefined, 'review-item'); item.append(el('span', field.label), el('strong', valueLabel(field, draft.answers[field.id]))); list.append(item); });
    app.append(list);
    const actions = el('div', undefined, 'actions'), navigation = el('div', undefined, 'action-group');
    navigation.append(button('返回修改', () => {draft.step--; persist(); renderStep();}, 'secondary'));
    const submit = button('确认并提交', async () => {
      if (busy) return;
      // Freeze the payload before the request so an ambiguous network failure
      // can be retried with the same session and the exact same answers.
      if (!draft.pendingAnswers) draft.pendingAnswers = structuredClone(draft.answers);
      persist(); setBusy(true); submit.textContent = '正在提交…';
      try {
        const result = await api({action: 'submit', session_token: draft.token, consent: true, answers: draft.pendingAnswers});
        if (!UUID_RE.test(result.receipt_id) || !Number.isFinite(Date.parse(result.submitted_at))) {
          throw new CollectionError('暂未收到有效的保存凭证。请保留页面并重试。');
        }
        draft.receipt = {receipt_id: result.receipt_id, submitted_at: result.submitted_at};
        draft.answers = {}; delete draft.pendingAnswers; persist(); setBusy(false); complete();
      } catch (cause) {
        const definitelyRejected = cause instanceof CollectionError &&
          ['missing_answer', 'invalid_answer_value', 'invalid_answers', 'unknown_answer'].includes(cause.code);
        if (definitelyRejected) {delete draft.pendingAnswers; persist();}
        navigation.firstElementChild.dataset.locked = String(!definitelyRejected);
        setBusy(false); submit.textContent = definitelyRejected ? '重新提交' : '重试提交';
        error(cause.message || '暂未收到提交成功的确认，请重试。');
      }
    });
    // Once a submission has an unknown outcome, disallow edits until the same
    // payload is acknowledged. This avoids turning an idempotent retry into a
    // second, contradictory response.
    if (draft.pendingAnswers) {
      navigation.firstElementChild.disabled = true;
      navigation.firstElementChild.dataset.locked = 'true';
      app.append(el('p', '上次提交尚未收到确认。请重试同一份答卷，避免重复提交。', 'helper'));
    }
    navigation.append(submit); actions.append(button('退出并清除进度', exit, 'text'), navigation); app.append(actions);
  }
  function complete() {
    screen(manifest.is_test ? '测试答卷已保存' : '答卷已提交');
    app.prepend(el('div', '✓', 'status-icon'));
    app.append(el('p', manifest.is_test ? '这是一份连接测试数据，不计入正式研究。' : '感谢你的时间与认真作答。系统已收到并保存本次答卷。', 'muted'));
    app.append(el('p', '提交凭证', 'helper'), el('div', draft.receipt.receipt_id, 'receipt'));
    if (manifest.debrief) app.append(el('div', manifest.debrief, 'notice'));
    app.append(button('清除本页记录', () => {clear(); screen('本页记录已清除'); app.append(el('p', '已提交的答卷仍保存在研究数据库中。你可以关闭本标签页。', 'muted'));}, 'secondary'));
  }
  if (draft.receipt) complete(); else intro();
}
