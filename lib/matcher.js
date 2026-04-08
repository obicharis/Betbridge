/**
 * matcher.js
 * Fuzzy string matching and cross-platform market/outcome normalisation.
 *
 * Strategy:
 *  1. Normalise both strings (lowercase, remove punctuation, expand common abbrevs)
 *  2. Score with Dice coefficient on bigrams (works well for team names)
 *  3. Market/outcome names get mapped to a canonical key first, THEN compared
 */

// ─────────────────────────────────────────────────────────
// STRING NORMALISATION
// ─────────────────────────────────────────────────────────

const TEAM_ABBREVS = {
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'man city': 'manchester city',
  'spurs': 'tottenham hotspur',
  'tottenham': 'tottenham hotspur',
  'wolves': 'wolverhampton wanderers',
  'newcastle': 'newcastle united',
  'west brom': 'west bromwich albion',
  'sheffield utd': 'sheffield united',
  'nott\'m forest': 'nottingham forest',
  'notts forest': 'nottingham forest',
  'inter': 'inter milan',
  'inter milan': 'inter milan',
  'ac milan': 'milan',
  'atletico': 'atletico madrid',
  'atlético': 'atletico madrid',
  'real': 'real madrid',
  'barca': 'barcelona',
  'barça': 'barcelona',
  'paris sg': 'paris saint germain',
  'psg': 'paris saint germain',
  'paris saint-germain': 'paris saint germain',
  'rb leipzig': 'rasenballsport leipzig',
  'fc barcelona': 'barcelona',
  'fc porto': 'porto',
  'fc bayern': 'bayern munich',
  'bayern': 'bayern munich',
  'bvb': 'borussia dortmund',
  'dortmund': 'borussia dortmund',
  'ajax': 'ajax amsterdam',
  'psv': 'psv eindhoven',
  'sporting cp': 'sporting',
  'sporting lisbon': 'sporting',
};

function normaliseTeam(name) {
  if (!name) return '';
  let s = name.toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
  // expand abbreviations
  return TEAM_ABBREVS[s] || s;
}

// ─────────────────────────────────────────────────────────
// DICE COEFFICIENT (bigram overlap)
// ─────────────────────────────────────────────────────────

function bigrams(str) {
  const set = [];
  for (let i = 0; i < str.length - 1; i++) {
    set.push(str.slice(i, i + 2));
  }
  return set;
}

function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ba = bigrams(a);
  const bb = bigrams(b);
  if (ba.length === 0 || bb.length === 0) return 0;

  const setB = [...bb];
  let matches = 0;
  for (const bigram of ba) {
    const idx = setB.indexOf(bigram);
    if (idx !== -1) {
      matches++;
      setB.splice(idx, 1);
    }
  }
  return (2 * matches) / (ba.length + bb.length);
}

/**
 * Score how well two team-name strings match (0–1).
 * Also tries substring containment as a fallback.
 */
function teamScore(a, b) {
  const na = normaliseTeam(a);
  const nb = normaliseTeam(b);
  const d = dice(na, nb);
  // Bonus if one contains the other (e.g. "Arsenal" in "Arsenal FC")
  const contains = na.includes(nb) || nb.includes(na) ? 0.15 : 0;
  return Math.min(1, d + contains);
}

/**
 * Score an event match.
 * Checks home vs home + away vs away, and also cross (swap) with penalty.
 * Also checks date proximity.
 */
function eventScore(sel, candidate) {
  const homeHome = teamScore(sel.homeTeam, candidate.homeTeam);
  const awayAway = teamScore(sel.awayTeam, candidate.awayTeam);
  const normalOrder = (homeHome + awayAway) / 2;

  // Some platforms may have home/away swapped in display
  const homeAway = teamScore(sel.homeTeam, candidate.awayTeam);
  const awayHome = teamScore(sel.awayTeam, candidate.homeTeam);
  const swapOrder = (homeAway + awayHome) / 2 * 0.85; // small penalty for swap

  const teamMatchScore = Math.max(normalOrder, swapOrder);

  // Date proximity (within 4 hours = 1.0, up to 24h = 0.5, beyond = 0.1)
  let dateScore = 0.5; // neutral if no dates
  if (sel.startTime && candidate.startTime) {
    const diffMs = Math.abs(
      new Date(sel.startTime).getTime() - new Date(candidate.startTime).getTime()
    );
    const diffH = diffMs / 3_600_000;
    if (diffH <= 4)       dateScore = 1.0;
    else if (diffH <= 24) dateScore = 0.6;
    else if (diffH <= 72) dateScore = 0.3;
    else                  dateScore = 0.0;
  }

  return teamMatchScore * 0.8 + dateScore * 0.2;
}

