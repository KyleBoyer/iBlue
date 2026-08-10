import assert from "node:assert/strict";
import test from "node:test";

import {
  encodePollVote,
  pollFromBalloon,
  pollVoteUpdateFromBalloon,
} from "../../src/bluebubbles/polls.js";

function pollUrl(item: unknown, source: string): string {
  const encoded = Buffer.from(JSON.stringify({ version: 1, item }), "utf8").toString("base64");
  return `data:,${encoded}?src=${source}&c=1`;
}

test("decodes Apple Polls definitions from app balloon URLs", () => {
  const poll = pollFromBalloon({
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls",
    sessionId: "poll-session",
    isLive: true,
    url: pollUrl({
      creatorHandle: "+15551234567",
      title: "Lunch?",
      orderedPollOptions: [{
        optionIdentifier: "OPTION-1",
        creatorHandle: "+15551234567",
        attributedText: "Tacos",
        text: "Tacos",
        canBeEdited: false,
      }],
    }, "p"),
  });

  assert.deepEqual(poll, {
    version: 1,
    title: "Lunch?",
    creatorHandle: "+15551234567",
    options: [{
      identifier: "OPTION-1",
      text: "Tacos",
      creatorHandle: "+15551234567",
      canBeEdited: false,
    }],
    votes: [],
    sessionId: "poll-session",
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls",
  });
});

test("decodes Apple Polls vote acknowledgements", () => {
  const update = pollVoteUpdateFromBalloon({
    bundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls",
    isLive: true,
    url: pollUrl({
      votes: [{
        voteOptionIdentifier: "OPTION-2",
        participantHandle: "mailto:participant@example.com",
        serverVoteTime: 1234.5,
      }],
    }, "").replace(/\?.*$/, ""),
  });

  assert.deepEqual(update?.votes, [{
    optionIdentifier: "OPTION-2",
    participantHandle: "mailto:participant@example.com",
    serverVoteTime: 1234.5,
  }]);
});

test("encodes a complete Apple Polls selection set", () => {
  const encoded = encodePollVote(
    "cba9de14-dd9a-45c5-bb63-989e6e32c538",
    "jade@example.com",
    ["OPTION-2", "OPTION-2", "OPTION-5"],
  );
  assert.equal(encoded.balloon.isLive, false);
  assert.equal(encoded.balloon.sessionId, "cba9de14-dd9a-45c5-bb63-989e6e32c538");
  assert.deepEqual(JSON.parse(encoded.json), {
    item: {
      votes: [
        { voteOptionIdentifier: "OPTION-2", participantHandle: "jade@example.com" },
        { voteOptionIdentifier: "OPTION-5", participantHandle: "jade@example.com" },
      ],
    },
    version: 1,
  });
  assert.deepEqual(pollVoteUpdateFromBalloon(encoded.balloon)?.votes, encoded.update.votes);
});

test("ignores malformed or non-Polls balloon payloads", () => {
  assert.equal(pollFromBalloon({ bundleId: "com.apple.Maps", isLive: false, url: "data:,e30=" }), undefined);
  assert.equal(pollVoteUpdateFromBalloon({
    bundleId: "com.apple.messages.Polls",
    isLive: true,
    url: "data:,not-base64?src=v",
  }), undefined);
});
