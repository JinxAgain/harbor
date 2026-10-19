import assert from "node:assert/strict";
import test from "node:test";
import { parseDesktopSearchHtml, parseMobileSearchHtml } from "../src/lib/providers/douban";

test("parseMobileSearchHtml extracts doubanId and numeric rating from mobile search HTML", () => {
  const html = `
    <ul class="search_results_subjects">
      <li>
        <a href="/movie/subject/1292052/">
          <div class="subject-info">
            <span class="subject-title">肖申克的救赎</span>
            <p class="rating">
              <span class="rating-stars" data-rating="97.0"></span>
              <span>9.7</span>
            </p>
          </div>
        </a>
      </li>
    </ul>
  `;
  const parsed = parseMobileSearchHtml(html);
  assert.deepEqual(parsed, { doubanId: "1292052", rating: 9.7 });
});

test("parseMobileSearchHtml preserves doubanId and sets rating to null when unrated", () => {
  const html = `
    <ul class="search_results_subjects">
      <li>
        <a href="/movie/subject/30211998/">
          <div class="subject-info">
            <span class="subject-title">未上映影片</span>
            <p class="rating">暂无评分</p>
          </div>
        </a>
      </li>
    </ul>
  `;
  const parsed = parseMobileSearchHtml(html);
  assert.deepEqual(parsed, { doubanId: "30211998", rating: null });
});

test("parseDesktopSearchHtml extracts sid and rating_nums from desktop search HTML", () => {
  const html = `
    <div class="title">
      <h3>
        <a href="https://www.douban.com/link2/?url=https%3A%2F%2Fmovie.douban.com%2Fsubject%2F2373195%2F" onclick="moreurl(this,{i: '0', query: 'tt0903747', sid: 2373195, qcat: '1002'})">绝命毒师</a>
      </h3>
      <div class="rating-info">
        <span class="allstar45"></span>
        <span class="rating_nums">9.2</span>
      </div>
    </div>
  `;
  const parsed = parseDesktopSearchHtml(html);
  assert.deepEqual(parsed, { doubanId: "2373195", rating: 9.2 });
});
