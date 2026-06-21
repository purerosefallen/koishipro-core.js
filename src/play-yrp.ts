import { YGOProYrp } from 'ygopro-yrp-encode';

import { OcgcoreDuel } from './ocgcore-duel';
import { OcgcoreWrapper } from './ocgcore-wrapper';
import { OcgcoreScriptConstants } from './vendor';
import { YGOProMsgRetry } from 'ygopro-msg-encode';

const { LOCATION_DECK, LOCATION_EXTRA, POS_FACEDOWN_DEFENSE } =
  OcgcoreScriptConstants;

function normalizeYrp(input: YGOProYrp | Uint8Array): YGOProYrp {
  if (input instanceof YGOProYrp) {
    return input;
  }
  return new YGOProYrp().fromYrp(input);
}

function loadDeck(
  duel: OcgcoreDuel,
  deck: { main?: number[]; extra?: number[] } | null,
  owner: number,
  player: number,
): void {
  if (!deck) return;
  for (const code of deck.main ?? []) {
    duel.newCard({
      code,
      owner,
      player,
      location: LOCATION_DECK,
      sequence: 0,
      position: POS_FACEDOWN_DEFENSE,
    });
  }
  for (const code of deck.extra ?? []) {
    duel.newCard({
      code,
      owner,
      player,
      location: LOCATION_EXTRA,
      sequence: 0,
      position: POS_FACEDOWN_DEFENSE,
    });
  }
}

function loadTagDeck(
  duel: OcgcoreDuel,
  deck: { main?: number[]; extra?: number[] } | null,
  owner: number,
): void {
  if (!deck) return;
  for (const code of deck.main ?? []) {
    duel.newTagCard({
      code,
      owner,
      location: LOCATION_DECK,
    });
  }
  for (const code of deck.extra ?? []) {
    duel.newTagCard({
      code,
      owner,
      location: LOCATION_EXTRA,
    });
  }
}

function setRegistryValue(duel: OcgcoreDuel, key: string, value: string): void {
  duel.setRegistryValue(key, value);
}

export function createDuelFromYrp(
  wrapper: OcgcoreWrapper,
  yrpInput: YGOProYrp | Uint8Array,
  createFlags = 0,
) {
  const yrp = normalizeYrp(yrpInput);
  const header = yrp.header;
  const seedSequence = header?.seedSequence ?? [];
  const duel =
    seedSequence.length > 0
      ? wrapper.createDuelV2(seedSequence, createFlags)
      : wrapper.createDuel(header?.seed ?? 0, createFlags);

  setRegistryValue(duel, 'duel_mode', yrp.isTag ? 'tag' : 'single');
  setRegistryValue(duel, 'start_lp', String(yrp.startLp));
  setRegistryValue(duel, 'start_hand', String(yrp.startHand));
  setRegistryValue(duel, 'draw_count', String(yrp.drawCount));

  const playerNames = yrp.isTag
    ? [
        yrp.hostName,
        yrp.tagHostName ?? '',
        yrp.tagClientName ?? '',
        yrp.clientName,
      ]
    : [yrp.hostName, yrp.clientName];
  for (let i = 0; i < playerNames.length; i++) {
    setRegistryValue(duel, `player_name_${i}`, playerNames[i] ?? '');
  }
  setRegistryValue(duel, 'player_type_0', '0');
  setRegistryValue(duel, 'player_type_1', '1');

  duel.setPlayerInfo({
    player: 0,
    lp: yrp.startLp,
    startHand: yrp.startHand,
    drawCount: yrp.drawCount,
  });
  duel.setPlayerInfo({
    player: 1,
    lp: yrp.startLp,
    startHand: yrp.startHand,
    drawCount: yrp.drawCount,
  });

  duel.preloadScript('./script/patches/entry.lua');
  duel.preloadScript('./script/special.lua');
  duel.preloadScript('./script/init.lua');

  if (yrp.isSingleMode && yrp.singleScript) {
    duel.preloadScript(`./single/${yrp.singleScript}`);
  } else if (yrp.isTag) {
    loadDeck(duel, yrp.hostDeck, 0, 0);
    loadTagDeck(duel, yrp.tagHostDeck, 0);
    loadDeck(duel, yrp.clientDeck, 1, 1);
    loadTagDeck(duel, yrp.tagClientDeck, 1);
  } else {
    loadDeck(duel, yrp.hostDeck, 0, 0);
    loadDeck(duel, yrp.clientDeck, 1, 1);
  }

  duel.startDuel(yrp.opt >>> 0);
  return { yrp, duel };
}

export function* playYrpStep(
  ocgcoreWrapper: OcgcoreWrapper,
  yrpInput: YGOProYrp | Uint8Array,
) {
  const { yrp, duel } = createDuelFromYrp(ocgcoreWrapper, yrpInput);

  const responses = yrp.responses.slice();
  try {
    for (const result of duel.advance(() => responses.shift())) {
      yield {
        duel,
        result,
        responses,
      };
      if (result.message instanceof YGOProMsgRetry) {
        throw new Error('Got MSG_RETRY');
      }
    }
  } finally {
    duel.endDuel();
  }
}

export const playYrp = (
  ocgcoreWrapper: OcgcoreWrapper,
  yrpInput: YGOProYrp | Uint8Array,
) => {
  const results: Uint8Array[] = [];
  for (const result of playYrpStep(ocgcoreWrapper, yrpInput)) {
    results.push(result.result.raw);
  }
  return results;
};
