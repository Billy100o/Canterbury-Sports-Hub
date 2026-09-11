// tas-scraper.js
//
// Scrapes Canterbury's fixtures/results + full division ladders from the TAS
// (The Associated Schools) competition site. TAS itself is just a landing page —
// the actual data lives on a JS app called Clipboard (fixtures.clipboard.app),
// which has no public API, so this drives a real headless browser to read the
// rendered page. Every selector below was checked against the live site, not guessed.
//
// Install:   npm install playwright && npx playwright install chromium
// Run once:  node tas-scraper.js
// Schedule:  see tas-scraper.yml (GitHub Actions) alongside this file.
//
// Output: writes data.json next to this script — that's the file your dashboard
// front end reads and displays. Nothing else needs to touch this script weekly.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
// `schoolName` must match the org name exactly as TAS displays it (case-sensitive).
// `organisationId` is Canterbury's numeric TAS org id (visible in the URL of any
// fixture card's logo image, or just trust this one — it's confirmed correct).
//
// RESULTS come from `resultsUrl` alone, and cover EVERY sport Canterbury plays —
// filtering the Fixtures page by organisation only (no sport/competition filter)
// returns all of Canterbury's matches across the whole season, live-tested against
// the real site. Nothing else needs to be added here for new sports to start
// showing up in results/scores/the ticker.
//
// LADDERS are different: a ladder table only makes sense for one specific
// sport/competition at a time (there's no such thing as a combined ladder across
// sports), so each sport you want a ladder shown for needs its own filtered URL.
// To get one: open the sport's ladder on fixtures.clipboard.app (either through
// the Filter panel on /tas/fixtures, or straight to /tas/ladder?...&view=table),
// then copy the full URL the page lands on and add it below with the correct
// sport name. Both URL styles work fine — the script checks which tab it landed
// on and only clicks across to "Ladders" if it needs to. This is the only manual
// step in the whole system, and only needs doing once per sport per season.
const CONFIG = {
  schoolName: 'Canterbury',
  organisationId: 341,
  resultsUrl: 'https://fixtures.clipboard.app/tas/fixtures?organisationIds=%5B341%5D',
  // Every entry below was confirmed live against the site's own Filter panel
  // (which shows the exact competition name, e.g. "Boys Basketball"), not
  // guessed from the URL or the division names.
  ladders: [
    {
      sport: 'Basketball (Boys)',
      url: 'https://fixtures.clipboard.app/tas/ladder?associationSeasonId=4f3d0fea-c36e-11f0-a05d-7f9e8a3a8eea&associationActivityTypeIds=%5B%5D&associationActivityGradeIds=%5B%5D&organisationIds=%5B340,341,389,1141,434,1093,479,492,521%5D&view=table&competitionGroupId=e224c106-93df-45fc-b90a-f106e1f4dba6',
    },
    {
      sport: 'Volleyball (Girls)',
      url: 'https://fixtures.clipboard.app/tas/ladder?associationSeasonId=4f3d0fea-c36e-11f0-a05d-7f9e8a3a8eea&associationActivityTypeIds=%5B%5D&associationActivityGradeIds=%5B%5D&organisationIds=%5B340,341,389,1141,434,1093,479,492,521%5D&view=table&competitionGroupId=9dcbf4eb-f176-452a-8a14-0fa99d78461e',
    },
    {
      sport: 'Football/Soccer (Boys)',
      url: 'https://fixtures.clipboard.app/tas/ladder?associationSeasonId=4f3d0fea-c36e-11f0-a05d-7f9e8a3a8eea&associationActivityTypeIds=%5B%5D&associationActivityGradeIds=%5B%5D&organisationIds=%5B340,341,389,1141,434,1093,479,492,521%5D&view=table&competitionGroupId=6b0b8ece-ebb9-44f6-b66c-864ac0237952',
    },
    {
      sport: 'Touch Football',
      url: 'https://fixtures.clipboard.app/tas/ladder?associationSeasonId=4f3d0fea-c36e-11f0-a05d-7f9e8a3a8eea&associationActivityTypeIds=%5B%5D&associationActivityGradeIds=%5B%5D&organisationIds=%5B340,341,389,1141,434,1093,479,492,521%5D&view=table&competitionGroupId=f503b0cb-2d44-4025-b76a-7b55abb4fe67',
    },
  ],
};

