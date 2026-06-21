import fs from 'node:fs';

import initSqlJs from 'sql.js';

import { createOcgcoreWrapper } from '../src/create-ocgcore-wrapper';
import { playYrp } from '../src/play-yrp';
import { DirScriptReaderEx } from '../src/script-reader';
import { DirCardReader } from '../src/card-reader';
import {
  requireTestReplayPath,
  requireYgoproDir,
} from './helpers/ygopro-resources';

describe('dir readers', () => {
  jest.setTimeout(60000);

  test('plays a replay using DirScriptReaderEx + DirCardReader', async () => {
    const baseDir = requireYgoproDir();
    const yrpPath = requireTestReplayPath();

    const wrapper = await createOcgcoreWrapper();
    try {
      wrapper.setScriptReader(await DirScriptReaderEx(baseDir), true);

      const SQL = await initSqlJs();
      wrapper.setCardReader(await DirCardReader(SQL, baseDir), true);

      const yrpBytes = fs.readFileSync(yrpPath);
      const messages = playYrp(wrapper, yrpBytes);
      expect(messages.length).toBeGreaterThan(0);
    } finally {
      wrapper.finalize();
    }
  });
});
