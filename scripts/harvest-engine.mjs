/**
 * NPay Harvester Core Engine (for Ego Lite AI Browser)
 * Automatically processes Naver Pay point accumulation links.
 */

import fs from "fs";

export async function harvestNpayLinks({ rawInput, inputFilePath } = {}) {
  let text = rawInput || "";
  if (!text && inputFilePath && fs.existsSync(inputFilePath)) {
    text = fs.readFileSync(inputFilePath, "utf-8");
  }

  // 1. Extract URLs from input text
  const urlRegex = /(https?:\/\/[^\s\)\"\'>]+)/gi;
  const rawUrls = (text.match(urlRegex) || []).map(u => u.trim());

  // Normalize URLs (resolve ppomppu redirects if present)
  const targetUrls = Array.from(new Set(rawUrls.map(u => {
    if (u.includes("s.ppomppu.co.kr") && u.includes("target=")) {
      try {
        const parsed = new URL(u);
        const encodedTarget = parsed.searchParams.get("target");
        if (encodedTarget) {
          return Buffer.from(encodedTarget, "base64").toString("utf-8");
        }
      } catch (e) {}
    }
    return u;
  })));

  console.log(`[NPay Harvester] Total unique URLs extracted: ${targetUrls.length}`);

  // Create isolated Task Space in Ego Browser
  const task = await taskSpace("npay-harvest-session");
  const page = task.page("p1");

  const results = {
    startPoints: 0,
    endPoints: 0,
    processed: [],
    errors: []
  };

  try {
    // Check initial points
    await page.goto("https://point.pay.naver.com/pointshistory/list", { timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));
    results.startPoints = await page.evaluate(() => {
      const el = document.querySelector('[class*="balance"], [class*="point"]');
      const m = el ? el.innerText.replace(/[^0-9]/g, "") : "0";
      return parseInt(m, 10) || 0;
    });

    // Optional: Open daissue link-opener
    try {
      await page.goto("https://daissue.app/link-opener", { timeout: 15000 });
      await new Promise(r => setTimeout(r, 1500));
      await page.fill("textarea", targetUrls.join("\n"));
      await page.click("button:has-text('링크 열기')", { label: "open links in daissue" }).catch(() => {});
      await new Promise(r => setTimeout(r, 2000));
    } catch (e) {
      console.log("[NPay Harvester] daissue open note:", e.message);
    }

    // Process Mission Types
    for (const url of targetUrls) {
      console.log(`[Processing] ${url}`);
      try {
        // Type 1: campaign2 click-point (requires clicking "포인트 받기" and staying 3+ sec)
        if (url.includes("campaign2.naver.com/npay/v2/click-point")) {
          await page.goto(url, { timeout: 20000 });
          await new Promise(r => setTimeout(r, 1500));
          const clicked = await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('a, button')).find(x => x.innerText && x.innerText.includes('포인트 받기'));
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (clicked) {
            await new Promise(r => setTimeout(r, 4500));
            results.processed.push({ url, type: "campaign2", status: "point_claimed" });
          } else {
            results.processed.push({ url, type: "campaign2", status: "no_button_or_already_claimed" });
          }
          continue;
        }

        // Type 2: Pension mission (point.pay.naver.com ... pensionmission)
        if (url.includes("pensionmission")) {
          await page.goto(url, { timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          const pensionCount = await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('a, button')).filter(el => {
              const t = el.innerText || "";
              return (t.includes("미래에셋") || t.includes("삼성자산") || t.includes("확인하기")) && (t.includes("10원") || t.includes("확인"));
            });
            btns.forEach(b => b.click());
            return btns.length;
          });
          await new Promise(r => setTimeout(r, 3000));
          results.processed.push({ url, type: "pension", clickedCount: pensionCount });
          continue;
        }

        // Type 3: MyCar missions
        if (url.includes("mycar.naver.com")) {
          await page.goto(url, { timeout: 20000 });
          await new Promise(r => setTimeout(r, 2500));
          const mycarHrefs = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('a')).filter(a => {
              const t = a.innerText || "";
              return (t.includes("적립") || t.includes("클릭") || t.includes("원 받기") || t.includes("방문")) && !t.includes("결제");
            });
            return items.map(a => a.href).filter(h => h && h.includes("clkMission"));
          });
          for (const mUrl of mycarHrefs) {
            await page.goto(mUrl, { timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
          }
          results.processed.push({ url, type: "mycar", count: mycarHrefs.length });
          continue;
        }

        // Type 4: Insurance missions
        if (url.includes("insurance.pay.naver.com")) {
          await page.goto("https://insurance.pay.naver.com/point", { timeout: 20000 });
          await new Promise(r => setTimeout(r, 2000));
          const insrHrefs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
              .map(a => a.href)
              .filter(h => h && h.includes("insu_v3_benefits_clk"));
          });
          for (const iUrl of insrHrefs) {
            await page.goto(iUrl, { timeout: 15000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
          }
          results.processed.push({ url, type: "insurance", count: insrHrefs.length });
          continue;
        }

        // Type 5: Mobile Web Emulation tasks (home.pay.naver.com, new-m.pay.naver.com)
        if (url.includes("home.pay.naver.com") || url.includes("new-m.pay.naver.com")) {
          // Set mobile emulation
          await page.cdp("Network.setUserAgentOverride", {
            userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36"
          });
          await page.cdp("Emulation.setDeviceMetricsOverride", {
            width: 412,
            height: 915,
            deviceScaleFactor: 2.625,
            mobile: true
          });

          await page.goto(url, { timeout: 20000 });
          await new Promise(r => setTimeout(r, 2500));

          // If payment home scroll task
          if (url.includes("historybenefit/home")) {
            for (let i = 0; i < 8; i++) {
              await page.evaluate(() => window.scrollBy(0, 500));
              await new Promise(r => setTimeout(r, 1000));
            }
            for (let i = 0; i < 4; i++) {
              await page.evaluate(() => window.scrollBy(0, -200));
              await new Promise(r => setTimeout(r, 1000));
            }
          } else {
            // Find mobile 3 won buttons
            await page.evaluate(() => window.scrollBy(0, 400));
            await page.evaluate(() => {
              const target = Array.from(document.querySelectorAll('button, a, div, span')).find(el => {
                const t = el.innerText || "";
                return (t.includes("3원") || t === "적립" || t.includes("적립하기")) && el.children.length <= 1;
              });
              if (target) target.click();
            });
            await new Promise(r => setTimeout(r, 1500));
          }

          results.processed.push({ url, type: "mobile_web", status: "completed" });
          continue;
        }

        // Default navigation (Adison, Shopping live, etc.)
        await page.goto(url, { timeout: 20000 });
        await new Promise(r => setTimeout(r, 2500));
        results.processed.push({ url, type: "direct_visit", status: "success" });

      } catch (itemErr) {
        results.errors.push({ url, error: itemErr.message });
      }
    }

    // Check final points
    await page.goto("https://point.pay.naver.com/pointshistory/list", { timeout: 20000 });
    await new Promise(r => setTimeout(r, 2500));
    results.endPoints = await page.evaluate(() => {
      const el = document.querySelector('[class*="balance"], [class*="point"]');
      const m = el ? el.innerText.replace(/[^0-9]/g, "") : "0";
      return parseInt(m, 10) || 0;
    });

  } finally {
    await task.finish({ keep: [] });
  }

  return results;
}
