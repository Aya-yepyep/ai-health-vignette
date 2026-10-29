import { ClientError, exactKeys, validateManifest, validateAnswers,
  canonicalAnswers, fieldsForCondition, metadataForCondition, randomCondition } from './validation.mjs';

const ALLOWED_ORIGINS = new Set(['https://aya-yepyep.github.io', 'http://127.0.0.1:8765']);
const MAX_BODY_BYTES = 65536;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();

function envDictionary(name: string): Record<string, string> {
  const raw = Deno.env.get(name);
  if (!raw) return {};
  const result = JSON.parse(raw);
  return result && typeof result === 'object' ? result : {};
}

// Keys are supplied by Supabase to the function runtime. No secret is written
// in source or sent to the browser. Prefer modern independent-rotation keys.
const publishableKeys = Object.values(envDictionary('SUPABASE_PUBLISHABLE_KEYS'));
const secretKeys = envDictionary('SUPABASE_SECRET_KEYS');
const serviceKey = secretKeys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const apiUrl = Deno.env.get('SUPABASE_URL') || '';

function headers(origin: string | null) {
  const value: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, apikey',
    'Access-Control-Max-Age': '600',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) value['Access-Control-Allow-Origin'] = origin;
  return value;
}

function reply(origin: string | null, status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: headers(origin) });
}

async function sha256(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))),
    b => b.toString(16).padStart(2, '0')).join('');
}

class DatabaseError extends Error {
  status: number; code: string;
  constructor(status: number, code: string) { super('Database request failed'); this.status = status; this.code = code; }
}

