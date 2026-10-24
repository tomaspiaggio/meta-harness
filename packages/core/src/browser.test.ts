import assert from "node:assert/strict";
import { test } from "node:test";
import { browserActivityLabel, browserLoginState } from "./browser";

test("known login walls cannot be mistaken for successful business reads", () => {
  assert.equal(
    browserLoginState("https://accounts.google.com/v3/signin/rejected"),
    "rejected",
  );
  assert.equal(
    browserLoginState("https://accounts.google.com/v3/signin/identifier"),
    "required",
  );
  assert.equal(
    browserLoginState("https://www.linkedin.com/checkpoint/challenge"),
    "required",
  );
  assert.equal(
    browserLoginState("https://docs.google.com/spreadsheets/d/fixture"),
    null,
  );
  assert.equal(
    browserLoginState("https://accounts.google.com.attacker.test/"),
    null,
  );
  assert.equal(browserLoginState("https://notlinkedin.com/login"), null);
});
test("browser activity uses readable action names and short service names", () => {
  assert.equal(
    browserActivityLabel(
      "sheet_read",
      "https://docs.google.com/a/very/long/path",
    ),
    "Read spreadsheet cells",
  );
  assert.equal(
    browserActivityLabel(
      "navigate",
      "https://calendar.google.com/calendar/u/0/r",
    ),
    "Opened Google Calendar",
  );
  assert.equal(browserActivityLabel("screenshot", ""), "Captured screenshot");
  assert.equal(browserActivityLabel("click", ""), "Clicked an element");
});