const OUTPUT_PATH = path.join(__dirname, 'data.json');

// ---------------------------------------------------------------------------
// Date helpers — the site prints dates like " 18 Jul 2026 "
// ---------------------------------------------------------------------------
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseFixtureDate(text) {
  const m = (text || '').match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month === -1) return null;
  return new Date(parseInt(m[3], 10), month, parseInt(m[1], 10));
}

// The most recent Saturday on/before `from` — this is "last weekend" from the
// scraper's point of view, whether it runs Saturday night or any day after.
function mostRecentSaturday(from = new Date()) {
  const d = new Date(from);
  const diff = (d.getDay() + 1) % 7; // days since the last Saturday (Sat=6 -> 0)
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function sameDay(a, b) {
  return !!a && !!b && a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ---------------------------------------------------------------------------
// Page-side extraction (runs inside the browser, not in Node)
// ---------------------------------------------------------------------------
async function extractLadders(page) {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('mat-card'));
    return cards
      .map((card) => {
        const division = card.querySelector('.ladder-header-row h3')?.textContent.trim() || '';
        const table = card.querySelector('table');
        if (!table) return null;
        const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td'));
          // Ladder team cells hold just [org name, team label] — e.g. ["CHAC", "1st VI"] —
          // unlike fixture rows below, which also carry a separate grade name. The
          // division/grade here is already the card's heading, not a per-row field.
          const teamSpans = Array.from(cells[1]?.querySelectorAll('.participant__team span') || []).map((s) =>
            s.textContent.trim()
          );
          return {
            rank: cells[0]?.textContent.trim() || '',
            org: teamSpans[0] || '',
            team: teamSpans[1] || '',
            // aligned with headers.slice(2) — e.g. P, W, FW, L, FL, D, C, Byes, Points
            stats: cells.slice(2).map((td) => td.textContent.trim()),
          };
        });
        return { division, headers, rows };
      })
      .filter(Boolean);
  });
}

async function extractFixturePage(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('cb-association-fixture-list table tbody tr'));
    return rows.map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td'));
      const sportSpans = Array.from(cells[1]?.querySelectorAll('span') || []).map((s) => s.textContent.trim());
      const homeSpans = Array.from(cells[2]?.querySelectorAll('.participant__team span') || []).map((s) =>
        s.textContent.trim()
      );
      const awaySpans = Array.from(cells[4]?.querySelectorAll('.participant__team span') || []).map((s) =>
        s.textContent.trim()
      );
      const resultSpans = Array.from(cells[5]?.querySelectorAll('.result-overflow-container span') || []).map((s) =>
        s.textContent.trim()
      );
      const winnerSpan = cells[5]?.querySelector('.small-secondary-text');
      const dateBlocks = Array.from(cells[6]?.querySelectorAll(':scope > div') || []);
      return {
        round: cells[0]?.textContent.trim() || '',
        sport: sportSpans[0] || '',
        gender: sportSpans[1] || '',
        homeOrg: homeSpans[0] || '',
        homeGrade: homeSpans[1] || '',
        homeTeam: homeSpans[2] || '',
        awayOrg: awaySpans[0] || '',
        awayGrade: awaySpans[1] || '',
        awayTeam: awaySpans[2] || '',
        scoreText: resultSpans[0] || '',
        winnerText: winnerSpan ? winnerSpan.textContent.trim() : '',
        dateText: (dateBlocks[0]?.textContent || '').replace(/\s+/g, ' ').trim(),
        venueText: (dateBlocks[1]?.textContent || '').replace(/\s+/g, ' ').trim(),
      };
    });
  });
}