async function db(path: string, method = 'GET', body?: unknown): Promise<any> {
  const auth: Record<string, string> = { apikey: serviceKey, 'Content-Type': 'application/json' };
  // Legacy service credentials are JWTs; modern secret keys use apikey only.
  if (!serviceKey.startsWith('sb_secret_')) auth.Authorization = `Bearer ${serviceKey}`;
  if (method === 'POST') auth.Prefer = 'return=representation';
  const response = await fetch(`${apiUrl}/rest/v1/${path}`, {
    method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new DatabaseError(response.status, String(data.code || 'unknown'));
  return data;
}

function query(table: string, filters: Record<string, string>, select = '*') {
  return table + '?' + new URLSearchParams({ ...filters, select }).toString();
}

async function readBody(req: Request) {
  if (!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) throw new ClientError('json_required', 415);
  if (Number(req.headers.get('content-length') || 0) > MAX_BODY_BYTES) throw new ClientError('body_too_large', 413);
  const reader = req.body?.getReader();
  if (!reader) throw new ClientError('invalid_json', 400);
  const chunks: Uint8Array[] = []; let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.length;
    if (length > MAX_BODY_BYTES) { await reader.cancel(); throw new ClientError('body_too_large', 413); }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new ClientError('invalid_json', 400); }
}

async function start(body: any) {
  exactKeys(body, ['action', 'study_id', 'version', 'consent', 'session_token']);
  if (body.consent !== true) throw new ClientError('consent_required');
  if (typeof body.study_id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(body.study_id) ||
      typeof body.version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(body.version)) throw new ClientError('invalid_study');
  if (typeof body.session_token !== 'string' || !TOKEN_RE.test(body.session_token)) throw new ClientError('invalid_session', 401);
  const rows = await db(query('vignette_studies', { study_id: `eq.${body.study_id}`, version: `eq.${body.version}`, active: 'eq.true' }));
  if (rows.length !== 1) throw new ClientError('study_unavailable', 409);
  const study = rows[0];
  const manifest = validateManifest(study.manifest);
  const tokenHash = await sha256(body.session_token);
  const lookup = query('vignette_sessions', { token_hash: `eq.${tokenHash}` });
  let sessions = await db(lookup);
  if (!sessions.length) {
    const condition = randomCondition(manifest.conditions);
    try {
      sessions = await db('vignette_sessions', 'POST', {
        token_hash: tokenHash, study_id: study.study_id, version: study.version,
        condition_id: condition.id, is_test: study.is_test, manifest_snapshot: manifest,
      });
    } catch (error) {
      if (!(error instanceof DatabaseError) || error.code !== '23505') throw error;
      // The same start request may race or retry after its response was lost.
      sessions = await db(lookup);
    }
  }
  const session = sessions[0];
  if (!session || session.study_id !== body.study_id || session.version !== body.version) throw new ClientError('session_study_mismatch', 409);
  if (Date.parse(session.expires_at) < Date.now()) throw new ClientError('session_expired', 409);
  const snapshot = validateManifest(session.manifest_snapshot);
  const condition = snapshot.conditions.find((c: any) => c.id === session.condition_id);
  if (!condition) throw new Error('Invalid session condition');
  return { ok: true, session_token: body.session_token, study_id: session.study_id, version: session.version,
    is_test: session.is_test, title: snapshot.title, condition,
    fields: fieldsForCondition(snapshot, condition.id), consent: snapshot.consent,
    metadata: metadataForCondition(snapshot, condition), expires_at: session.expires_at };
}

async function submit(body: any) {
  exactKeys(body, ['action', 'session_token', 'consent', 'answers']);
  if (body.consent !== true) throw new ClientError('consent_required');
  if (typeof body.session_token !== 'string' || !TOKEN_RE.test(body.session_token)) throw new ClientError('invalid_session', 401);
  const sessions = await db(query('vignette_sessions', { token_hash: `eq.${await sha256(body.session_token)}` }));
  if (sessions.length !== 1) throw new ClientError('invalid_session', 401);
  const session = sessions[0];
  const answers = validateAnswers(session.manifest_snapshot, session.condition_id, body.answers);
  const answerHash = await sha256(canonicalAnswers(answers));
  // Possession of this unguessable session token permits returning only the
  // receipt for an identical retry; it never permits returning answer data.
  const existing = await db(query('vignette_responses', { session_id: `eq.${session.id}` }, 'id,answer_hash,submitted_at'));
  if (existing.length) {
    if (existing[0].answer_hash !== answerHash) throw new ClientError('already_submitted_with_different_answers', 409);
    return { ok: true, receipt_id: existing[0].id, submitted_at: existing[0].submitted_at, duplicate: true };
  }
  if (Date.parse(session.expires_at) < Date.now()) throw new ClientError('session_expired', 409);
  const studies = await db(query('vignette_studies', { study_id: `eq.${session.study_id}`, version: `eq.${session.version}`, active: 'eq.true' }, 'study_id'));
  if (studies.length !== 1) throw new ClientError('study_unavailable', 409);
  try {
    const result = await db('vignette_responses', 'POST', {
      session_id: session.id, study_id: session.study_id, version: session.version,
      condition_id: session.condition_id, is_test: session.is_test, consent: true,
      answers, answer_hash: answerHash, started_at: session.started_at,
    });
    return { ok: true, receipt_id: result[0].id, submitted_at: result[0].submitted_at, duplicate: false };
  } catch (error) {
    if (!(error instanceof DatabaseError) || error.code !== '23505') throw error;
    // Concurrent retry: wait-free resolution using the database UNIQUE key.
    const result = await db(query('vignette_responses', { session_id: `eq.${session.id}` }, 'id,answer_hash,submitted_at'));
    if (!result.length || result[0].answer_hash !== answerHash) throw new ClientError('already_submitted_with_different_answers', 409);
    return { ok: true, receipt_id: result[0].id, submitted_at: result[0].submitted_at, duplicate: true };
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reply(null, 403, { ok: false, error: 'origin_not_allowed' });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(origin) });
  if (req.method !== 'POST') return reply(origin, 405, { ok: false, error: 'method_not_allowed' });
  if (!apiUrl || !serviceKey || !publishableKeys.length) return reply(origin, 503, { ok: false, error: 'configuration_unavailable' });
  const apiKey = req.headers.get('apikey');
  if (!apiKey || !publishableKeys.includes(apiKey)) return reply(origin, 401, { ok: false, error: 'invalid_api_key' });
  try {
    const body = await readBody(req);
    if (body?.action === 'start') return reply(origin, 201, await start(body));
    if (body?.action === 'submit') return reply(origin, 200, await submit(body));
    throw new ClientError('invalid_action', 400);
  } catch (error) {
    if (error instanceof ClientError) return reply(origin, error.status, { ok: false, error: error.code });
    // Do not log payloads, tokens, API keys, provider errors or answer data.
    return reply(origin, 503, { ok: false, error: 'temporarily_unavailable' });
  }
});
