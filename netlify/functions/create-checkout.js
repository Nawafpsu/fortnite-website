/**
 * Netlify Serverless Function — HyperPay Create Checkout
 *
 * Endpoint : POST /.netlify/functions/create-checkout
 *
 * Request body (JSON):
 *   {
 *     "amount":       "99.00",          // required — string or number, positive
 *     "currency":     "SAR",            // optional — defaults to SAR
 *     "paymentBrand": "MADA"            // optional — MADA | VISA | MASTER | APPLEPAY
 *   }
 *
 * Success response (200):
 *   {
 *     "checkoutId": "abc123...",
 *     "amount":     "99.00",
 *     "currency":   "SAR"
 *   }
 *
 * Error response (4xx / 5xx):
 *   {
 *     "error":       "Human-readable message",
 *     "code":        "HyperPay result code",   // only on 422
 *     "description": "HyperPay description"    // only on 422
 *   }
 *
 * Required env vars:
 *   HYPERPAY_TOKEN      — Bearer token from HyperPay dashboard
 *   HYPERPAY_ENTITY_ID  — Entity ID from HyperPay dashboard
 *
 * Optional env vars:
 *   HYPERPAY_MODE       — "LIVE" for production, anything else = test (default)
 *   ALLOWED_ORIGIN      — CORS origin, e.g. "https://nexusstore.sa" (default: *)
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const HYPERPAY_HOSTS = {
  LIVE: 'https://oppwa.com',
  TEST: 'https://eu-test.oppwa.com',
};

const ALLOWED_BRANDS = new Set(['MADA', 'VISA', 'MASTER', 'MASTERCARD', 'APPLEPAY', 'STC_PAY']);

const ALLOWED_CURRENCIES = new Set(['SAR', 'USD', 'EUR', 'AED', 'KWD', 'BHD', 'QAR', 'OMR']);

// HyperPay success codes for checkout creation
const CHECKOUT_SUCCESS_PATTERN = /^000\.200\./;

// Minimum and maximum amounts (SAR)
const AMOUNT_MIN = 1;
const AMOUNT_MAX = 100_000;

// ─── Handler ─────────────────────────────────────────────────────────────────

exports.handler = async function (event) {

  // ── CORS preflight ──────────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return respond(204, null);
  }

  // ── Method guard ────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed. Use POST.' });
  }

  // ── Parse body ──────────────────────────────────────────────────────────────
  let amount, currency, paymentBrand;

  try {
    const body = JSON.parse(event.body || '{}');
    amount       = body.amount;
    currency     = (body.currency || 'SAR').toUpperCase().trim();
    paymentBrand = body.paymentBrand
      ? body.paymentBrand.toUpperCase().trim()
      : null;
  } catch {
    return respond(400, { error: 'Request body must be valid JSON.' });
  }

  // ── Validate amount ─────────────────────────────────────────────────────────
  const parsedAmount = parseFloat(amount);

  if (amount === undefined || amount === null || amount === '') {
    return respond(400, { error: '"amount" is required.' });
  }
  if (isNaN(parsedAmount) || !isFinite(parsedAmount)) {
    return respond(400, { error: '"amount" must be a valid number.' });
  }
  if (parsedAmount < AMOUNT_MIN) {
    return respond(400, { error: `"amount" must be at least ${AMOUNT_MIN}.` });
  }
  if (parsedAmount > AMOUNT_MAX) {
    return respond(400, { error: `"amount" must not exceed ${AMOUNT_MAX}.` });
  }

  // ── Validate currency ───────────────────────────────────────────────────────
  if (!ALLOWED_CURRENCIES.has(currency)) {
    return respond(400, {
      error: `"currency" must be one of: ${[...ALLOWED_CURRENCIES].join(', ')}.`,
    });
  }

  // ── Validate payment brand (if provided) ────────────────────────────────────
  if (paymentBrand && !ALLOWED_BRANDS.has(paymentBrand)) {
    return respond(400, {
      error: `"paymentBrand" must be one of: ${[...ALLOWED_BRANDS].join(', ')}.`,
    });
  }

  // ── Env vars ────────────────────────────────────────────────────────────────
  const token    = process.env.HYPERPAY_TOKEN;
  const entityId = process.env.HYPERPAY_ENTITY_ID;
  const mode     = process.env.HYPERPAY_MODE === 'LIVE' ? 'LIVE' : 'TEST';

  if (!token || !entityId) {
    console.error('[create-checkout] Missing HYPERPAY_TOKEN or HYPERPAY_ENTITY_ID');
    return respond(500, { error: 'Payment gateway is not configured.' });
  }

  // ── Build HyperPay form payload ─────────────────────────────────────────────
  const formData = new URLSearchParams({
    entityId,
    amount:      parsedAmount.toFixed(2),
    currency,
    paymentType: 'DB',                      // DB = debit / direct charge
  });

  if (paymentBrand) {
    formData.append('paymentBrand', paymentBrand);
  }

  const apiUrl = `${HYPERPAY_HOSTS[mode]}/v1/checkouts`;

  // ── Call HyperPay ───────────────────────────────────────────────────────────
  let raw;

  try {
    const res = await fetch(apiUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    raw = await res.json();

  } catch (err) {
    console.error('[create-checkout] Network error reaching HyperPay:', err.message);
    return respond(502, { error: 'Could not reach payment gateway. Please try again.' });
  }

  // ── Evaluate HyperPay result ────────────────────────────────────────────────
  const resultCode = raw?.result?.code ?? '';
  const resultDesc = raw?.result?.description ?? '';
  const checkoutId = raw?.id;

  // Success: HyperPay returns code 000.200.100 or 000.200.200
  if (checkoutId && CHECKOUT_SUCCESS_PATTERN.test(resultCode)) {
    console.log(`[create-checkout] OK — checkoutId=${checkoutId} amount=${parsedAmount.toFixed(2)} ${currency} mode=${mode}`);
    return respond(200, {
      checkoutId,
      amount:   parsedAmount.toFixed(2),
      currency,
    });
  }

  // HyperPay returned a rejection / error code
  console.warn(`[create-checkout] HyperPay rejected — code=${resultCode} desc="${resultDesc}"`);
  return respond(422, {
    error:       'Payment gateway declined the request.',
    code:        resultCode,
    description: resultDesc,
  });
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Netlify response with standard JSON + CORS headers.
 * @param {number} statusCode
 * @param {object|null} body
 */
function respond(statusCode, body) {
  const origin = process.env.ALLOWED_ORIGIN || '*';

  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers':'Content-Type',
      'Access-Control-Allow-Methods':'POST, OPTIONS',
      'Cache-Control':               'no-store',
    },
    body: body !== null ? JSON.stringify(body) : '',
  };
}
