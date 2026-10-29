// Pure validation shared by the Edge Function and dependency-free local tests.
export class ClientError extends Error {
  constructor(code, status = 422) { super(code); this.code = code; this.status = status; }
}

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(value, allowed, required = allowed) {
  if (!plainObject(value) || Object.keys(value).some(k => !allowed.includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) throw new ClientError('invalid_fields');
}

export function validateManifest(manifest) {
  if (!plainObject(manifest) || typeof manifest.title !== 'string' ||
      !Array.isArray(manifest.conditions) || manifest.conditions.length < 1 ||
      manifest.conditions.length > 32 || !Array.isArray(manifest.fields) ||
      manifest.fields.length < 1 || manifest.fields.length > 200) throw new Error('Invalid study manifest');
  const conditionIds = manifest.conditions.map(c => c.id);
  if (new Set(conditionIds).size !== conditionIds.length || manifest.conditions.some(c =>
      !plainObject(c) || typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) ||
      typeof c.vignette !== 'string')) throw new Error('Invalid conditions');
  for (const item of [manifest, ...manifest.conditions]) {
    if (Object.hasOwn(item, 'section_order') && (!Array.isArray(item.section_order) ||
        item.section_order.some(id => typeof id !== 'string'))) throw new Error('Invalid section order');
  }
  const ids = new Set();
  for (const f of manifest.fields) {
    if (!plainObject(f) || typeof f.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.id) || ids.has(f.id) ||
        typeof f.label !== 'string' || typeof f.required !== 'boolean') throw new Error('Invalid field');
    ids.add(f.id);
    if (f.conditions && (!Array.isArray(f.conditions) || f.conditions.length < 1 ||
        f.conditions.some(c => !conditionIds.includes(c)))) throw new Error('Invalid field conditions');
    if (f.type === 'integer') {
      if (!Number.isInteger(f.min) || !Number.isInteger(f.max) || f.min > f.max) throw new Error('Invalid integer range');
    } else if (f.type === 'choice') {
      if (!Array.isArray(f.options) || !f.options.length || new Set(f.options).size !== f.options.length ||
          f.options.some(v => typeof v !== 'string' || v.length > 200)) throw new Error('Invalid choice');
    } else if (f.type !== 'boolean') throw new Error('Unsupported field type');
  }
  return manifest;
}

export function fieldsForCondition(manifest, conditionId) {
  return manifest.fields.filter(f => !f.conditions || f.conditions.includes(conditionId));
}

export function metadataForCondition(manifest, condition) {
  return { section_order: condition.section_order || manifest.section_order || [] };
}

export function validateAnswers(manifest, conditionId, answers) {
  validateManifest(manifest);
  if (!manifest.conditions.some(c => c.id === conditionId) || !plainObject(answers)) throw new ClientError('invalid_answers');
  const fields = fieldsForCondition(manifest, conditionId);
  const allowed = new Set(fields.map(f => f.id));
  if (Object.keys(answers).some(k => !allowed.has(k))) throw new ClientError('unknown_answer');
  const result = {};
  for (const f of fields) {
    if (!Object.hasOwn(answers, f.id)) {
      if (f.required) throw new ClientError('missing_answer');
      continue;
    }
    const v = answers[f.id];
    if ((f.type === 'integer' && (!Number.isInteger(v) || v < f.min || v > f.max)) ||
        (f.type === 'choice' && !f.options.includes(v)) ||
        (f.type === 'boolean' && typeof v !== 'boolean')) throw new ClientError('invalid_answer_value');
    result[f.id] = v;
  }
  return result;
}

export function canonicalAnswers(answers) {
  return JSON.stringify(Object.fromEntries(Object.keys(answers).sort().map(k => [k, answers[k]])));
}

export function randomCondition(conditions, cryptoImpl = crypto) {
  const n = conditions.length;
  const ceiling = Math.floor(0x100000000 / n) * n;
  const value = new Uint32Array(1);
  do { cryptoImpl.getRandomValues(value); } while (value[0] >= ceiling);
  return conditions[value[0] % n];
}
