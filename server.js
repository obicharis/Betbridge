const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// SPORTYBET → STAKE
// ─────────────────────────────────────────────

/**
 * Fetch a SportyBet share code and return parsed selections.
 * Tries multiple country endpoints (NG, GH, KE, ZA, TZ, UG, ET)
 * since users from different regions use different sub-domains.
 */
async function fetchSportyBet(shareCode) {
  const countries = ['ng', 'gh', 'ke', 'za', 'tz', 'ug', 'et'];
  const ts = Date.now();

  for (const country of countries) {
    try {
      const url = `https://www.sportybet.com/api/${country}/orders/share?shareCode=${encodeURIComponent(shareCode)}&_time=${ts}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': `https://www.sportybet.com/${country}/`,
        },
        timeout: 8000,
      });

      if (!res.ok) continue;
      const data = await res.json();

      // SportyBet wraps data inside data.bizCode === 0
      if (data && data.bizCode === 0 && data.data) {
        return { country, raw: data.data };
      }
    } catch (_) {
      // try next country
    }
  }
  return null;
}

/**
 * Normalise SportyBet raw response into our universal format.
 */
function normaliseSportyBet(raw) {
  const betInfo = raw.betInfo || raw;
  const orders = betInfo.orders || betInfo.betOrders || [];

  const selections = orders.map(order => {
    const event = order.eventInfo || order;
    const market = order.marketInfo || {};
    const outcome = order.outcomeInfo || {};

    return {
      eventName: event.eventName || event.name || 'Unknown Event',
      homeTeam: event.homeTeamName || event.home || '',
      awayTeam: event.awayTeamName || event.away || '',
      startTime: event.estimateStartTime || event.startTime || null,
      sport: event.sportName || event.sport || '',
      tournament: event.tournamentName || event.tournament || '',
      market: market.marketName || market.name || order.marketName || '',
      selection: outcome.outcomeName || outcome.name || order.outcomeName || '',
      odds: parseFloat(order.oddValue || order.odds || outcome.odds || 0),
      eventId: event.eventId || event.id || '',
    };
  });

  const totalOdds = parseFloat(
    betInfo.totalOdds || betInfo.combinedOdds ||
    selections.reduce((acc, s) => acc * (s.odds || 1), 1).toFixed(2)
  );

  return {
    platform: 'sportybet',
    betType: (betInfo.betType || betInfo.orderType || 'combo').toLowerCase(),
    totalOdds,
    selections,
    stake: betInfo.betAmount || betInfo.stake || null,
    currency: betInfo.currency || 'NGN',
  };
}

// ─────────────────────────────────────────────
// STAKE → SPORTYBET
// ─────────────────────────────────────────────

/**
 * Fetch a Stake share-bet link.
 * Stake uses GraphQL. We query the shareBet query.
 */
