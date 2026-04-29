/**
 * BetBridge — Stake.com → SportyBet proxy server
 *
 * Handles all outbound API calls server-side to avoid
 * browser CORS restrictions on both platforms.
 */

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const rateLimit = require('express-rate-limit');
const axios    = require('axios');
const Fuse     = (() => { const f = require('fuse.js'); return f.default || f; })();
const path     = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '10000', 10);

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false })); // CSP off so we can serve the HTML directly
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limiter — 60 requests per minute per IP
app.use(
  '/api',
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    max:      parseInt(process.env.RATE_LIMIT_MAX       || '60',    10),
    standardHeaders: true,
    legacyHeaders:   false,
    message: { error: 'Too many requests. Please slow down.' },
  })
);

// Serve frontend from /public
app.set('trust proxy', 1);

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Country → SportyBet API slug map
// ─────────────────────────────────────────────

const COUNTRY_SLUGS = {
  ng:  'ng',
  gh:  'gh',
  ke:  'ke',
  tz:  'tz',
  ug:  'ug',
  et:  'et',
  cm:  'cm',
  za:  'rsa',
  rsa: 'rsa',
};

function sportyBase(country) {
  const slug = COUNTRY_SLUGS[country.toLowerCase()] || country;
  return `https://www.sportybet.com/api/${slug}`;
}

