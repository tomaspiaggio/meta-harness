import assert from "node:assert/strict";
import { test } from "node:test";
import { fallbackSessionTitle } from "./titles";

test("offline titles extract useful topic words instead of preserving conversational boilerplate", () => {
  const title = fallbackSessionTitle(
    "i want to configure a schedule every weekday to review my CRM and calendar. Check the CRM and review the calendar every weekday.",
  );
  assert.doesNotMatch(title, /i want|configure|every/i);
  assert.match(title, /CRM|calendar|schedule|weekday/);
  assert.ok(title.length <= 45);
  assert.ok(title.split(" ").length <= 4);
  assert.equal(fallbackSessionTitle("please help me"), "New conversation");
  assert.ok(
    fallbackSessionTitle(
      "pneumonoultramicroscopicsilicovolcanoconiosis ".repeat(100),
    ).length <= 45,
  );
});
