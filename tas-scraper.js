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
//
// Each entry in `sports` is a filtered TAS "fixtures" URL for one sport/competition
// group. To get one: open https://fixtures.clipboard.app/tas/fixtures, use the
// Filter panel to pick a sport (and grade/competition group if it offers one),
// then copy the URL the page lands on and paste it below. One line per sport —
// this is the only manual step, and only needs redoing once a season (or if TAS
// changes how a competition is grouped).
const CONFIG = {
  schoolName: 'Canterbury',
  sports: [
    {
      sport: 'Basketball',
      url: 'https://fixtures.clipboard.app/tas/fixtures?associationSeasonId=4f3d0fea-c36e-11f0-a05d-7f9e8a3a8eea&associationActivityTypeIds=%5B%22919dddc6-8763-11ef-ba61-b5575f4a157b%22%5D&associationActivityGradeIds=%5B%5D&organisationIds=%5B340,341,389,1141,434,1093,479,492,521%5D&competitionGroupIds=%5B%22e224c106-93df-45fc-b90a-f106e1f4dba6%22%5D',
    },
    // { sport: 'Volleyball', url: 'PASTE THE VOLLEYBALL FILTER URL HERE' },
    // { sport: 'Football (Soccer)', url: 'PASTE THE FOOTBALL FILTER URL HERE' },
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
          const teamSpans = Array.from(cells[1]?.querySelectorAll('.participant__team span') || []).map((s) =>
            s.textContent.trim()
          );
          return {
            rank: cells[0]?.textContent.trim() || '',
            org: teamSpans[0] || '',
            grade: teamSpans[1] || '',
            team: teamSpans[2] || '',
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
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const targetSaturday = mostRecentSaturday();

  const output = {
    generatedAt: new Date().toISOString(),
    weekOf: targetSaturday.toISOString().slice(0, 10),
    sports: [],
  };

  for (const cfg of CONFIG.sports) {
    console.log(`Scraping ${cfg.sport}...`);
    await page.goto(cfg.url, { waitUntil: 'networkidle' });

    // ---- ladder ----
    await clickTab(page, 'Ladders');
    await page.waitForSelector('mat-card table', { timeout: 15000 }).catch(() => {});
    const ladder = await extractLadders(page);

    // ---- fixtures / results, paged (TAS shows up to 250 rows per page) ----
    await clickTab(page, 'Fixtures');
    await page.waitForSelector('cb-association-fixture-list table tbody tr', { timeout: 15000 }).catch(() => {});
    let allRows = [];
    let hasMore = true;
    while (hasMore) {
      allRows = allRows.concat(await extractFixturePage(page));
      hasMore = await goToNextPage(page);
    }

    const canterburyLastSaturday = allRows
      .filter((r) => r.homeOrg === CONFIG.schoolName || r.awayOrg === CONFIG.schoolName)
      .filter((r) => sameDay(parseFixtureDate(r.dateText), targetSaturday))
      .map((r) => ({
        sport: cfg.sport,
        gender: r.gender,
        grade: r.homeOrg === CONFIG.schoolName ? r.homeGrade : r.awayGrade,
        home: `${r.homeOrg} ${r.homeTeam}`.trim(),
        away: `${r.awayOrg} ${r.awayTeam}`.trim(),
        score: r.scoreText,
        result: r.winnerText,
        venue: r.venueText,
        date: r.dateText,
      }));

    output.sports.push({ sport: cfg.sport, ladder, canterburyResults: canterburyLastSaturday });
  }

  await browser.close();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
  console.log(`Wrote ${OUTPUT_PATH} (${output.sports.length} sport(s), week of ${output.weekOf})`);
})().catch((err) => {
  console.error('Scrape failed:', err);
  process.exit(1);
});
