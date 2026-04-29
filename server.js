/**
 * BetBridge — Stake.com → SportyBet proxy server
 *
 * Flow:
 *  1. User pastes a Stake.com bet slip share link (requires they placed a bet)
 *  2. Server fetches the slip from Stake's GraphQL API
 *  3. Server searches SportyBet for each matching event
 *  4. Server generates a SportyBet booking code
 *  5. User loads the code on SportyBet and places their own bet
 */

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const axios     = require('axios');
const Fuse      = require('fuse.js');
const path      = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '10000', 10);

const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use('/api', rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
  max:      parseInt(process.env.RATE_LIMIT_MAX       || '60',    10),
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please slow down.' },
}));

app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const COUNTRY_SLUGS = {
  ng: 'ng', gh: 'gh', ke: 'ke', tz: 'tz',
  ug: 'ug', et: 'et', cm: 'cm', za: 'rsa', rsa: 'rsa',
};

const http = axios.create({
  timeout: TIMEOUT,
  headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, */*' },
});

function sportyBase(country) {
  const slug = COUNTRY_SLUGS[country?.toLowerCase()] || 'ng';
  return `https://www.sportybet.com/api/${slug}`;
}

function sendError(res, status, message, details = null) {
  const body = { error: message };
  if (details && process.env.NODE_ENV !== 'production') body.details = details;
  return res.status(status).json(body);
}

// ─────────────────────────────────────────────
// Stake.com — GraphQL
// ─────────────────────────────────────────────
const STAKE_GQL = 'https://stake.com/_api/graphql';

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

function parseStakeBetId(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/bet-slip\/([a-zA-Z0-9_-]+)/i);
    if (m) return m[1];
    return u.searchParams.get('betslipId') || u.searchParams.get('betslip') || null;
  } catch { return null; }
}

async function fetchStakeSlip(betId) {
  const resp = await http.post(
    STAKE_GQL,
    { operationName: 'BetSlip', variables: { id: betId }, query: BET_SLIP_QUERY },
    { headers: { 'Content-Type': 'application/json', Origin: 'https://stake.com', Referer: 'https://stake.com/' } }
  );
  if (resp.data?.errors?.length) throw new Error(resp.data.errors[0]?.message || 'GraphQL error');
  const slip = resp.data?.data?.betSlip;
  if (!slip) throw new Error('Bet slip not found or is private');
  return slip;
}

// ─────────────────────────────────────────────
// SportyBet — search + match + booking code
// ─────────────────────────────────────────────
async function searchSportyEvents(country, keyword, sportId = 'sr:sport:1') {
  const resp = await http.get(`${sportyBase(country)}/factsCenter/query`, {
    params: { keyword, sportId, _t: Date.now() },
    headers: { Referer: `https://www.sportybet.com/${COUNTRY_SLUGS[country] || country}/` },
  });
  return (
    resp.data?.data?.sportEvents ||
    resp.data?.data?.events      ||
    resp.data?.sportEvents       ||
    []
  );
}

function fuzzyMatch(events, homeTeam, awayTeam) {
  if (!events.length) return null;
  const items = events.map(ev => ({
    raw:   ev,
    label: [
      ev.homeTeamName || ev.homeName  || '',
      ev.awayTeamName || ev.awayName  || '',
      ev.eventName    || ev.fixtureName || '',
    ].join(' ').toLowerCase(),
  }));
  const fuse = new Fuse(items, { keys: ['label'], threshold: 0.4, includeScore: true, ignoreLocation: true });
  const hits = fuse.search(`${homeTeam} ${awayTeam}`.toLowerCase());
  return hits[0]?.item?.raw || null;
}

function resolveOutcome(sportyEvent, pickName) {
  const markets = sportyEvent.markets || sportyEvent.sportMarkets || [];
  for (const mkt of markets) {
    for (const oc of (mkt.outcomes || mkt.selections || [])) {
      const name = (oc.outcomeName || oc.name || '').toLowerCase();
      const pick = pickName.toLowerCase();
      if (name === pick) return oc;
      if (pick === '1'  && /^(home|1)$/.test(name))  return oc;
      if (pick === '2'  && /^(away|2)$/.test(name))  return oc;
      if (pick === 'x'  && /draw|^x$/.test(name))    return oc;
    }
  }
  return null;
}

async function createSportyBookingCode(country, selectionsStr) {
  const resp = await http.post(
    `${sportyBase(country)}/factsCenter/bookingCode`,
    { selectionsStr },
    { headers: { 'Content-Type': 'application/json', Referer: `https://www.sportybet.com/${COUNTRY_SLUGS[country] || country}/` } }
  );
  const code = resp.data?.data?.bookingCode || resp.data?.bookingCode || null;
  if (!code) throw new Error('SportyBet returned no booking code');
  return code;
}

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

/**
 * POST /api/convert
 *
 * Body:    { stakeUrl: string, country: string }
 * Returns: { ok, bookingCode, totalOdds, matchedCount, unmatchedCount, selections, meta }
 */
app.post('/api/convert', async (req, res) => {
  const { stakeUrl, country = 'ng' } = req.body;
  if (!stakeUrl) return sendError(res, 400, 'Missing field: stakeUrl');

  const betId = parseStakeBetId(stakeUrl);
  if (!betId) return sendError(res, 400,
    'Could not extract a bet slip ID from the URL. ' +
    'Expected: https://stake.com/sports/bet-slip/<id>'
  );

  // 1. Fetch Stake slip
  let slip;
  try {
    slip = await fetchStakeSlip(betId);
  } catch (err) {
    return sendError(res, 502, `Failed to fetch Stake bet slip: ${err.message}`, err.response?.data);
  }

  const stakeBets = slip.bets || [];
  if (!stakeBets.length) return sendError(res, 404, 'Bet slip contains no selections');

  // 2. Match each selection on SportyBet
  const selections     = [];
  const sportySelParts = [];

  const SPORT_ID_MAP = {
    soccer: 'sr:sport:1', football: 'sr:sport:1',
    basketball: 'sr:sport:2', tennis: 'sr:sport:5',
    cricket: 'sr:sport:21', rugby: 'sr:sport:12',
  };

  for (const bet of stakeBets) {
    const game      = bet.outcome?.market?.game;
    const market    = bet.outcome?.market?.name || 'Match Winner';
    const pick      = bet.outcome?.name         || '';
    const odds      = parseFloat(bet.odds || 1);
    const homeTeam  = game?.homeTeam?.name      || '';
    const awayTeam  = game?.awayTeam?.name      || '';
    const teams     = homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : (game?.name || 'Unknown Match');
    const league    = game?.league?.name        || '';
    const startTime = game?.startTime           || null;
    const sportSlug = game?.sport?.slug         || 'soccer';
    const sportId   = SPORT_ID_MAP[sportSlug]   || 'sr:sport:1';

    const sel = { teams, homeTeam, awayTeam, market, pick, odds, league, startTime, matched: false };

    if (homeTeam && awayTeam) {
      try {
        const events  = await searchSportyEvents(country, `${homeTeam} ${awayTeam}`, sportId);
        const matched = fuzzyMatch(events, homeTeam, awayTeam);
        if (matched) {
          const outcome = resolveOutcome(matched, pick);
          sel.matched          = !!outcome;
          sel.sportyEventId    = matched.eventId || matched.id || null;
          sel.sportyOutcomeId  = outcome?.outcomeId || outcome?.id || null;
          sel.sportyOdds       = parseFloat(outcome?.odds || odds);
          if (outcome && sel.sportyEventId && sel.sportyOutcomeId) {
            sportySelParts.push(`${sel.sportyEventId}_${sel.sportyOutcomeId}_${sel.sportyOdds.toFixed(2)}`);
          }
        }
      } catch (e) {
        sel.matchError = e.message;
      }
    }
    selections.push(sel);
  }

  // 3. Generate booking code
  let bookingCode = null;
  if (sportySelParts.length) {
    try {
      bookingCode = await createSportyBookingCode(country, sportySelParts.join('|'));
    } catch (e) {
      console.error('[BookingCode]', e.message);
    }
  }

  const totalOdds      = selections.reduce((a, s) => a * s.odds, 1);
  const matchedCount   = selections.filter(s => s.matched).length;
  const unmatchedCount = selections.length - matchedCount;

  res.json({
    ok: true,
    bookingCode,
    totalOdds:     parseFloat(totalOdds.toFixed(4)),
    matchedCount,
    unmatchedCount,
    selections,
    meta: { stakeSlipId: betId, stakeCurrency: slip.currency, country },
  });
});

/**
 * GET /api/stake/slip/:id  — fetch raw Stake slip (debug / standalone use)
 */
app.get('/api/stake/slip/:id', async (req, res) => {
  const { id } = req.params;
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) return sendError(res, 400, 'Invalid bet slip ID');
  try {
    const slip = await fetchStakeSlip(id);
    res.json({ ok: true, slip });
  } catch (err) {
    sendError(res, err.response?.status || 502, err.message, err.response?.data);
  }
});

/**
 * GET /api/sportybet/search?country=ng&q=Arsenal+Chelsea
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
 */
app.post('/api/sportybet/bookingcode', async (req, res) => {
  const { country = 'ng', selectionsStr } = req.body;
  if (!selectionsStr) return sendError(res, 400, 'Missing field: selectionsStr');
  try {
    const bookingCode = await createSportyBookingCode(country, selectionsStr);
    res.json({ ok: true, bookingCode });
  } catch (err) {
    sendError(res, 502, 'Failed to generate booking code', err.message);
  }
});

// SPA fallback
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[Unhandled]', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\n  🌉  BetBridge  →  http://localhost:${PORT}`);
  console.log(`  📡  Stake.com GraphQL  →  SportyBet API`);
  console.log(`  ENV: ${process.env.NODE_ENV || 'development'}\n`);
});
