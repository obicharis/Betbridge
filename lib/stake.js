/**
 * stake.js
 * All Stake.com API interactions (GraphQL).
 *
 * Deeplink format:
 *   Single event view:  https://stake.com/sports/eventView/{sport}/{tournament}/{fixture-slug}
 *   Betslip pre-fill:   append ?bt={outcomeId}&bt={outcomeId2}...
 *
 * Multiple selections from different events:
 *   https://stake.com/sports?bt=outcomeId1&bt=outcomeId2
 */

const fetch = require('node-fetch');

const GQL_URL = 'https://stake.com/_api/graphql';
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin': 'https://stake.com',
  'Referer': 'https://stake.com/',
  // No auth token needed for public share/search queries
};

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ query, variables }),
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`Stake GQL HTTP ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────────────────
// FETCH SHARE CODE
// ─────────────────────────────────────────────────────────

const SHARE_BET_QUERY = `
  query ShareBet($shareCode: String!) {
    shareBet(shareCode: $shareCode) {
      id type active totalOdds currency amount
      bets {
        id active odds
        outcome { id name }
        market  { id name }
        fixture {
          id name slug startTime
          tournament { name slug }
          sport      { name slug }
          home       { name }
          away       { name }
        }
      }
    }
  }
`;

function extractCode(input) {
  return input
    .replace(/https?:\/\/(www\.)?stake\.com\/?/i, '')
    .replace(/[?&]shareCode=/i, '')
    .replace(/.*\/bets\/share\//i, '')
    .replace(/.*\/share\//i, '')
    .replace(/^[/?&]+/, '')
    .trim();
}

async function fetchShareCode(codeOrUrl) {
  const code = extractCode(codeOrUrl);
  try {
    const data = await gql(SHARE_BET_QUERY, { shareCode: code });
    if (data?.data?.shareBet) return { code, raw: data.data.shareBet };
    return null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// SEARCH FIXTURES
// ─────────────────────────────────────────────────────────

/**
 * Stake has a sportSearch or fixtureSearch query.
 * We try the general search and the sport-scoped search.
 */
const SEARCH_FIXTURES_QUERY = `
  query SearchFixtures($query: String!) {
    searchFixtures(query: $query) {
      fixtures {
        id name slug startTime
        sport      { name slug }
        tournament { name slug }
        home       { name }
        away       { name }
      }
    }
  }
`;

/**
 * If searchFixtures isn't available, fall back to looking up via sport fixtures.
 */
const SPORT_FIXTURES_QUERY = `
  query SportFixtures($sportSlug: String!, $search: String, $limit: Int) {
    sport(slug: $sportSlug) {
      fixtures(search: $search, limit: $limit, status: [upcoming, live]) {
        id name slug startTime
        tournament { name slug }
        home { name }
        away { name }
      }
    }
  }
`;

async function searchFixtures(keyword, sportSlug = 'football') {
  // Try general search first
  try {
    const data = await gql(SEARCH_FIXTURES_QUERY, { query: keyword });
    const fixtures = data?.data?.searchFixtures?.fixtures;
    if (Array.isArray(fixtures) && fixtures.length > 0) {
      return fixtures;
    }
  } catch (_) { /* fall through */ }

  // Fallback: sport-scoped search
  try {
    const data = await gql(SPORT_FIXTURES_QUERY, {
      sportSlug,
      search: keyword,
      limit: 10,
    });
    const fixtures = data?.data?.sport?.fixtures;
    if (Array.isArray(fixtures)) return fixtures;
  } catch (_) { /* give up */ }

  return [];
}

// ─────────────────────────────────────────────────────────
// FETCH FIXTURE MARKETS (needed for outcome IDs)
// ─────────────────────────────────────────────────────────

const FIXTURE_MARKETS_QUERY = `
  query FixtureMarkets($fixtureId: String!) {
    fixture(id: $fixtureId) {
      id name slug startTime
      sport      { name slug }
      tournament { name slug }
      home { name }
      away { name }
      markets {
        id name
        outcomes {
          id name
          odds
          active
        }
      }
    }
  }