async function clickTab(page, label) {
  await page.evaluate((label) => {
    const el = Array.from(document.querySelectorAll('a,button,[role="tab"]')).find(
      (e) => e.textContent.trim() === label
    );
    if (el) el.click();
  }, label);
  await page.waitForTimeout(1500);
}

async function goToNextPage(page) {
  const btn = await page.$('mat-paginator button.mat-mdc-paginator-navigation-next');
  if (!btn) return false;
  // This site's "Next page" button uses Material's "disabled-interactive" pattern:
  // the native `disabled` property stays false even when there's nothing left to
  // page through — it signals "no more pages" via aria-disabled="true" instead.
  // Checking only `.disabled` (as an earlier version of this script did) makes
  // Playwright wait forever for a button that's actually already at the end.
  const isDisabled = await btn.evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true');
  if (isDisabled) return false;
  try {
    await btn.click({ timeout: 5000 });
  } catch (err) {
    // Belt-and-braces: if a click still hangs for some other reason, don't let
    // it crash the whole run — just stop paging and use what's been collected.
    console.warn('Could not advance to next page, stopping pagination:', err.message);
    return false;
  }
  await page.waitForTimeout(1200);
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function scrapeAllPages(page) {
  let allRows = [];
  let hasMore = true;
  while (hasMore) {
    allRows = allRows.concat(await extractFixturePage(page));
    hasMore = await goToNextPage(page);
  }
  return allRows;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const targetSaturday = mostRecentSaturday();

  // ---- results: ONE url, covers every sport Canterbury plays ----
  console.log('Scraping results (all sports)...');
  await page.goto(CONFIG.resultsUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('cb-association-fixture-list table tbody tr', { timeout: 15000 }).catch(() => {});
  const allRows = await scrapeAllPages(page);

  const canterburyResults = allRows
    .filter((r) => r.homeOrg === CONFIG.schoolName || r.awayOrg === CONFIG.schoolName)
    .filter((r) => sameDay(parseFixtureDate(r.dateText), targetSaturday))
    .map((r) => ({
      sport: r.sport,
      gender: r.gender,
      grade: r.homeOrg === CONFIG.schoolName ? r.homeGrade : r.awayGrade,
      home: `${r.homeOrg} ${r.homeTeam}`.trim(),
      away: `${r.awayOrg} ${r.awayTeam}`.trim(),
      score: r.scoreText,
      result: r.winnerText,
      venue: r.venueText,
      date: r.dateText,
    }));

  // ---- ladders: one url per sport (see CONFIG comment for why) ----
  const ladders = [];
  for (const cfg of CONFIG.ladders) {
    console.log(`Scraping ${cfg.sport} ladder...`);
    await page.goto(cfg.url, { waitUntil: 'networkidle' });
    // Some ladder URLs (the old /tas/fixtures?...&competitionGroupIds=[...] style)
    // land on the Fixtures tab and need a click across to Ladders. Others (the
    // newer /tas/ladder?...&view=table style) already land directly on the
    // ladder. Checking first — instead of always clicking — means this works
    // for both URL styles without risking an extra click on a page that's
    // already showing the ladder.
    const alreadyOnLadder = await page
      .waitForSelector('.ladder-header-row h3', { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!alreadyOnLadder) {
      await clickTab(page, 'Ladders');
    }
    await page.waitForSelector('mat-card table', { timeout: 15000 }).catch(() => {});
    const divisions = await extractLadders(page);
    ladders.push({ sport: cfg.sport, divisions });
  }

  await browser.close();

  const output = {
    generatedAt: new Date().toISOString(),
    weekOf: targetSaturday.toISOString().slice(0, 10),
    canterburyResults,
    ladders,
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(
    `Wrote ${OUTPUT_PATH} (${canterburyResults.length} result(s) across all sports, ${ladders.length} ladder sport(s), week of ${output.weekOf})`
  );
})().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
