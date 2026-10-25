import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import { App } from './App';
import { StoreProvider } from './state/store';
import { LoadingGate } from './components/LoadingGate';
import { installDiagnostics } from './lib/diagnostics';

// Inert unless the page opted in before this module ran; see lib/diagnostics.ts.
installDiagnostics();

// One-way migration from legacy hash URLs (/#/route) to clean path URLs.
// The fragment is never sent to the server, so this must run in the client
// before React renders.
(function migrateLegacyHashUrl() {
  const hash = window.location.hash;
  if (!hash.startsWith('#/')) return;
  const pathAndQuery = hash.slice(1);
  const parts = pathAndQuery.split('#', 2);
  const pathQuery = parts[0] ?? '';
  const fragment = parts[1];
  const qparts = pathQuery.split('?', 2);
  const path = qparts[0] ?? '';
  const query = qparts[1];
  if (!path) return;
  if (path === window.location.pathname && !query && !fragment) return;
  const target = path + (query ? '?' + query : '') + (fragment ? '#' + fragment : '');
  if (target !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(null, '', target);
  }
})();

const container = document.getElementById('root');
if (!container) throw new Error('Root container is missing from index.html.');

createRoot(container).render(
  <StrictMode>
    <StoreProvider>
      <LoadingGate>
        <App />
      </LoadingGate>
    </StoreProvider>
  </StrictMode>,
);