`;

async function fetchFixtureMarkets(fixtureId) {
  try {
    const data = await gql(FIXTURE_MARKETS_QUERY, { fixtureId });
    return data?.data?.fixture || null;
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// NORMALISE SHARE RESPONSE
// ─────────────────────────────────────────────────────────

function normalise(raw) {
  const bets = raw.bets || [];
  const selections = bets.map(bet => ({
    eventName:   bet.fixture?.name || '',
    homeTeam:    bet.fixture?.home?.name || '',
    awayTeam:    bet.fixture?.away?.name || '',
    startTime:   bet.fixture?.startTime || null,
    sport:       (bet.fixture?.sport?.name || 'football').toLowerCase(),
    sportSlug:   bet.fixture?.sport?.slug || 'football',
    tournament:  bet.fixture?.tournament?.name || '',
    market:      bet.market?.name || '',
    selection:   bet.outcome?.name || '',
    odds:        parseFloat(bet.odds || 0),
    fixtureId:   bet.fixture?.id || '',
    fixtureSlug: bet.fixture?.slug || '',
    marketId:    bet.market?.id || '',
    outcomeId:   bet.outcome?.id || '',
  }));

  return {
    platform:   'stake',
    betType:    (raw.type || 'combo').toLowerCase(),
    totalOdds:  parseFloat(raw.totalOdds || 0),
    selections,
    stake:      raw.amount || null,
    currency:   raw.currency || 'USD',
  };
}

// ─────────────────────────────────────────────────────────
// NORMALISE A SEARCH RESULT FIXTURE (for matching)
// ─────────────────────────────────────────────────────────

function normaliseSearchFixture(fix) {
  return {
    fixtureId:   fix.id,
    fixtureSlug: fix.slug,
    eventName:   fix.name || '',
    homeTeam:    fix.home?.name || '',
    awayTeam:    fix.away?.name || '',
    startTime:   fix.startTime || null,
    sport:       (fix.sport?.name || 'football').toLowerCase(),
    sportSlug:   fix.sport?.slug || 'football',
    tournament:  fix.tournament?.name || '',
    // Markets populated only from fetchFixtureMarkets
    markets:     (fix.markets || []).map(m => ({
      marketId:   m.id,
      marketName: m.name || '',
      outcomes:   (m.outcomes || []).map(o => ({
        outcomeId:   o.id,
        outcomeName: o.name || '',
        odds:        parseFloat(o.odds || 0),
        active:      o.active !== false,
      })),
    })),
  };
}

// ─────────────────────────────────────────────────────────
// BUILD DEEPLINK
// ─────────────────────────────────────────────────────────

function buildDeeplink(resolvedSelections) {
  const outcomeIds = resolvedSelections
    .map(s => s.targetOutcomeId)
    .filter(Boolean);

  if (outcomeIds.length === 0) return null;

  // If all from same fixture, link directly to event view with bt params
  const slugs = [...new Set(resolvedSelections.map(s => s.targetFixtureSlug).filter(Boolean))];
  const sports = [...new Set(resolvedSelections.map(s => s.targetSportSlug).filter(Boolean))];
  const tournaments = [...new Set(resolvedSelections.map(s => s.targetTournamentSlug).filter(Boolean))];

  if (slugs.length === 1 && sports.length === 1 && tournaments.length === 1) {
    const btParams = outcomeIds.map(id => `bt=${encodeURIComponent(id)}`).join('&');
    return `https://stake.com/sports/eventView/${sports[0]}/${tournaments[0]}/${slugs[0]}?${btParams}`;
  }

  // Multiple events → sports home with bt params (betslip widget picks them up)
  const btParams = outcomeIds.map(id => `bt=${encodeURIComponent(id)}`).join('&');
  return `https://stake.com/sports?${btParams}`;
}

module.exports = {
  fetchShareCode,
  searchFixtures,
  fetchFixtureMarkets,
  normalise,
  normaliseSearchFixture,
  buildDeeplink,
  extractCode,
};
