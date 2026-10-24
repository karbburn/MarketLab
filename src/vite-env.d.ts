/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional override for the market-data service base URL. */
  readonly VITE_MARKET_DATA_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
