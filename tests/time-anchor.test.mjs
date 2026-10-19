import assert from "node:assert/strict";
import test from "node:test";
import { mentionSpans, parseTimeAnchor, recordInWindow, relativeDateNotes, withoutTimeAnchor } from "../dist/retrieval/time-anchor.js";

// Local calendar days: build "now" from local components so the test holds in any TZ.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const day = (time) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const span = (anchor) => anchor ? `${day(anchor.from)}..${day(anchor.to)}` : undefined;
const SATURDAY = at(2023, 3, 25); // 2023-03-25 is a Saturday

test("time anchor: N units ago becomes a window around the date, wider for larger units", () => {
  assert.equal(span(parseTimeAnchor("What kitchen appliance did I buy 10 days ago?", SATURDAY)), "2023-03-12..2023-03-19");
  assert.equal(span(parseTimeAnchor("What did I do two weeks ago?", SATURDAY)), "2023-03-07..2023-03-16");
  assert.equal(span(parseTimeAnchor("a couple of days ago I said", SATURDAY)), "2023-03-22..2023-03-25");
  assert.equal(span(parseTimeAnchor("two months ago", SATURDAY)), "2023-01-11..2023-02-07");
  assert.equal(parseTimeAnchor("What kitchen appliance did I buy 10 days ago?", SATURDAY).phrase, "10 days ago");
});

test("time anchor: yesterday, last weekday, last weekend, last week and last month", () => {
  assert.equal(span(parseTimeAnchor("what did I say yesterday", SATURDAY)), "2023-03-23..2023-03-25");
  // On a Saturday, "last Saturday" is a week earlier, never today.
  assert.equal(span(parseTimeAnchor("Who gave me jewelry last Saturday?", SATURDAY)), "2023-03-17..2023-03-20");
  assert.equal(span(parseTimeAnchor("what did we discuss last weekend", at(2023, 3, 21))), "2023-03-17..2023-03-21");
  assert.equal(span(parseTimeAnchor("last week", at(2023, 4, 10))), "2023-04-02..2023-04-11");
  assert.equal(span(parseTimeAnchor("the budget from last month", SATURDAY)), "2023-01-29..2023-03-04");
});

test("time anchor: Chinese relative dates", () => {
  assert.equal(span(parseTimeAnchor("三天前我说的那家餐厅", SATURDAY)), "2023-03-21..2023-03-24");
  assert.equal(span(parseTimeAnchor("上周六我买了什么", SATURDAY)), "2023-03-17..2023-03-20");
  assert.equal(span(parseTimeAnchor("两周前的会议", SATURDAY)), "2023-03-07..2023-03-16");
  assert.equal(span(parseTimeAnchor("昨天提到的书", SATURDAY)), "2023-03-23..2023-03-25");
  assert.equal(span(parseTimeAnchor("上个月的预算", SATURDAY)), "2023-01-29..2023-03-04");
});

test("time anchor: questions about elapsed time and plain prompts have no anchor", () => {
  assert.equal(parseTimeAnchor("How many days ago did I attend the baking class?", SATURDAY), undefined);
  assert.equal(parseTimeAnchor("How many weeks have passed since I started?", SATURDAY), undefined);
  assert.equal(parseTimeAnchor("Recommend a hiking trail", SATURDAY), undefined);
  assert.equal(parseTimeAnchor("", SATURDAY), undefined);
  assert.equal(parseTimeAnchor("200 days ago", SATURDAY), undefined);
});

test("time anchor: the phrase is removed from the topical query", () => {
  const query = "What kitchen appliance did I buy 10 days ago?";
  assert.equal(withoutTimeAnchor(query, parseTimeAnchor(query, SATURDAY)), "What kitchen appliance did I buy ?");
  assert.equal(withoutTimeAnchor(query, undefined), query);
});

test("relative date notes resolve point dates against the recording time", () => {
  const recorded = at(2023, 5, 25); // Thursday
  assert.deepEqual(relativeDateNotes("I got a smoker three weeks ago and used it yesterday.", recorded), ["three weeks ago≈2023-05-04", "yesterday≈2023-05-24"]);
  assert.deepEqual(relativeDateNotes("We met last Thursday, back in 2 months ago? no: in 3 days", recorded), ["last Thursday≈2023-05-18", "2 months ago≈2023-03-25", "in 3 days≈2023-05-28"]);
  assert.deepEqual(relativeDateNotes("我上周三去了，两天前又去，明天再去", recorded), ["上周三≈2023-05-17", "两天前≈2023-05-23", "明天≈2023-05-26"]);
});

test("relative date notes skip ambiguous and absent dates and stay bounded", () => {
  const recorded = at(2023, 5, 25);
  assert.deepEqual(relativeDateNotes("See you next Saturday or this Friday.", recorded), []);
  assert.deepEqual(relativeDateNotes("I lent them a few weeks ago, several days ago, in a few days.", recorded), []);
  assert.deepEqual(relativeDateNotes("No dates here.", recorded), []);
  assert.deepEqual(relativeDateNotes("yesterday", 0), []);
  assert.equal(relativeDateNotes("yesterday, 1 day ago, 2 days ago, 3 days ago, 4 days ago, 5 days ago", recorded).length, 4);
  assert.deepEqual(relativeDateNotes("Yesterday was fine, yesterday again", recorded), ["Yesterday≈2023-05-24"]);
});

test("event time: a record belongs to the window it was recorded in or the one it mentions", () => {
  const today = at(2023, 5, 24);
  const window = parseTimeAnchor("Which shoes did I clean last month?", today);
  // Recorded today, about last month: belongs to last month.
  assert.equal(recordInWindow(window, today, "I finally cleaned my white sneakers last month."), true);
  assert.equal(recordInWindow(window, today, "I cleaned my white sneakers today."), false);
  assert.equal(recordInWindow(window, at(2023, 4, 12), "I cleaned my sneakers."), true);
  assert.deepEqual(mentionSpans("two weeks ago and then last month, and 三天前", today).map(span => span.phrase).sort(), ["last month", "two weeks ago", "三天前"].sort());
  assert.deepEqual(mentionSpans("no dates", today), []);
  assert.deepEqual(mentionSpans("yesterday", 0), []);
});