async function fetchStake(shareCode) {
  // Strip full URL down to just the code
  const code = shareCode
    .replace(/https?:\/\/(www\.)?stake\.com\/?/i, '')
    .replace(/[?&]shareCode=/i, '')
    .replace(/.*\/bets\/share\//i, '')
    .replace(/.*\/share\//i, '')
    .trim()
    .replace(/^[/?&]+/, '');

  const query = `
    query ShareBet($shareCode: String!) {
      shareBet(shareCode: $shareCode) {
        id
        type
        active
        totalOdds
        currency
        amount
        bets {
          id
          active
          odds
          outcome { id name }
          market { id name }
          fixture {
            id
            name
            slug
            startTime
            tournament { name }
            sport { name slug }
            home { name }
            away { name }
          }
        }
      }
    }
  `;

  try {
    const res = await fetch('https://stake.com/_api/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
        'Accept': 'application/json',
        'x-access-token': '', // public endpoint, no token needed for share
      },
      body: JSON.stringify({ query, variables: { shareCode: code } }),
      timeout: 8000,
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (data?.data?.shareBet) {
      return { code, raw: data.data.shareBet };
    }
    return null;
  } catch (_) {
    return null;
  }
}

/**
 * Normalise Stake raw response into our universal format.
 */
function normaliseStake(raw) {
  const bets = raw.bets || [];

  const selections = bets.map(bet => ({
    eventName: bet.fixture?.name || '',
    homeTeam: bet.fixture?.home?.name || '',
    awayTeam: bet.fixture?.away?.name || '',
    startTime: bet.fixture?.startTime || null,
    sport: bet.fixture?.sport?.name || '',
    tournament: bet.fixture?.tournament?.name || '',
    market: bet.market?.name || '',
    selection: bet.outcome?.name || '',
    odds: parseFloat(bet.odds || 0),
    fixtureId: bet.fixture?.id || '',
    fixtureSlug: bet.fixture?.slug || '',
  }));

  return {
    platform: 'stake',
    betType: (raw.type || 'combo').toLowerCase(),
    totalOdds: parseFloat(raw.totalOdds || 0),
    selections,
    stake: raw.amount || null,
    currency: raw.currency || 'USD',
  };
}

// ─────────────────────────────────────────────
// BUILD TARGET LINKS
// ─────────────────────────────────────────────

/**
 * Build a best-effort Stake betslip URL from normalised selections.
 * Stake accepts ?bt-[slug]-[marketKey]-[outcomeKey] query params.
 * Since we can't perfectly map IDs cross-platform, we build a
 * search-ready output the user can verify.
 */
function buildStakeLink(normalised) {
  const base = 'https://stake.com/sports/search?q=';
  const firstEvent = normalised.selections[0];
  if (!firstEvent) return null;
  const searchTerm = encodeURIComponent(
    firstEvent.homeTeam && firstEvent.awayTeam
      ? `${firstEvent.homeTeam} ${firstEvent.awayTeam}`
      : firstEvent.eventName
  );
  return `${base}${searchTerm}`;
}

/**
 * Build a best-effort SportyBet share/betslip URL.
 * SportyBet accepts betslip URLs with event IDs.
 */
function buildSportyBetLink(normalised, country = 'ng') {
  const base = `https://www.sportybet.com/${country}/sport/football`;
  const firstEvent = normalised.selections[0];
  if (!firstEvent) return null;
  return base; // deeplink without cross-platform event IDs falls back to homepage
}

// ─────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────

// Convert SportyBet code → Stake
app.get('/api/sportybet-to-stake', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    const result = await fetchSportyBet(code.trim());
    if (!result) {
      return res.status(404).json({
        error: 'Could not fetch bet slip. Please check the share code and try again.',
      });
    }

    const normalised = normaliseSportyBet(result.raw);
    const stakeLink = buildStakeLink(normalised);

    return res.json({
      success: true,
      source: { platform: 'sportybet', country: result.country, code },
      betslip: normalised,
      targetLink: stakeLink,
      targetPlatform: 'stake',
      note: 'Stake uses event-specific IDs. The link opens a search for the first event. Use the selections list to manually add each to your Stake betslip.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Convert Stake code/link → SportyBet
app.get('/api/stake-to-sportybet', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code is required' });

  try {
    const result = await fetchStake(code.trim());
    if (!result) {
      return res.status(404).json({
        error: 'Could not fetch bet slip. Please check the share code/link and try again.',
      });
    }

    const normalised = normaliseStake(result.raw);
    const sportyLink = buildSportyBetLink(normalised);

    return res.json({
      success: true,
      source: { platform: 'stake', code: result.code },
      betslip: normalised,
      targetLink: sportyLink,
      targetPlatform: 'sportybet',
      note: 'SportyBet event IDs differ from Stake. Use the selections list to manually recreate the bet on SportyBet.',
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
});

// Health check
app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Catch-all → serve frontend
app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`BetBridge running on http://localhost:${PORT}`);
});