// Shared axios instance for outbound calls
const http = axios.create({
  timeout: TIMEOUT,
  headers: {
    'User-Agent': USER_AGENT,
    Accept:       'application/json, */*',
  },
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function sendError(res, status, message, details = null) {
  const body = { error: message };
  if (details && process.env.NODE_ENV !== 'production') body.details = details;
  return res.status(status).json(body);
}

/**
 * Parse any Stake share URL and return { id, type }
 *
 * Supported formats:
 *   /sports/bet-slip/<uuid>                          → type: 'slip'
 *   ?betslipId=<uuid>                                → type: 'slip'
 *   ?iid=sport%3A<numericId>&modal=bet               → type: 'bet'  (shared from My Bets)
 *   Raw numeric / alphanumeric ID string             → type: 'bet'
 */
function parseStakeBetId(raw) {
  // Try parsing as URL first
  try {
    const u = new URL(raw);

    // Format: /sports/bet-slip/<id>
    const slipPath = u.pathname.match(/bet-slip\/([a-zA-Z0-9_-]+)/i);
    if (slipPath) return { id: slipPath[1], type: 'slip' };

    // Format: ?betslipId=<id>
    const slipParam = u.searchParams.get('betslipId') || u.searchParams.get('betslip');
    if (slipParam) return { id: slipParam, type: 'slip' };

    // Format: ?iid=sport%3A571991279&modal=bet  (decoded: iid=sport:571991279)
    const iid = u.searchParams.get('iid');
    if (iid) {
      const numMatch = iid.match(/sport[:%]3A(\d+)|sport:(\d+)|^(\d+)$/i);
      if (numMatch) return { id: numMatch[1] || numMatch[2] || numMatch[3], type: 'bet' };
    }
  } catch {
    // Not a URL — treat raw string as a bet ID
  }

  // Raw numeric ID (e.g. "571991279")
  if (/^\d+$/.test(raw.trim())) return { id: raw.trim(), type: 'bet' };

  return null;
}

// ─────────────────────────────────────────────
// Stake.com — GraphQL queries
// ─────────────────────────────────────────────

const STAKE_GQL_URL = 'https://stake.com/_api/graphql';

// Query for a bet slip shared via /bet-slip/<uuid>
const BET_SLIP_QUERY = `
  query BetSlip($id: String!) {
    betSlip(id: $id) {
      id active currency amount payout isCashout
      bets {
        id active odds amount payout status
        outcome {
          id name active
          market {
            id name active
            game {
              id name slug active startTime status
              homeTeam { id name }
              awayTeam { id name }
              league   { id name country { id name code } }
              sport    { id name slug }
            }
          }
        }
      }
    }
  }
`;

// Query for a single sport bet by numeric ID (shared via ?iid=sport:xxx)
const SPORT_BET_QUERY = `
  query SportBet($id: String!) {
    sportBet(id: $id) {
      id active currency amount payout isCashout
      odds
      payoutMultiplier
      outcomes {
        id name active odds
        market {
          id name active
          game {
            id name slug active startTime status
            homeTeam { id name }
            awayTeam { id name }
            league   { id name country { id name code } }
            sport    { id name slug }
          }
        }
      }
    }
  }
`;

const GQL_HEADERS = {
  'Content-Type':    'application/json',
  'Origin':          'https://stake.com',
  'Referer':         'https://stake.com/',
  'app-name':        'web',
  'x-language':      'en',
  'x-stake-country': 'cw',
  'Accept':          'application/json, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
};

/** Normalise a sportBet response into the same shape as betSlip */
function normaliseSportBet(bet) {
  const bets = (bet.outcomes || []).map(oc => ({
    id:     oc.id,
    active: oc.active,
    odds:   oc.odds,
    status: bet.active ? 'active' : 'settled',
    outcome: {
      id:     oc.id,
      name:   oc.name,
      active: oc.active,
      market: oc.market,
    },
  }));

  return {
    id:       bet.id,
    active:   bet.active,
    currency: bet.currency,
    amount:   bet.amount,
    payout:   bet.payout,
    bets,
  };
}

async function fetchStakeSlip({ id, type }) {
  if (type === 'bet') {
    // Stake's sportBet query wants the full "sport:ID" prefixed string
    const fullId = String(id).startsWith('sport:') ? String(id) : `sport:${id}`;

    const resp = await http.post(
      STAKE_GQL_URL,
      { operationName: 'SportBet', variables: { id: fullId }, query: SPORT_BET_QUERY },
      { headers: GQL_HEADERS }
    );

    if (resp.data?.data?.sportBet) return normaliseSportBet(resp.data.data.sportBet);

    const gqlErr = resp.data?.errors?.[0]?.message;
    if (gqlErr) throw new Error(gqlErr);
    throw new Error('Bet not found. It may be private or require a Stake account to view.');
  }

  // type === 'slip'
  const resp = await http.post(
    STAKE_GQL_URL,
    { operationName: 'BetSlip', variables: { id: String(id) }, query: BET_SLIP_QUERY },
    { headers: GQL_HEADERS }
  );
  if (resp.data?.errors?.length) throw new Error(resp.data.errors[0]?.message || 'GraphQL error');
  const slip = resp.data?.data?.betSlip;
  if (!slip) throw new Error('Bet slip not found or is private');
  return slip;
}

// ─────────────────────────────────────────────
// SportyBet — search + booking
// ─────────────────────────────────────────────

/**
 * Search SportyBet for events matching a keyword.
 * Returns raw event list from their facts-center API.
 */
async function searchSportyEvents(country, keyword, sportId = 'sr:sport:1') {
  const url = `${sportyBase(country)}/factsCenter/query`;
  const resp = await http.get(url, {
    params: {
      keyword,
      sportId,
      _t: Date.now(),
    },
    headers: {
      Referer: `https://www.sportybet.com/${COUNTRY_SLUGS[country] || country}/`,
    },
  });

  // SportyBet wraps results in data.sportEvents or data.events
  return (
    resp.data?.data?.sportEvents ||
    resp.data?.data?.events       ||
    resp.data?.sportEvents         ||
    []
  );
}

/**
 * Find the best-matching SportyBet event for a given home + away team.
 * Uses Fuse.js fuzzy matching on the combined team name string.
 */
function fuzzyMatch(events, homeTeam, awayTeam) {
  if (!events.length) return null;

  // Normalise each event into a searchable string
  const items = events.map(ev => ({
    raw: ev,
    label: [
      ev.homeTeamName || ev.homeName || '',
      ev.awayTeamName || ev.awayName || '',
      ev.eventName    || ev.fixtureName || '',
    ].join(' ').toLowerCase(),
  }));

  const query = `${homeTeam} ${awayTeam}`.toLowerCase();

  const fuse = new Fuse(items, {
    keys:              ['label'],
    threshold:         0.4,
    includeScore:      true,
    ignoreLocation:    true,
  });

  const results = fuse.search(query);
  return results[0]?.item?.raw || null;
}

/**
 * Pick the correct outcome ID from a matched event.
 * Looks for 1X2 market first, then any market containing the pick name.
 */
function resolveOutcome(sportyEvent, pickName) {
  const markets =
    sportyEvent.markets       ||
    sportyEvent.sportMarkets  ||
    [];

  for (const mkt of markets) {
    const outcomes = mkt.outcomes || mkt.selections || [];
    for (const oc of outcomes) {
      const name = (oc.outcomeName || oc.name || '').toLowerCase();
      if (name === pickName.toLowerCase()) return oc;
      // Normalise common aliases: "1" → home, "2" → away, "x" → draw
      if (pickName === '1' && /^home|1$/.test(name))  return oc;
      if (pickName === '2' && /^away|2$/.test(name))  return oc;
      if (/^x$/.test(pickName) && /draw|x/.test(name)) return oc;
    }
  }
  return null;
}

/**
 * POST to SportyBet to create a shareable booking code.
 * selectionsStr format: "eventId_outcomeId_odds|eventId_outcomeId_odds|..."
 */
async function createSportyBookingCode(country, selectionsStr) {
  const url = `${sportyBase(country)}/factsCenter/bookingCode`;
  const resp = await http.post(
    url,
    { selectionsStr },
    {
      headers: {
        'Content-Type': 'application/json',
        Referer: `https://www.sportybet.com/${COUNTRY_SLUGS[country] || country}/`,
      },
    }
  );

  const code =
    resp.data?.data?.bookingCode ||
    resp.data?.bookingCode       ||
    null;

  if (!code) throw new Error('SportyBet returned no booking code');
  return code;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

/**
 * GET /health
 * Simple liveness check.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Debug: raw Stake API response ──────────
// GET /api/debug-stake?id=571991279&type=bet
app.get('/api/debug-stake', async (req, res) => {
  const { id, type = 'bet' } = req.query;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  try {
    const fullId = type === 'bet'
      ? (String(id).startsWith('sport:') ? String(id) : `sport:${id}`)
      : String(id);
    const query  = type === 'bet' ? SPORT_BET_QUERY : BET_SLIP_QUERY;
    const opName = type === 'bet' ? 'SportBet'      : 'BetSlip';
    const resp   = await http.post(
      STAKE_GQL_URL,
      { operationName: opName, variables: { id: fullId }, query },
      { headers: GQL_HEADERS }
    );
    res.json({ sentId: fullId, status: resp.status, body: resp.data });
  } catch (err) {
    res.status(502).json({ error: err.message, response: err.response?.data, status: err.response?.status });
  }
});



// ── /api/stake ─────────────────────────────

/**
 * GET /api/stake/slip/:id
 * Fetch a single Stake.com bet slip by ID.
 *
 * Response: raw bet slip object from Stake GraphQL
 */
app.get('/api/stake/slip/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return sendError(res, 400, 'Invalid bet slip ID');
  // Numeric ID = shared bet; alphanumeric = bet slip UUID
  const type = /^\d+$/.test(id) ? 'bet' : 'slip';
  try {
    const slip = await fetchStakeSlip({ id, type });
    res.json({ ok: true, slip });
  } catch (err) {
    sendError(res, err.response?.status || 502, err.message, err.response?.data);
  }
});

// ── /api/sportybet ─────────────────────────

/**
 * GET /api/sportybet/search?country=ng&q=Arsenal+Chelsea&sportId=sr:sport:1
 * Search SportyBet events catalog.
 *
 * Response: { ok, events: [...] }
 */
app.get('/api/sportybet/search', async (req, res) => {
  const { country = 'ng', q, sportId } = req.query;
  if (!q) return sendError(res, 400, 'Missing query param: q');

  try {
    const events = await searchSportyEvents(country, q, sportId);
    res.json({ ok: true, events });
  } catch (err) {
    sendError(res, 502, 'SportyBet search failed', err.message);
  }
});

/**
 * POST /api/sportybet/bookingcode
 * Body: { country, selectionsStr }
 *
 * selectionsStr: "eventId_outcomeId_odds|..."
 * Response: { ok, bookingCode }
 */
app.post('/api/sportybet/bookingcode', async (req, res) => {
  const { country = 'ng', selectionsStr } = req.body;
  if (!selectionsStr) return sendError(res, 400, 'Missing body field: selectionsStr');

  try {
    const bookingCode = await createSportyBookingCode(country, selectionsStr);
    res.json({ ok: true, bookingCode });
  } catch (err) {
    sendError(res, 502, 'Failed to generate booking code', err.message);
  }
});

// ── /api/convert ───────────────────────────

/**
 * POST /api/convert
 * The full pipeline in a single request.
 *
 * Body: {
 *   stakeUrl: "https://stake.com/sports/bet-slip/abc123",
 *   country:  "ng"   // SportyBet target country
 * }
 *
 * Response: {
 *   ok: true,
 *   bookingCode: "XYZ789",
 *   totalOdds:   5.42,
 *   selections: [
 *     {
 *       teams:      "Arsenal vs Chelsea",
 *       market:     "Match Winner",
 *       pick:       "Arsenal",
 *       odds:       1.85,
 *       league:     "Premier League",
 *       startTime:  "2024-05-10T15:00:00Z",
 *       matched:    true,          // found on SportyBet
 *       sportyEventId:  "...",
 *       sportyOutcomeId: "..."
 *     },
 *     ...
 *   ]
 * }
 */
app.post('/api/convert', async (req, res) => {
  const { stakeUrl, country = 'ng' } = req.body;

  if (!stakeUrl) return sendError(res, 400, 'Missing field: stakeUrl');

  const parsed = parseStakeBetId(stakeUrl);
  if (!parsed) {
    return sendError(res, 400,
      'Could not extract a bet ID. Accepted formats:\n' +
      '• https://stake.com/sports/bet-slip/<id>\n' +
      '• https://stake.com/sports/home?iid=sport%3A<id>&modal=bet\n' +
      '• Raw numeric bet ID (e.g. 571991279)'
    );
  }

  // ── 2. Fetch Stake slip ────────────────────
  let slip;
  try {
    slip = await fetchStakeSlip(parsed);
  } catch (err) {
    return sendError(
      res, 502,
      `Failed to fetch Stake bet: ${err.message}`,
      err.response?.data
    );
  }

  const stakeBets = slip.bets || [];
  if (!stakeBets.length) {
    return sendError(res, 404, 'Bet slip contains no selections');
  }

  // ── 3. Match each selection on SportyBet ──
  const selections = [];
  const sportySelections = []; // only matched ones, for booking code

  for (const bet of stakeBets) {
    const game      = bet.outcome?.market?.game;
    const market    = bet.outcome?.market?.name  || 'Match Winner';
    const pick      = bet.outcome?.name          || '';
    const odds      = parseFloat(bet.odds        || 1);
    const homeTeam  = game?.homeTeam?.name       || '';
    const awayTeam  = game?.awayTeam?.name       || '';
    const teams     = homeTeam && awayTeam
      ? `${homeTeam} vs ${awayTeam}`
      : (game?.name || 'Unknown Match');
    const league    = game?.league?.name         || '';
    const startTime = game?.startTime            || null;
    const sport     = game?.sport?.slug          || 'soccer';

    // Map Stake sport slug → SportyBet sportId
    const sportIdMap = {
      soccer:     'sr:sport:1',
      football:   'sr:sport:1',
      basketball: 'sr:sport:2',
      tennis:     'sr:sport:5',
      cricket:    'sr:sport:21',
      rugby:      'sr:sport:12',
    };
    const sportId = sportIdMap[sport] || 'sr:sport:1';

    const sel = { teams, homeTeam, awayTeam, market, pick, odds, league, startTime, matched: false };

    // Only attempt match if we have team names
    if (homeTeam && awayTeam) {
      try {
        const keyword = `${homeTeam} ${awayTeam}`;
        const events  = await searchSportyEvents(country, keyword, sportId);
        const match   = fuzzyMatch(events, homeTeam, awayTeam);

        if (match) {
          const outcome = resolveOutcome(match, pick);
          sel.matched         = !!outcome;
          sel.sportyEventId   = match.eventId   || match.id   || null;
          sel.sportyOutcomeId = outcome?.outcomeId || outcome?.id || null;
          sel.sportyOdds      = parseFloat(outcome?.odds || odds);

          if (outcome && sel.sportyEventId && sel.sportyOutcomeId) {
            sportySelections.push(
              `${sel.sportyEventId}_${sel.sportyOutcomeId}_${sel.sportyOdds.toFixed(2)}`
            );
          }
        }
      } catch (searchErr) {
        // Non-fatal — mark as unmatched and continue
        sel.matchError = searchErr.message;
      }
    }

    selections.push(sel);
  }

  // ── 4. Generate booking code ───────────────
  let bookingCode = null;

  if (sportySelections.length > 0) {
    const selectionsStr = sportySelections.join('|');
    try {
      bookingCode = await createSportyBookingCode(country, selectionsStr);
    } catch (codeErr) {
      // Non-fatal — return selections even if code generation fails
      console.error('[BookingCode] Failed:', codeErr.message);
    }
  }

  // ── 5. Calculate total odds ────────────────
  const totalOdds = selections.reduce((acc, s) => acc * s.odds, 1);

  // ── 6. Respond ─────────────────────────────
  const matchedCount   = selections.filter(s => s.matched).length;
  const unmatchedCount = selections.length - matchedCount;

  res.json({
    ok:            true,
    bookingCode,
    totalOdds:     parseFloat(totalOdds.toFixed(4)),
    matchedCount,
    unmatchedCount,
    selections,
    meta: {
      stakeSlipId: parsed.id, stakeIdType: parsed.type,
      stakeCurrency: slip.currency,
      country,
    },
  });
});

// ─────────────────────────────────────────────
// 404 fallback → serve frontend SPA
// ─────────────────────────────────────────────
app.use((_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─────────────────────────────────────────────
// Error handler
// ─────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  🌉  BetBridge running on http://localhost:${PORT}`);
  console.log(`  📡  Proxying: Stake.com GraphQL  →  SportyBet API`);
  console.log(`  ENV: ${process.env.NODE_ENV || 'development'}\n`);
});