// ─────────────────────────────────────────────────────────
// MARKET NORMALISATION MAP
// Maps various platform-specific market names → canonical key
// ─────────────────────────────────────────────────────────

const MARKET_CANON = {
  // 1X2 / Match result
  '1x2': '1x2',
  'match result': '1x2',
  'full time result': '1x2',
  'match winner': '1x2',
  'match result (ft)': '1x2',
  'result': '1x2',
  'home/draw/away': '1x2',
  'moneyline': '1x2',

  // Double chance
  'double chance': 'double_chance',
  'double chance (ft)': 'double_chance',

  // BTTS
  'both teams to score': 'btts',
  'both teams score': 'btts',
  'btts': 'btts',
  'gg/ng': 'btts',
  'goal/no goal': 'btts',

  // Over/Under total goals
  'total goals': 'total_goals',
  'over/under': 'total_goals',
  'goals over/under': 'total_goals',
  'total goals (ft)': 'total_goals',

  // Handicap
  'asian handicap': 'asian_handicap',
  'handicap': 'handicap',
  'european handicap': 'handicap',

  // Draw no bet
  'draw no bet': 'draw_no_bet',
  'draw no bet (ft)': 'draw_no_bet',

  // Correct score
  'correct score': 'correct_score',
  'exact score': 'correct_score',

  // Half time
  'half time result': 'ht_result',
  '1st half result': 'ht_result',
  'half time': 'ht_result',

  // BTTS + Win
  'btts and win': 'btts_win',
  'both teams score & win': 'btts_win',
};

function canonicalMarket(name) {
  if (!name) return name;
  const key = name.toLowerCase().trim();
  return MARKET_CANON[key] || key;
}

// ─────────────────────────────────────────────────────────
// OUTCOME NORMALISATION MAP
// Maps various outcome labels → canonical key
// ─────────────────────────────────────────────────────────

const OUTCOME_CANON = {
  // 1X2
  '1': 'home',
  'home': 'home',
  'home win': 'home',
  '1 (home)': 'home',

  'x': 'draw',
  'draw': 'draw',
  'tie': 'draw',

  '2': 'away',
  'away': 'away',
  'away win': 'away',
  '2 (away)': 'away',

  // Double chance
  '1x': 'home_draw',
  'home or draw': 'home_draw',
  '12': 'home_away',
  'home or away': 'home_away',
  'x2': 'draw_away',
  'draw or away': 'draw_away',

  // BTTS
  'yes': 'yes',
  'gg': 'yes',
  'no': 'no',
  'ng': 'no',

  // DNB
  'home (dnb)': 'home',
  'away (dnb)': 'away',
};

// For Over/Under we need to preserve the line value
function canonicalOutcome(name) {
  if (!name) return name;
  const low = name.toLowerCase().trim();

  // Handle over/under with value: "Over 2.5" → "over_2.5"
  const ouMatch = low.match(/^(over|under)\s+([\d.]+)$/);
  if (ouMatch) return `${ouMatch[1]}_${ouMatch[2]}`;

  // Handle handicap: "+1", "-1", "+1.5", "-0.5"
  const hdpMatch = low.match(/^([+-][\d.]+)$/);
  if (hdpMatch) return `hdp_${hdpMatch[1]}`;

  return OUTCOME_CANON[low] || low;
}

/**
 * Score how well two market names match (0–1).
 */
function marketScore(a, b) {
  const ca = canonicalMarket(a);
  const cb = canonicalMarket(b);
  if (ca === cb) return 1;
  return dice(ca, cb);
}

/**
 * Score how well two outcome names match (0–1).
 */
function outcomeScore(a, b) {
  const ca = canonicalOutcome(a);
  const cb = canonicalOutcome(b);
  if (ca === cb) return 1;
  return dice(ca, cb);
}

module.exports = {
  teamScore,
  eventScore,
  marketScore,
  outcomeScore,
  canonicalMarket,
  canonicalOutcome,
  normaliseTeam,
};
