import {createLocaleOnDemandLoader, normalizeLocale, TITAN_LOCALE_LOADER_SCHEMA} from '../../performance/locale-on-demand-loader.mjs';

export const COMPAT_TRANSLATION_CHUNK_SCHEMA='titan.zero.compat-translation-chunk.v1';

export function createCompatTranslationChunk(options={}){
  const loader=createLocaleOnDemandLoader(options);
  return Object.freeze({
    schema:COMPAT_TRANSLATION_CHUNK_SCHEMA,
    locale_loader_schema:TITAN_LOCALE_LOADER_SCHEMA,
    normalizeLocale,
    resolve:loader.resolve,
    load:loader.load,
    isLoaded:loader.isLoaded,
    clear:loader.clear,
    loadedLocales:loader.loadedLocales,
    authority_neutral:true,
    identity_confers_authority:false,
    loading_confers_authority:false
  });
}
