// The four starter packs that ship first (#362). Packs are data. Load them through
// load.ts, which validates them first.
import type { Pack } from '../pack.schema.ts';
import { cleaningPack } from './cleaning.ts';
import { handymanPack } from './handyman.ts';
import { poolPack } from './pool.ts';
import { gardenPack } from './garden.ts';

export const STARTER_PACKS: readonly Pack[] = [cleaningPack, handymanPack, poolPack, gardenPack];
