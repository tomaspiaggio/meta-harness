import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIEFS_WORKSPACE,
  dayBounds,
  localTime,
  parseBrief,
  previousDay,
} from "@harness/core/briefs";
import { HarnessStore } from "./application";

test("local days follow the owner's time zone, including daylight-saving changes", () => {
  const la = dayBounds("2026-10-26", "America/Los_Angeles");
  assert.equal(new Date(la.start).toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(la.end - la.start, 24 * 3600 * 1000);
  // Clocks go back on 2026-11-01 in Los Angeles: a 25-hour day.
  const fallBack = dayBounds("2026-11-01", "America/Los_Angeles");
  assert.equal(fallBack.end - fallBack.start, 25 * 3600 * 1000);
  assert.deepEqual(localTime(la.start, "America/Los_Angeles"), {
    day: "2026-10-26",
    hour: 0,
  });
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.throws(() => dayBounds("26-10-2026", "UTC"), /Use a day/);
  assert.throws(
    () =>
      parseBrief({
        day: "2026-10-26",
        workspace_id: "tech",
        title: "T",
        highlights: [],
        html: "<p>x</p>",
      }),
    /1–6 highlights/,
  );
});

test("a day's activity and digest, publishing, the latest per workspace and deletion", async () => {
  process.env.HARNESS_TIMEZONE = "UTC";
  const store = new HarnessStore(":memory:");
  try {
    await store.ready;
    const day = "2026-10-26";
    const { start } = dayBounds(day, "UTC");
    const session = await store.createSession("tech", "Chip work", "codex");
    const db = store.databaseConnection();
    const turn = async (id: string, at: number, status = "completed") => {
      await store.createTurn(id, session.id, `Prompt ${id}`);
      await db
        .prepare(
          "UPDATE turns SET status = ?, createdAt = ?, output = ? WHERE id = ?",
        )
        .run(status, at, `Merged the clock fix in ${id}.`, id);
    };
    await turn("before", start - 1000);
    await turn("done", start + 3600_000);
    await turn("failed", start + 7200_000, "failed");
    assert.deepEqual(await store.briefActivity(day), [
      { workspaceId: "tech", name: "Tech", turns: 1 },
    ]);
    assert.deepEqual(await store.briefActivity("2026-10-27"), []);
    const digest = await store.briefDigest(day);
    assert.match(digest, /workspace_id tech/);
    assert.match(digest, /Session "Chip work" \(session_id/);
    assert.match(digest, /Merged the clock fix in done/);
    assert.doesNotMatch(digest, /in before|in failed/);

    const writer = await store.briefSession();
    assert.equal(writer.workspaceId, BRIEFS_WORKSPACE);
    assert.equal((await store.briefSession()).id, writer.id);
    assert.equal((await store.getSession(writer.id)).title, "Daily briefs");
    // The briefs workspace never briefs itself.
    await store.createTurn("writer", writer.id, "Write");
    await db
      .prepare(
        "UPDATE turns SET status = 'completed', createdAt = ? WHERE id = 'writer'",
      )
      .run(start + 10);
    assert.equal((await store.briefActivity(day)).length, 1);
    await assert.rejects(
      store.publishBrief(
        parseBrief({
          day,
          workspace_id: BRIEFS_WORKSPACE,
          title: "No",
          highlights: ["x"],
          html: "<p>x</p>",
        }),
        null,
      ),
      /other workspaces/,
    );

    assert.equal(await store.claimBriefRun(day, 1), true);
    assert.equal(await store.claimBriefRun(day, 1), false);
    const first = await store.publishBrief(
      parseBrief({
        day,
        workspace_id: "tech",
        title: "Clock fix merged",
        highlights: ["Merged the clock fix"],
        html: "<article class='brief'><h1>Clock</h1></article>",
        sources: [{ session_id: session.id }],
      }),
      "done",
    );
    const replaced = await store.publishBrief(
      parseBrief({
        day,
        workspace_id: "tech",
        title: "Clock fix merged and verified",
        highlights: ["Merged", "Verified on the Mac"],
        html: "<p>v2</p>",
      }),
      "done",
    );
    assert.equal(replaced.id, first.id, "one brief per workspace and day");
    await store.publishBrief(
      parseBrief({
        day: "2026-10-25",
        workspace_id: "tech",
        title: "Older",
        highlights: ["Older work"],
        html: "<p>old</p>",
      }),
      null,
    );
    assert.deepEqual(
      (await store.listBriefs()).map((brief) => brief.title),
      ["Clock fix merged and verified"],
    );
    assert.deepEqual(await store.briefDays(), [
      { day: "2026-10-26", count: 1 },
      { day: "2026-10-25", count: 1 },
    ]);
    assert.equal((await store.getBrief(first.id)).html, "<p>v2</p>");
    assert.match(
      await store.briefDigest("2026-10-26"),
      /Previous brief \(2026-10-25\): Older/,
    );

    // Briefs outlive the session that wrote them, but go with their workspace.
    await store.deleteSession(session.id);
    assert.equal((await store.getBrief(first.id)).turnId, null);
    await store.deleteWorkspace("tech");
    assert.deepEqual(await store.briefDays(), []);
  } finally {
    delete process.env.HARNESS_TIMEZONE;
    await store.close();
  }
});
