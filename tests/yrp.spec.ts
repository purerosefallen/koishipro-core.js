import fs from 'node:fs';

import initSqlJs from 'sql.js';
import { YGOProMsgNewTurn } from 'ygopro-msg-encode';

import { createOcgcoreWrapper } from '../src/create-ocgcore-wrapper';
import { playYrpStep } from '../src/play-yrp';
import { DirScriptReader } from '../src/script-reader';
import { SqljsCardReader } from '../src/card-reader';
import { OcgcoreCommonConstants, OcgcoreScriptConstants } from '../src/vendor';
import { getReplayFixturePaths } from './helpers/ygopro-resources';

describe('playYrp', () => {
  jest.setTimeout(60000);

  test('plays a yrp replay step by step and queries game state', async () => {
    const { scriptDir, cardsPath, yrpPath } = getReplayFixturePaths();

    const wrapper = await createOcgcoreWrapper();

    try {
      wrapper.setScriptReader(DirScriptReader(scriptDir));

      const SQL = await initSqlJs();
      const db = new SQL.Database(fs.readFileSync(cardsPath));
      wrapper.setCardReader(SqljsCardReader(db));

      wrapper.setMessageHandler((_duel, message, type) => {
        throw new Error(`MessageHandler invoked (${type}): ${message}`);
      });

      const yrpBytes = fs.readFileSync(yrpPath);
      let newTurnCount = 0;
      let stepCount = 0;
      const queryFlags =
        OcgcoreCommonConstants.QUERY_CODE |
        OcgcoreCommonConstants.QUERY_POSITION |
        OcgcoreCommonConstants.QUERY_LEVEL |
        OcgcoreCommonConstants.QUERY_ATTACK |
        OcgcoreCommonConstants.QUERY_DEFENSE;

      for (const { duel, result } of playYrpStep(wrapper, yrpBytes)) {
        stepCount++;

        // Count MSG_NEW_TURN messages using parsed message
        if (result.message instanceof YGOProMsgNewTurn) {
          newTurnCount++;
        }

        // Test query methods every 10 steps
        if (true) {
          // Query field info
          const fieldInfo = duel.queryFieldInfo();
          expect(fieldInfo.field).toBeDefined();
          expect(fieldInfo.field.players).toHaveLength(2);

          // Query each player's monsters
          for (let player = 0; player < 2; player++) {
            const mzoneCards = duel.queryFieldCard({
              player,
              location: OcgcoreScriptConstants.LOCATION_MZONE,
              queryFlag: queryFlags,
            });
            expect(mzoneCards.cards).toBeDefined();
            expect(Array.isArray(mzoneCards.cards)).toBe(true);

            // If there are cards in mzone, query individual cards
            if (mzoneCards.cards.length > 0) {
              for (let seq = 0; seq < mzoneCards.cards.length; seq++) {
                const card = mzoneCards.cards[seq];
                if (card && !card.empty) {
                  const singleCard = duel.queryCard({
                    player,
                    location: OcgcoreScriptConstants.LOCATION_MZONE,
                    sequence: seq,
                    queryFlag: queryFlags,
                  });
                  expect(singleCard.card).toBeDefined();
                  if (singleCard.card) {
                    expect(singleCard.card.flags).toBeDefined();
                  }
                }
              }
            }

            // Query hand
            const handCards = duel.queryFieldCard({
              player,
              location: OcgcoreScriptConstants.LOCATION_HAND,
              queryFlag: queryFlags,
            });
            expect(handCards.cards).toBeDefined();

            // Query deck count
            const deckCount = duel.queryFieldCount({
              player,
              location: OcgcoreScriptConstants.LOCATION_DECK,
            });
            expect(typeof deckCount).toBe('number');
            expect(deckCount).toBeGreaterThanOrEqual(0);
          }
        }

        // Parse the message using YGOProMessages
        if (result.message) {
          expect(result.message).toBeDefined();
          expect(typeof result.message.toPayload).toBe('function');
        }
      }

      expect(stepCount).toBeGreaterThan(0);
      expect(newTurnCount).toBeGreaterThanOrEqual(2);
    } finally {
      wrapper.finalize();
    }
  });
});
